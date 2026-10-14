// 只负责调用远端分组服务，不包含任何分组算法。
// 算法与规则数据全部留在服务器（默认 127.0.0.1:4173），本连接器仅做协议转换。

// 调用上游时带的来源标记，便于分组服务的访问日志区分是哪个连接器转发过来的。
// 不包含任何调用方隐私信息，只是连接器自身的名字。
const CLIENT_ID = process.env.DRG_CLIENT_ID || "chs-drg-mcp";

function base() {
  return (process.env.DRG_API_BASE || "http://127.0.0.1:4173").replace(/\/+$/, "");
}

function timeoutMs() {
  const value = Number(process.env.DRG_API_TIMEOUT_MS || 20000);
  return Number.isFinite(value) && value > 0 ? value : 20000;
}

export class DrgApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = "DrgApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function apiBase() {
  return base();
}

async function call(pathname, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(`${base()}${pathname}`, {
      method,
      headers: {
        "X-DRG-Client": CLIENT_ID,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new DrgApiError("分组服务返回了非 JSON 内容", response.status, text.slice(0, 500));
      }
    }
    if (!response.ok) {
      throw new DrgApiError(payload?.error || `分组服务返回 HTTP ${response.status}`, response.status, payload);
    }
    return payload;
  } catch (error) {
    if (error instanceof DrgApiError) throw error;
    if (error.name === "AbortError") throw new DrgApiError(`调用分组服务超时（>${timeoutMs()}ms）`);
    throw new DrgApiError(`无法连接分组服务 ${base()}：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export const groupCase = (payload) => call("/api/group", { method: "POST", body: payload });
export const compareCase = (payload) => call("/api/compare", { method: "POST", body: payload });
export const health = () => call("/api/health");
export const meta = () => call("/api/meta");
export const searchCode = (type, query, limit = 20) =>
  call(`/api/search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}`);
export const mappingMeta = () => call("/api/mapping/meta");
export const mappingQuery = ({ kind = "diagnosis", query = "", gray = false, page = 1, pageSize = 50 } = {}) => {
  const params = new URLSearchParams({
    kind: kind === "procedure" ? "procedure" : "diagnosis",
    page: String(Number.isFinite(Number(page)) && Number(page) > 0 ? Math.floor(Number(page)) : 1),
    pageSize: String(Math.min(200, Math.max(1, Number(pageSize) || 50)))
  });
  if (query) params.set("q", String(query).trim());
  if (gray) params.set("gray", "1");
  return call(`/api/mapping?${params.toString()}`);
};
