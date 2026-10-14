import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeRpc } from "../src/access-log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "mcp-server.mjs");

// 一个最小 mock，替代远端分组服务，保证测试离线可跑。
function startMockUpstream() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      return text ? JSON.parse(text) : {};
    };
    if (request.method === "GET" && url.pathname === "/api/health") {
      return response.end(JSON.stringify({ ok: true, rules: 1, drgs: 1, versions: [{ version: "3.0", counts: { mdcs: 26, adrgs: 492, drgs: 825 }, ruleSet: { revision: "test" } }] }));
    }
    if (request.method === "GET" && url.pathname === "/api/meta") {
      return response.end(JSON.stringify({ version: "CHS-DRG 3.0", architecture: "A 型确定性规则链", counts: { drgs: 825 }, limitations: ["测试限制"] }));
    }
    if (request.method === "GET" && url.pathname === "/api/mapping/meta") {
      return response.end(JSON.stringify({
        diagnosis: { kind: "diagnosis", label: "诊断", direction: "国临版2.0 → 医保版2.0", rows: 35587, grayRows: 2725, grayTargets: 2695, sha256: "diag" },
        procedure: { kind: "procedure", label: "手术操作", direction: "国临版3.0 → 医保版2.0", rows: 13653, grayRows: 2241, grayTargets: 2241, sha256: "proc" }
      }));
    }
    if (request.method === "GET" && url.pathname === "/api/mapping") {
      const kind = url.searchParams.get("kind") === "procedure" ? "procedure" : "diagnosis";
      const grayOnly = url.searchParams.get("gray") === "1";
      const all = [{ source: "A00.000", sourceName: "霍乱", target: "A00.000", targetName: "霍乱", changed: false, gray: true }];
      const items = grayOnly ? all.filter((item) => item.gray) : all;
      return response.end(JSON.stringify({ kind, total: items.length, page: 1, pageSize: 50, pages: 1, items }));
    }
    if (request.method === "GET" && url.pathname === "/api/search") {
      return response.end(JSON.stringify({ items: [{ code: "E10.300x051+H42.0*", names: { "3.0": "青光眼" }, versions: ["3.0"] }] }));
    }
    if (request.method === "POST" && url.pathname === "/api/group") {
      const body = await readBody();
      // 供「真实断连」测试使用：放慢响应，让客户端有机会中途断开。
      if (body.principalDiagnosis === "SLOW-CASE") await new Promise((resolve) => setTimeout(resolve, 700));
      const payload = { version: "3.0", status: "grouped", result: { mdc: "MDCC", mdcName: "眼疾病", adrg: "CV1", adrgName: "青光眼", drg: "CV19", drgName: "青光眼", severity: { level: "NONE" } }, needs: [], errors: [], warnings: [], trace: [{ title: "唯一 DRG", status: "passed", detail: "CV19" }], ruleSet: { version: "3.0", revision: "test" } };
      if (body.useMapping === true) {
        payload.mapping = { enabled: true, tables: [{ label: "诊断", sourceFile: "a.csv", direction: "国临版2.0 → 医保版2.0", sha256: "diag" }], changedCount: 1, grayCount: 1 };
        payload.mappingTrace = [{ kind: "diagnosis", label: "主要诊断", original: "A00.000", final: "A00.000", changed: false, gray: true, action: "mapped" }];
      }
      return response.end(JSON.stringify(payload));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  return server;
}

async function startMcp(upstreamUrl, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    // 默认不写访问日志，避免测试数据污染真实统计；需要验证日志时由调用方显式开启。
    env: { ...process.env, MCP_PORT: "0", MCP_HOST: "127.0.0.1", DRG_API_BASE: upstreamUrl, DRG_MCP_ACCESS_LOG: "off", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [chunk] = await once(child.stdout, "data");
  const text = chunk.toString();
  const match = text.match(/http:\/\/([^:]+):(\d+)/);
  return { child, port: Number(match[2]) };
}

async function rpc(port, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), json: text ? JSON.parse(text) : null };
}

test("MCP 连接器端到端：初始化、工具列表、工具调用", async (t) => {
  const upstream = startMockUpstream();
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const { child, port } = await startMcp(upstreamUrl);
  t.after(() => {
    child.kill();
    upstream.close();
  });

  const init = await rpc(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }
  });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.equal(init.json.result.serverInfo.name, "chs-drg-grouper");
  assert.ok(init.sessionId, "initialize 应返回 Mcp-Session-Id");

  const list = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const names = list.json.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["drg_compare_versions", "drg_group_batch", "drg_group_case", "drg_mapping_query", "drg_search_code", "drg_service_info"]);

  const call = await rpc(
    port,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "drg_group_case", arguments: { principalDiagnosis: "E10.300x051+H42.0*", ageYears: 75, sex: "F" } }
    },
    { "Mcp-Session-Id": init.sessionId }
  );
  assert.equal(call.json.result.isError, false);
  const text = call.json.result.content[0].text;
  assert.match(text, /已确定分组/);
  assert.match(text, /CV19/);

  // 启用映射：应转发 useMapping，并在文本与 JSON 中带出映射明细与医保灰码。
  const mapped = await rpc(
    port,
    {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "drg_group_case", arguments: { principalDiagnosis: "A00.000", useMapping: true } }
    },
    { "Mcp-Session-Id": init.sessionId }
  );
  const mappedText = mapped.json.result.content[0].text;
  assert.match(mappedText, /编码映射：已启用/);
  assert.match(mappedText, /医保灰码/);
  const mappedRaw = mapped.json.result.content[1].text;
  const mappedJson = JSON.parse(mappedRaw.slice(mappedRaw.indexOf("{"), mappedRaw.lastIndexOf("}") + 1));
  assert.equal(mappedJson.mapping?.enabled, true);
  assert.equal(mappedJson.mappingTrace?.[0]?.gray, true);

  // 映射查询工具：返回灰码标记。
  const mapping = await rpc(
    port,
    {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: { name: "drg_mapping_query", arguments: { kind: "diagnosis", grayOnly: true } }
    },
    { "Mcp-Session-Id": init.sessionId }
  );
  assert.match(mapping.json.result.content[0].text, /医保灰码/);

  const unknown = await rpc(port, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(unknown.json.error.code, -32602);

  const ping = await rpc(port, { jsonrpc: "2.0", id: 5, method: "ping", params: {} });
  assert.deepEqual(ping.json.result, {});

  const notification = await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification.status, 202);
});

test("传统 SSE 传输：endpoint 事件与消息回传", async (t) => {
  const upstream = startMockUpstream();
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const { child, port } = await startMcp(upstreamUrl);
  t.after(() => {
    child.kill();
    upstream.close();
  });

  const controller = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${port}/sse`, { signal: controller.signal });
  assert.equal(stream.status, 200);

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readUntil = async (needle) => {
    while (!buffer.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  };

  await readUntil("event: endpoint");
  const endpoint = buffer.match(/data: (\/messages\?sessionId=[^\n]+)/)[1];

  await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} })
  });

  await readUntil("drg_group_case");
  assert.match(buffer, /drg_group_case/);
  controller.abort();
});

// 回归测试：曾经 GET /mcp 打开服务端流会把会话里的 clientInfo 覆盖掉，导致平台归因退化成 unknown。
test("访问日志：开流后仍保留平台归因，只把 tools/call 记为调用，畸形 clientInfo 不报错", async (t) => {
  const upstream = startMockUpstream();
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "chs-drg-mcp-log-"));
  const { child, port } = await startMcp(upstreamUrl, { DRG_MCP_ACCESS_LOG: "on", DRG_MCP_ACCESS_LOG_DIR: logDir });
  t.after(() => {
    child.kill();
    upstream.close();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  const init = await rpc(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "WorkBuddy", version: "2.1.0" } }
  });
  assert.equal(init.status, 200);

  // 打开服务端 → 客户端 SSE 流，再断开。
  const controller = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "GET",
    headers: { Accept: "text/event-stream", "Mcp-Session-Id": init.sessionId },
    signal: controller.signal
  });
  assert.equal(stream.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.abort();
  try { await stream.text(); } catch { /* 主动断开 */ }
  await new Promise((resolve) => setTimeout(resolve, 120));

  // 开流之后再调用工具：平台归因不能丢。
  const call = await rpc(
    port,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "drg_group_case", arguments: { principalDiagnosis: "E10.300x051+H42.0*", ageYears: 75, sex: "F" } } },
    { "Mcp-Session-Id": init.sessionId }
  );
  assert.equal(call.status, 200);

  // 批量请求：一个 JSON-RPC 数组里两次 tools/call，都要计入。
  const batch = await rpc(
    port,
    [
      { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "drg_group_case", arguments: { principalDiagnosis: "A00.000", ageYears: 30, sex: "M" } } },
      { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "drg_group_case", arguments: { principalDiagnosis: "E10.300x051+H42.0*", ageYears: 75, sex: "F" } } }
    ],
    { "Mcp-Session-Id": init.sessionId }
  );
  assert.equal(batch.status, 200);
  assert.equal(Array.isArray(batch.json) ? batch.json.length : 1, 2, "批量应返回两条响应");

  // 调用不存在的工具：JSON-RPC 报错，HTTP 仍是 200，不能算作使用。
  const bad = await rpc(
    port,
    { jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    { "Mcp-Session-Id": init.sessionId }
  );
  assert.equal(bad.status, 200);
  assert.equal(bad.json.error.code, -32602);

  // 畸形 clientInfo.name 不能让服务 500。
  const weird = await rpc(port, {
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: { toString: null }, version: 1 } }
  });
  assert.equal(weird.status, 200, "畸形 clientInfo 不应导致 500");

  // /health 是探活请求，没有 JSON-RPC 结果；它必须照样留下记录（曾经因 outcome 为 undefined 而整条丢失）。
  await fetch(`http://127.0.0.1:${port}/health`);

  await new Promise((resolve) => setTimeout(resolve, 300));

  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const file = path.join(logDir, `access-${day}.jsonl`);
  assert.ok(fs.existsSync(file), "开启日志后应生成日志文件");
  const records = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

  assert.ok(records.every((record) => record.src === "connector"), "连接器日志的 src 必须是 connector");
  assert.ok(records.every((record) => !("params" in record) && !("body" in record)), "日志不能包含请求体");

  const session = records.filter((record) => record.session === init.sessionId);
  assert.ok(session.length >= 3, "该会话应留下 initialize、工具调用与批量记录");
  assert.deepEqual([...new Set(session.map((record) => record.channel))], ["workbuddy"], "开流后仍应归因到 workbuddy");

  const sum = (pick) => records.reduce((total, record) => total + pick(record), 0);
  // 1 次单条成功 + 批量 2 次成功 = 3 次成功；不存在的工具 = 1 次失败。
  assert.equal(sum((record) => record.callSuccesses || 0), 3, "批量里的两次调用必须都计入成功");
  assert.equal(sum((record) => record.callFailures || 0), 1, "未知工具应计入失败而不是成功");
  assert.equal(sum((record) => record.calls || 0), 4, "尝试次数 = 成功 3 + 失败 1");

  const batchRecord = records.find((record) => record.calls === 2);
  assert.ok(batchRecord, "批量请求应记成一条 calls=2 的记录");
  assert.equal(batchRecord.callSuccesses, 2);
  assert.equal(batchRecord.rpc, "tools/call");

  // 没有 JSON-RPC 结果的请求（/health）也必须留下记录。
  const probe = records.find((record) => record.path === "/health");
  assert.ok(probe, "/health 的探活记录不能因为缺少 outcome 而丢失");
  assert.equal(probe.channel, "probe");
  assert.equal(probe.calls, 0);
});

test("summarizeRpc：数字 id 与字符串 id 不会互相覆盖", () => {
  const message = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drg_group_case" } },
    { jsonrpc: "2.0", id: "1", method: "ping", params: {} }
  ];
  const result = [
    { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } },
    { jsonrpc: "2.0", id: "1", result: {} }
  ];
  const summary = summarizeRpc(message, result);
  assert.equal(summary.calls, 1);
  assert.equal(summary.callSuccesses, 1, "数字 id 的 tools/call 必须被正确识别");
  assert.equal(summary.callFailures, 0);
});

test("summarizeRpc：批量里成功、协议失败、工具失败分别计数", () => {
  const message = [
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    { jsonrpc: "2.0", id: 2, method: "tools/call" },
    { jsonrpc: "2.0", id: 3, method: "tools/call" }
  ];
  const result = [
    { jsonrpc: "2.0", id: 1, result: { content: [] } },
    { jsonrpc: "2.0", id: 2, error: { code: -32602, message: "未知工具" } },
    { jsonrpc: "2.0", id: 3, result: { content: [], isError: true } }
  ];
  const summary = summarizeRpc(message, result);
  assert.equal(summary.calls, 3);
  assert.equal(summary.callSuccesses, 1);
  assert.equal(summary.callFailures, 2);
});

test("summarizeRpc：没有响应时只计尝试次数", () => {
  const summary = summarizeRpc([{ jsonrpc: "2.0", id: 1, method: "tools/call" }], null);
  assert.equal(summary.rpc, "tools/call");
  assert.equal(summary.calls, 1);
  assert.equal(summary.callSuccesses, 0);
  assert.equal(summary.callFailures, 0);
});

// 回归测试：真实断连（不是构造 status=0 的日志）曾经整条漏记。
test("真实断连：尝试次数仍写入日志，并归入未送达", async (t) => {
  const upstream = startMockUpstream();
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "chs-drg-mcp-drop-"));
  const { child, port } = await startMcp(upstreamUrl, { DRG_MCP_ACCESS_LOG: "on", DRG_MCP_ACCESS_LOG_DIR: logDir });
  t.after(() => {
    child.kill();
    upstream.close();
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  const init = await rpc(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "WorkBuddy", version: "2.1.0" } }
  });
  assert.ok(init.sessionId);

  // 上游会慢 700ms，客户端在 150ms 时主动断开。
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "Mcp-Session-Id": init.sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "drg_group_case", arguments: { principalDiagnosis: "SLOW-CASE" } } }),
    signal: controller.signal
  }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort();
  await pending;
  // 等上游返回、连接器处理完这次被断开的请求。
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const file = path.join(logDir, `access-${day}.jsonl`);
  assert.ok(fs.existsSync(file), "断连请求也必须生成日志文件");
  const records = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

  const dropped = records.find((record) => record.session === init.sessionId && record.calls > 0);
  assert.ok(dropped, "断连的 tools/call 必须留下记录（尝试次数不能丢）");
  assert.equal(dropped.rpc, "tools/call");
  assert.equal(dropped.calls, 1, "尝试次数必须被登记");
  assert.equal(dropped.callSuccesses, 0, "断连不能算成功");
  assert.equal(dropped.callFailures, 0);
  assert.equal(dropped.status, 0, "断连记录的 status 应为 0");
});
