// MCP 连接器的访问日志（JSONL）。
//
// 为什么连接器也要记：分组服务只看到 127.0.0.1，真正调用 MCP 的人的 IP 和
// 平台名（MCP initialize 里的 clientInfo）只有连接器能看到。
//
// 只记录请求元数据，以及 JSON-RPC 的**方法名**（initialize / tools/call / tools/list …）
// 与调用成败计数（calls / callSuccesses / callFailures，批量请求逐条累计）。
// 不记录 params 与正文，因此不会落下任何病案内容。
// 日志仍保存原始 IP、UA、会话ID，属于个人信息，请按需保留与清理。
//
// 日志仅落本机，权限 0700/0600，未对外提供任何读取接口。
//
// 写入本身是异步的；只有在新建/重建日志文件时才做一次同步可写性探测，
// 且持续故障时按 DRG_ACCESS_LOG_RETRY_MS（默认 5000ms）限流，不会每个请求都探测。
//
// 环境变量：
//   DRG_MCP_ACCESS_LOG=off        关闭连接器日志（只关连接器）
//   DRG_ACCESS_LOG=off            关闭分组器与连接器日志；若同时显式设了
//                                 DRG_MCP_ACCESS_LOG，则以该独立开关为准
//   DRG_MCP_ACCESS_LOG_DIR=<dir>  日志目录（默认 <连接器>/logs）
//   DRG_MCP_ACCESS_LOG_TZ=Asia/Shanghai
//   DRG_ACCESS_SALT=<string>      访客ID哈希盐，默认写入 logs/.salt
//   DRG_ACCESS_LOG_RETRY_MS=5000  写入失败后的重试冷却时间
//   DRG_MCP_TRUST_PROXY=1         位于反向代理之后时才开启

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SOURCE = "connector";

function flag(value) {
  return value === "1" || value === "true" || value === "on";
}

// 连接器自己的开关优先；没设时跟随全局开关，这样 DRG_ACCESS_LOG=off 能一次全关。
export function loggingEnabled() {
  const specific = process.env.DRG_MCP_ACCESS_LOG;
  if (specific !== undefined && specific !== "") return specific !== "off";
  return process.env.DRG_ACCESS_LOG !== "off";
}

// 只接受原始类型，避免把对象/数组喂给 String() 时抛 "Cannot convert object to primitive value"。
export function safeText(value, maxLength = 300) {
  try {
    if (value === null || value === undefined) return "";
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean" && type !== "bigint") return "";
    return String(value).slice(0, maxLength);
  } catch {
    return "";
  }
}

// 从 initialize 的 params.clientInfo 里安全取出平台名，任何畸形输入都只得到空串，绝不抛异常。
export function readClientInfo(params) {
  try {
    if (!params || typeof params !== "object") return null;
    const info = params.clientInfo;
    if (!info || typeof info !== "object") return null;
    const name = safeText(info.name, 80);
    const version = safeText(info.version, 40);
    if (!name && !version) return null;
    return { name, version };
  } catch {
    return null;
  }
}

export function normalizeIp(raw) {
  let ip = safeText(raw, 128).trim();
  if (!ip) return "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1") ip = "127.0.0.1";
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  return ip.slice(0, 64);
}

export function clientIp(request, trustProxy) {
  const socketIp = normalizeIp(request.socket?.remoteAddress);
  if (!trustProxy) return socketIp;
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0];
  return normalizeIp(forwarded) || normalizeIp(request.headers["x-real-ip"]) || socketIp;
}

// 渠道归因：MCP 握手时客户端会自报 clientInfo.name。
// 这个映射是启发式的，可按实际情况直接改；原始 client 名同时记录在日志里，便于事后重新归类。
// /health 是平台的探活扫描，单独归为 probe，不计入 MCP 使用量。
export function classifyPlatform(clientName, userAgent, pathname = "") {
  if (pathname === "/health") return "probe";
  const text = `${safeText(clientName, 80)} ${safeText(userAgent, 300)}`;
  if (!text.trim()) return "unknown";
  if (/workbuddy|codebuddy|tencent|tencentcloud|腾讯|元宝|yuanbao/i.test(text)) return "workbuddy";
  if (/claude|cursor|vscode|windsurf|cline|continue|zed|mcp-remote|gemini|chatgpt|openai|trae|lingma|通义|qwen/i.test(text)) return "github";
  return "unknown";
}

// 只有真正的工具调用才算"使用"；握手、列工具、ping、断开都只是连接过程。
export function isUsage(method) {
  const name = safeText(method, 60);
  return name === "tools/call";
}

// 把一次 JSON-RPC 往返（含批量数组）归纳成可统计的口径：
//   calls         = 请求侧的 tools/call 尝试次数（批量里的每一条都算）
//   callSuccesses = 拿到成功响应的次数（既没有 error，也没有 result.isError）
//   callFailures  = 明确失败的次数（-32602 之类的协议错误，或 result.isError）
// 请求发出但没有对应响应（客户端提前断开等）时，只计入 calls，不算成功也不算失败。
//
// 注意：请求与响应按 id 的**原始类型**配对。JSON-RPC 允许数字 id 与字符串 id 共存，
// 同一批里 id:1 与 id:"1" 是两条不同的请求，用 String(id) 归一化会把它们错误合并。
export function summarizeRpc(message, result) {
  const requests = Array.isArray(message) ? message : [message];
  const methodById = new Map();
  const methods = [];
  let calls = 0;
  for (const item of requests) {
    if (!item || typeof item !== "object") continue;
    const method = safeText(item.method, 60);
    if (method) {
      methods.push(method);
      if (method === "tools/call") calls += 1;
    }
    if (item.id !== undefined && item.id !== null) methodById.set(item.id, method);
  }

  const responses = result === null || result === undefined ? [] : (Array.isArray(result) ? result : [result]);
  let callSuccesses = 0;
  let callFailures = 0;
  for (const response of responses) {
    if (!response || typeof response !== "object") continue;
    if (methodById.get(response.id) !== "tools/call") continue;
    const failed = Boolean(response.error) || Boolean(response.result && response.result.isError);
    if (failed) callFailures += 1;
    else callSuccesses += 1;
  }

  return { rpc: [...new Set(methods)].join(","), calls, callSuccesses, callFailures };
}

const EMPTY_OUTCOME = Object.freeze({ rpc: "", calls: 0, callSuccesses: 0, callFailures: 0 });

export function createAccessLogger({
  directory,
  enabled = loggingEnabled(),
  timeZone = process.env.DRG_MCP_ACCESS_LOG_TZ || process.env.DRG_ACCESS_LOG_TZ || "Asia/Shanghai",
  trustProxy = flag(process.env.DRG_MCP_TRUST_PROXY),
  salt = process.env.DRG_ACCESS_SALT || "",
  resolveClient = () => null,
  retryDelayMs = Number(process.env.DRG_MCP_ACCESS_LOG_RETRY_MS || process.env.DRG_ACCESS_LOG_RETRY_MS || 5000)
} = {}) {
  const counters = { written: 0, dropped: 0, failed: 0, reconnects: 0, probeFailures: 0 };
  if (!enabled || !directory) {
    return { enabled: false, attach() {}, noteAttempt() {}, noteOutcome() {}, close() {}, stats: () => ({ ...counters }) };
  }

  const dir = directory;
  const outcomeByRequest = new WeakMap();
  const retryCooldown = Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 5000;
  let blockedUntil = 0;
  let stream = null;
  let streamDay = "";
  let hadStream = false;
  let dayFormatter;
  let effectiveSalt = salt;

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } catch {
    return { enabled: false, attach() {}, noteAttempt() {}, noteOutcome() {}, close() {}, stats: () => ({ ...counters }) };
  }

  if (!effectiveSalt) {
    const saltFile = path.join(dir, ".salt");
    try {
      effectiveSalt = fs.readFileSync(saltFile, "utf8").trim();
    } catch {
      /* 首次运行 */
    }
    if (!effectiveSalt) {
      effectiveSalt = crypto.randomBytes(32).toString("hex");
      try {
        fs.writeFileSync(saltFile, effectiveSalt, { mode: 0o600 });
        fs.chmodSync(saltFile, 0o600);
      } catch {
        /* 无法持久化时仍可用 */
      }
    }
  }

  try {
    dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }

  function dayKey(date) {
    try {
      return dayFormatter.format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  function dropStream(target) {
    try { target?.destroy(); } catch { /* ignore */ }
    if (stream === target) {
      stream = null;
      streamDay = "";
    }
  }

  // 目标不可写时（同名目录占用、权限不足、磁盘满）先探一次，避免建了流又悄悄失败。
  function probeWritable(file) {
    let handle;
    try {
      handle = fs.openSync(file, "a", 0o600);
      return true;
    } catch {
      return false;
    } finally {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch { /* ignore */ }
      }
    }
  }

  function ensureStream(day) {
    if (stream && streamDay === day) return stream;
    if (stream) {
      const previous = stream;
      stream = null;
      streamDay = "";
      try { previous.end(); } catch { /* ignore */ }
    }
    const file = path.join(dir, `access-${day}.jsonl`);
    // 可写性探测是同步的，持续故障时不能每个请求都做一次，按冷却时间限流。
    const now = Date.now();
    if (now < blockedUntil) return null;
    // 探测失败不建流，冷却结束后重新尝试，故障排除后自动恢复。
    if (!probeWritable(file)) {
      counters.probeFailures += 1;
      blockedUntil = now + retryCooldown;
      return null;
    }
    blockedUntil = 0;
    if (hadStream) counters.reconnects += 1;
    hadStream = true;
    const next = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
    // 流中途出错（磁盘写满 ENOSPC 等）同样要进入冷却，否则每个请求都会重建流再失败一次。
    next.on("error", () => {
      counters.failed += 1;
      blockedUntil = Date.now() + retryCooldown;
      dropStream(next);
    });
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
    stream = next;
    streamDay = day;
    return stream;
  }

  function write(record) {
    try {
      const active = ensureStream(record.day);
      if (!active || active.destroyed || !active.writable) {
        counters.dropped += 1;
        dropStream(active);
        return;
      }
      if (active.writableLength > 1024 * 1024) {
        counters.dropped += 1;
        return;
      }
      active.write(`${JSON.stringify(record)}\n`);
      counters.written += 1;
    } catch {
      counters.dropped += 1;
    }
  }

  function sanitizeSummary(summary) {
    if (!summary || typeof summary !== "object") return null;
    return {
      rpc: safeText(summary.rpc, 120),
      calls: Number(summary.calls) || 0,
      callSuccesses: Number(summary.callSuccesses) || 0,
      callFailures: Number(summary.callFailures) || 0
    };
  }

  // 在真正执行工具之前调用：先登记尝试次数。这样客户端中途断开、
  // 来不及产出结果时，这条记录依然会写下来（归入"未送达"），而不是整条丢失。
  function noteAttempt(request, summary) {
    try {
      const clean = sanitizeSummary(summary);
      if (clean) outcomeByRequest.set(request, clean);
    } catch {
      /* ignore */
    }
  }

  // 拿到 JSON-RPC 结果后调用：合并成功/失败次数，保留已登记的尝试次数。
  function noteOutcome(request, summary) {
    try {
      const clean = sanitizeSummary(summary);
      if (!clean) return;
      const previous = outcomeByRequest.get(request);
      outcomeByRequest.set(request, {
        rpc: clean.rpc || previous?.rpc || "",
        calls: Math.max(clean.calls, previous?.calls || 0),
        callSuccesses: clean.callSuccesses,
        callFailures: clean.callFailures
      });
    } catch {
      /* ignore */
    }
  }

  function attach(request, response) {
    try {
      // CORS 预检没有信息量，不记。
      if (safeText(request.method, 10).toUpperCase() === "OPTIONS") return;
      const startedAt = process.hrtime.bigint();
      const rawUrl = safeText(request.url, 2048) || "/";
      const questionMark = rawUrl.indexOf("?");
      const pathname = questionMark === -1 ? rawUrl : rawUrl.slice(0, questionMark);
      const search = questionMark === -1 ? "" : rawUrl.slice(questionMark + 1);

      let done = false;
      const finish = (aborted) => {
        if (done) return;
        done = true;
        // finish/close 回调里的异常如果逸出，会变成进程级未捕获异常，因此整段兜住。
        try {
          let sessionId = "";
          try {
            sessionId = safeText(
              response.getHeader?.("mcp-session-id") ||
              request.headers["mcp-session-id"] ||
              new URLSearchParams(search).get("sessionId") ||
              "", 40);
          } catch {
            /* ignore */
          }
          let info = null;
          try {
            info = sessionId ? resolveClient(sessionId) : null;
          } catch {
            info = null;
          }
          const clientName = safeText(info?.name, 80);
          const clientVersion = safeText(info?.version, 40);
          const userAgent = safeText(request.headers["user-agent"], 300);
          const now = new Date();
          const day = dayKey(now);
          const ip = clientIp(request, trustProxy);
          // 没有 noteAttempt/noteOutcome 的请求（/health、404、静态探测等）要用默认值，
          // 否则读取 outcome.rpc 会抛异常，整条日志被丢掉。
          let outcome = EMPTY_OUTCOME;
          try {
            outcome = outcomeByRequest.get(request) || EMPTY_OUTCOME;
          } catch {
            outcome = EMPTY_OUTCOME;
          }
          write({
            ts: now.toISOString(),
            src: SOURCE,
            day,
            ip,
            vid: crypto.createHmac("sha256", effectiveSalt).update(`${day}|${ip}|${userAgent}`).digest("hex").slice(0, 16),
            method: safeText(request.method, 10) || "GET",
            path: pathname.slice(0, 300),
            status: aborted ? 0 : Number(response.statusCode) || 0,
            ms: Number((process.hrtime.bigint() - startedAt) / 1000000n),
            rpc: outcome.rpc,
            calls: outcome.calls,
            callSuccesses: outcome.callSuccesses,
            callFailures: outcome.callFailures,
            channel: classifyPlatform(clientName, userAgent, pathname),
            client: clientName,
            clientVersion,
            session: sessionId,
            ua: userAgent
          });
        } catch {
          counters.dropped += 1;
        }
      };

      response.on("finish", () => finish(false));
      response.on("close", () => finish(!response.writableFinished));
    } catch {
      /* ignore */
    }
  }

  function close() {
    const current = stream;
    stream = null;
    streamDay = "";
    try { current?.end(); } catch { /* ignore */ }
  }

  return { enabled: true, directory: dir, attach, noteAttempt, noteOutcome, close, stats: () => ({ ...counters }) };
}

export default createAccessLogger;
