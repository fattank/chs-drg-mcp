// 只负责调用远端分组服务，不包含任何分组算法。
// 算法与规则数据全部留在服务器（默认 127.0.0.1:4173），本连接器仅做协议转换。

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
      headers: body ? { "Content-Type": "application/json" } : undefined,
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
