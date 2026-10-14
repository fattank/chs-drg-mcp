import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { handleMessage, toolsListing, SERVER_INFO } from "./src/mcp-core.mjs";
import { apiBase } from "./src/drg-client.mjs";
import { createAccessLogger, readClientInfo, summarizeRpc } from "./src/access-log.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MCP_PORT || process.env.PORT || 4174);
const HOST = process.env.MCP_HOST || process.env.HOST || "0.0.0.0";
const AUTH_TOKEN = process.env.DRG_MCP_AUTH_TOKEN || "";
const MAX_BODY = 1024 * 1024;
const sessions = new Map();
// 会话 -> 客户端平台名。刻意与 sessions 分开存放：GET /mcp 的连接断开时会删掉 sessions 里的
// 条目，如果平台名跟着一起删，这条会话的访问日志就会退化成 unknown。
const clientInfoBySession = new Map();
const CLIENT_INFO_LIMIT = 20000;

function rememberClient(sessionId, info) {
  if (!sessionId || !info) return;
  clientInfoBySession.set(sessionId, info);
  if (clientInfoBySession.size > CLIENT_INFO_LIMIT) {
    const oldest = clientInfoBySession.keys().next().value;
    clientInfoBySession.delete(oldest);
  }
}

// 连接器访问日志：只有这里能看到真实调用方 IP 与 MCP 客户端平台名。
// DRG_MCP_ACCESS_LOG=off 只关连接器；DRG_ACCESS_LOG=off 把分组器和连接器一起关掉。
const accessLog = createAccessLogger({
  directory: process.env.DRG_MCP_ACCESS_LOG_DIR || path.join(HERE, "logs"),
  resolveClient: (sessionId) => clientInfoBySession.get(sessionId) || null
});

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Accept, Last-Event-ID, MCP-Protocol-Version, X-MCP-Token"
  );
  response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function json(response, status, payload) {
  setCors(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function authorized(request) {
  if (!AUTH_TOKEN) return true;
  const header = request.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : String(request.headers["x-mcp-token"] || "").trim();
  return token === AUTH_TOKEN;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sseWrite(response, event, data) {
  response.write(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function parseJson(raw) {
  try {
    return { value: JSON.parse(raw || "{}") };
  } catch {
    return { error: true };
  }
}

function startSseStream(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  // 立刻把响应头发出去。否则要等到第一条数据（25 秒后的心跳）客户端才拿到响应头，
  // 打开 GET /mcp 的 MCP 客户端会白等甚至超时。
  try { response.flushHeaders(); } catch { /* 旧版本无此方法时忽略 */ }
  const ping = setInterval(() => {
    try {
      response.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 25000);
  if (typeof ping.unref === "function") ping.unref();
  return () => clearInterval(ping);
}

// ---------------------------------------------------------------------------
// 传输：Streamable HTTP (/mcp) + 传统 HTTP+SSE (/sse + /messages)
// ---------------------------------------------------------------------------
async function handleRequest(request, response) {
  // 入口即注册日志，异步落盘，不影响任何响应路径。
  accessLog.attach(request, response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;
  const method = request.method || "GET";

  if (method === "OPTIONS") {
    setCors(response);
    response.writeHead(204);
    return response.end();
  }

  // 连接器自身健康检查（不需要鉴权，便于探活）
  if (method === "GET" && pathname === "/health") {
    return json(response, 200, {
      ok: true,
      service: "chs-drg-workbuddy-mcp",
      version: SERVER_INFO.version,
      transports: ["/mcp (Streamable HTTP)", "/sse (HTTP+SSE)"],
      upstream: apiBase(),
      tools: toolsListing().map((tool) => tool.name)
    });
  }

  if (method === "GET" && (pathname === "/" || pathname === "/info")) {
    return json(response, 200, {
      name: SERVER_INFO.name,
      title: SERVER_INFO.title,
      version: SERVER_INFO.version,
      description: "CHS-DRG 2.0 / 3.0 分组 MCP 连接器",
      mcpEndpoint: "/mcp",
      sseEndpoint: "/sse",
      tools: toolsListing()
    });
  }

  if (!authorized(request)) {
    return json(response, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "缺少或错误的访问令牌" } });
  }

  // ---- Streamable HTTP ----
  if (pathname === "/mcp" || pathname === "/") {
    if (method === "GET") {
      // 可选的服务端→客户端 SSE 流
      const sessionId = request.headers["mcp-session-id"] || randomUUID();
      const stopPing = startSseStream(response);
      // 合并写入：同一会话先 initialize 再开服务端流时，不能把已记录的 clientInfo 覆盖掉。
      const existing = sessions.get(sessionId);
      sessions.set(sessionId, { ...existing, transport: "stream", response, createdAt: existing?.createdAt ?? Date.now() });
      const cleanup = () => {
        stopPing();
        sessions.delete(sessionId);
      };
      request.on("close", cleanup);
      response.on("error", cleanup);
      return;
    }
    if (method === "DELETE") {
      const sessionId = request.headers["mcp-session-id"];
      if (sessionId) {
        sessions.delete(sessionId);
        clientInfoBySession.delete(sessionId);
      }
      setCors(response);
      response.writeHead(204);
      return response.end();
    }
    if (method !== "POST") {
      return json(response, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "仅支持 GET / POST / DELETE" } });
    }

    const raw = await readBody(request);
    const parsed = parseJson(raw);
    if (parsed.error) {
      return json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    }
    const message = parsed.value;
    const messages = Array.isArray(message) ? message : [message];

    let sessionId = request.headers["mcp-session-id"];
    // 批量数组里也可能带 initialize。
    const initItem = messages.find((item) => item && typeof item === "object" && item.method === "initialize");
    if (initItem) {
      if (!sessionId || !sessions.has(sessionId)) {
        sessionId = randomUUID();
        sessions.set(sessionId, { transport: "http", createdAt: Date.now() });
      }
      // 记下客户端自报的平台名，供访问日志归因渠道（WorkBuddy / GitHub 等）。
      rememberClient(sessionId, readClientInfo(initItem.params));
    }

    // 先登记尝试次数：客户端中途断开、还没产出结果时，这条记录也要留下来（归入"未送达"）。
    accessLog.noteAttempt(request, summarizeRpc(message, null));
    const result = await handleMessage(message);
    // 再补上成功/失败计数：批量数组逐条累计，失败/未执行的调用单独计数。
    accessLog.noteOutcome(request, summarizeRpc(message, result));
    if (sessionId) response.setHeader("Mcp-Session-Id", sessionId);

    const accept = String(request.headers["accept"] || "");
    const wantsSse = accept.includes("text/event-stream") && !accept.includes("application/json");
    setCors(response);

    if (result === null) {
      response.writeHead(202);
      return response.end();
    }

    if (wantsSse) {
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" });
      const items = Array.isArray(result) ? result : [result];
      for (const item of items) sseWrite(response, "message", item);
      return response.end();
    }

    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return response.end(JSON.stringify(result));
  }

  // ---- 传统 HTTP + SSE ----
  if (pathname === "/sse" && method === "GET") {
    const sessionId = randomUUID();
    const stopPing = startSseStream(response);
    sessions.set(sessionId, { transport: "sse", response, createdAt: Date.now() });
    response.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    const cleanup = () => {
      stopPing();
      sessions.delete(sessionId);
    };
    request.on("close", cleanup);
    response.on("error", cleanup);
    return;
  }

  if (pathname === "/messages" && method === "POST") {
    const sessionId = url.searchParams.get("sessionId") || request.headers["mcp-session-id"];
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session || session.transport !== "sse") {
      return json(response, 404, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "会话不存在或已断开，请重新连接 /sse" }
      });
    }
    const raw = await readBody(request);
    const parsed = parseJson(raw);
    if (parsed.error) return json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    // SSE 通道下 initialize 走 /messages，同样记下客户端平台名。
    const sseMessage = parsed.value;
    const sseItems = Array.isArray(sseMessage) ? sseMessage : [sseMessage];
    const sseInit = sseItems.find((item) => item && typeof item === "object" && item.method === "initialize");
    if (sseInit) rememberClient(sessionId, readClientInfo(sseInit.params));
    // 先登记尝试次数，再执行；中途断开也不会丢记录。
    accessLog.noteAttempt(request, summarizeRpc(parsed.value, null));
    const result = await handleMessage(parsed.value);
    // 记方法名与调用成败，批量数组逐条累计。
    accessLog.noteOutcome(request, summarizeRpc(parsed.value, result));
    if (result !== null) {
      const items = Array.isArray(result) ? result : [result];
      for (const item of items) {
        try {
          sseWrite(session.response, "message", item);
        } catch {
          /* 连接可能已关闭 */
        }
      }
    }
    response.writeHead(202, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("Accepted");
  }

  return json(response, 404, { error: "接口不存在" });
}

const useTls = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, wrap)
  : http.createServer(wrap);

function wrap(request, response) {
  handleRequest(request, response).catch((error) => {
    if (!response.headersSent) {
      json(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message } });
    } else {
      try {
        response.end();
      } catch {
        /* ignore */
      }
    }
  });
}

server.listen(PORT, HOST, () => {
  const actualPort = server.address().port;
  const scheme = useTls ? "https" : "http";
  console.log(`CHS-DRG WorkBuddy MCP 连接器已启动：${scheme}://${HOST}:${actualPort}`);
  console.log(`  Streamable HTTP: ${scheme}://${HOST}:${actualPort}/mcp`);
  console.log(`  传统 SSE       : ${scheme}://${HOST}:${actualPort}/sse`);
  console.log(`  上游分组服务   : ${apiBase()}`);
  console.log(`  已加载工具     : ${toolsListing().map((tool) => tool.name).join(", ")}`);
  if (AUTH_TOKEN) console.log("  已启用 Bearer Token 鉴权");
  console.log(accessLog.enabled
    ? `  访问日志: ${accessLog.directory}（每天一个 access-YYYY-MM-DD.jsonl，仅本机可读）`
    : "  访问日志: 已关闭");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    accessLog.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
