import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "mcp-server.mjs");

// 一个最小 mock，替代远端分组服务，保证测试离线可跑。
function startMockUpstream() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method === "GET" && url.pathname === "/api/health") {
      return response.end(JSON.stringify({ ok: true, rules: 1, drgs: 1, versions: [{ version: "3.0", counts: { mdcs: 26, adrgs: 492, drgs: 825 }, ruleSet: { revision: "test" } }] }));
    }
    if (request.method === "GET" && url.pathname === "/api/meta") {
      return response.end(JSON.stringify({ version: "CHS-DRG 3.0", architecture: "A 型确定性规则链", counts: { drgs: 825 }, limitations: ["测试限制"] }));
    }
    if (request.method === "GET" && url.pathname === "/api/search") {
      return response.end(JSON.stringify({ items: [{ code: "E10.300x051+H42.0*", names: { "3.0": "青光眼" }, versions: ["3.0"] }] }));
    }
    if (request.method === "POST" && url.pathname === "/api/group") {
      return response.end(JSON.stringify({ version: "3.0", status: "grouped", result: { mdc: "MDCC", mdcName: "眼疾病", adrg: "CV1", adrgName: "青光眼", drg: "CV19", drgName: "青光眼", severity: { level: "NONE" } }, needs: [], errors: [], warnings: [], trace: [{ title: "唯一 DRG", status: "passed", detail: "CV19" }], ruleSet: { version: "3.0", revision: "test" } }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  return server;
}

async function startMcp(upstreamUrl) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MCP_PORT: "0", MCP_HOST: "127.0.0.1", DRG_API_BASE: upstreamUrl },
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
  assert.deepEqual(names, ["drg_compare_versions", "drg_group_batch", "drg_group_case", "drg_search_code", "drg_service_info"]);

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
