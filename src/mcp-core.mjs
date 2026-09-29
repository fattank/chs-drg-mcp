import { TOOLS } from "./tools.mjs";

export const SERVER_INFO = {
  name: "chs-drg-grouper",
  title: "CHS-DRG 2.0/3.0 分组服务",
  version: "1.0.0",
  websiteUrl: "http://47.109.152.150:4173"
};

const LATEST_PROTOCOL = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

const INSTRUCTIONS = [
  "本服务提供中国国家医保局 CHS-DRG 2.0 / 3.0 的病案分组能力。",
  "调用分组工具时，请提供病案首页编码：主要诊断编码必填；有手术时填主要手术或操作编码；涉及新生儿、CC/MCC、性别或年龄细分时，补充 sex、ageYears、ageDays、入院/出生体重等字段。",
  "返回 status 为 grouped 时 result.drg 才是确定结果；needs-data 需补充字段；invalid/ungrouped/review 请阅读 errors、needs、warnings。",
  "工具只返回分组结果与依据，不提供任何支付标准或费用结算金额。"
].join("\n");

export function toolsListing() {
  return TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
}

export function hasTool(name) {
  return TOOL_MAP.has(name);
}

async function callTool(name, args) {
  const tool = TOOL_MAP.get(name);
  const result = await tool.handler(args && typeof args === "object" ? args : {});
  const content = [{ type: "text", text: String(result.text ?? "") }];
  if (result.json !== undefined) {
    content.push({ type: "text", text: "```json\n" + JSON.stringify(result.json, null, 2) + "\n```" });
  }
  return { content, isError: false };
}

/**
 * 处理单条（或批量）JSON-RPC 消息。
 * 返回：响应对象 / 响应数组 / null（通知，无需响应）。
 */
export async function handleMessage(message) {
  if (Array.isArray(message)) {
    const responses = [];
    for (const item of message) {
      const response = await handleMessage(item);
      if (response) responses.push(response);
    }
    return responses.length ? responses : null;
  }

  if (!message || typeof message !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "无效的 JSON-RPC 消息" } };
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  const ok = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code, msg, data) =>
    isNotification ? null : { jsonrpc: "2.0", id, error: { code, message: msg, ...(data !== undefined ? { data } : {}) } };

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
      case "notifications/roots/list_changed":
        return null;
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: toolsListing() });
      case "tools/call": {
        const name = params?.name;
        if (!hasTool(name)) return fail(-32602, `未知工具：${name}`);
        try {
          return ok(await callTool(name, params?.arguments));
        } catch (error) {
          return ok({ content: [{ type: "text", text: `工具执行失败：${error.message}` }], isError: true });
        }
      }
      case "resources/list":
        return ok({ resources: [] });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      case "logging/setLevel":
        return ok({});
      default:
        return fail(-32601, `不支持的方法：${method}`);
    }
  } catch (error) {
    return fail(-32603, error.message);
  }
}
