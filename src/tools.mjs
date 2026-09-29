import * as drg from "./drg-client.mjs";

// ---------------------------------------------------------------------------
// 病例输入 schema：字段与远端 /api/group、/api/compare 的入参一致
// ---------------------------------------------------------------------------
const CASE_PROPERTIES = {
  caseId: { type: "string", description: "病案标识，可选，例如 2026-0001" },
  principalDiagnosis: { type: "string", description: "主要诊断编码（医保版 ICD-10），必填，例如 E10.300x051+H42.0*" },
  otherDiagnoses: {
    type: "array",
    items: { type: "string" },
    description: "其他诊断编码列表，例如 [\"I10.x00\",\"E11.900\"]"
  },
  principalProcedure: { type: "string", description: "主要手术或操作编码（医保版 ICD-9-CM-3），无手术可留空，例如 39.9500x007" },
  otherProcedures: {
    type: "array",
    items: { type: "string" },
    description: "其他手术或操作编码列表"
  },
  sex: { type: "string", enum: ["M", "F"], description: "性别：M=男，F=女" },
  ageYears: { type: "number", description: "年龄（周岁，整数）" },
  ageDays: { type: "integer", description: "天龄（新生儿，整数）" },
  birthWeightGrams: { type: "integer", description: "出生体重（克），CHS-DRG 2.0 早产儿分组使用" },
  admissionWeightGrams: { type: "integer", description: "入院体重（克），CHS-DRG 3.0 早产儿分组使用" },
  ventilationHours: { type: "number", description: "呼吸机使用时长（小时）" },
  dischargeDisposition: { type: "string", description: "离院方式，例如 医嘱离院、死亡" }
};

function caseSchema() {
  return { type: "object", properties: CASE_PROPERTIES, required: ["principalDiagnosis"] };
}

function toCodeList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value)
    .split(/[\s,，;；、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildPayload(args) {
  const payload = {};
  const put = (key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === "string" && value.trim() === "") return;
    payload[key] = value;
  };
  put("caseId", args.caseId && String(args.caseId).trim());
  put("principalDiagnosis", args.principalDiagnosis && String(args.principalDiagnosis).trim());
  put("principalProcedure", args.principalProcedure && String(args.principalProcedure).trim());
  const otherDiagnoses = toCodeList(args.otherDiagnoses);
  if (otherDiagnoses.length) payload.otherDiagnoses = otherDiagnoses;
  const otherProcedures = toCodeList(args.otherProcedures);
  if (otherProcedures.length) payload.otherProcedures = otherProcedures;
  put("sex", args.sex);
  put("ageYears", args.ageYears);
  put("ageDays", args.ageDays);
  put("birthWeightGrams", args.birthWeightGrams);
  put("admissionWeightGrams", args.admissionWeightGrams);
  put("ventilationHours", args.ventilationHours);
  put("dischargeDisposition", args.dischargeDisposition);
  return payload;
}

// ---------------------------------------------------------------------------
// 结果整理：只保留可对外展示的字段，隐藏远端规则哈希细节
// ---------------------------------------------------------------------------
const STATUS_LABELS = {
  grouped: "已确定分组",
  qy: "歧义组（QY，需权威口径）",
  review: "待核对",
  "needs-data": "需补充信息",
  invalid: "输入无效",
  ungrouped: "未入组",
  error: "服务异常"
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知";
}

function summarizeCase(version, r) {
  const lines = [`【CHS-DRG ${version}】${statusLabel(r.status)}`];
  const result = r.result;
  if (result) {
    if (result.mdc) lines.push(`  MDC：${result.mdc}${result.mdcName ? ` ${result.mdcName}` : ""}`);
    if (result.adrg) lines.push(`  ADRG：${result.adrg}${result.adrgName ? ` ${result.adrgName}` : ""}`);
    if (result.drg) lines.push(`  DRG：${result.drg}${result.drgName ? ` ${result.drgName}` : ""}`);
    if (result.severity?.level) lines.push(`  严重度：${result.severity.level}`);
    if (result.basicGroup) lines.push(`  基层病组：${result.basicGroup}`);
  }
  if (r.specialGroup) lines.push(`  特殊分组：${r.specialGroup}`);
  const provisional = r.provisionalResult;
  if (!result && provisional?.drg) lines.push(`  暂算 DRG：${provisional.drg}（未确认，仅供核对）`);
  if (r.qyCandidate) lines.push(`  歧义候选：${JSON.stringify(r.qyCandidate)}`);
  if (r.needs?.length) lines.push(`  待补充信息：${r.needs.join("、")}`);
  if (r.errors?.length) lines.push(`  错误：${r.errors.map((e) => e.message).join("；")}`);
  if (r.warnings?.length) lines.push(`  提示：${r.warnings.map((w) => w.message).join("；")}`);
  return lines.join("\n");
}

function publicResult(r) {
  if (!r) return null;
  return {
    version: r.version,
    status: r.status,
    statusLabel: statusLabel(r.status),
    result: r.result ?? null,
    provisionalResult: r.provisionalResult ?? null,
    qyCandidate: r.qyCandidate ?? null,
    specialGroup: r.specialGroup ?? null,
    needs: r.needs ?? [],
    errors: r.errors ?? [],
    warnings: r.warnings ?? [],
    trace: (r.trace || []).map(({ title, status, detail }) => ({ title, status, detail })),
    ruleSet: r.ruleSet
      ? { version: r.ruleSet.version, revision: r.ruleSet.revision, engineRevision: r.ruleSet.engineRevision, sha256: r.ruleSet.sha256 }
      : null
  };
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------
export const TOOLS = [
  {
    name: "drg_group_case",
    title: "CHS-DRG 3.0 单病例分组",
    description:
      "按国家医保局 CHS-DRG 3.0（A 型）规则对单个住院病案首页做确定性分组，返回 MDC、ADRG、DRG、严重度、分组状态与分组依据。",
    inputSchema: caseSchema(),
    async handler(args) {
      const data = await drg.groupCase(buildPayload(args));
      return { text: summarizeCase("3.0", data), json: publicResult(data) };
    }
  },
  {
    name: "drg_compare_versions",
    title: "CHS-DRG 2.0 / 3.0 双版本对照",
    description:
      "把同一份病案分别按 CHS-DRG 2.0 与 3.0 独立规则分组，输出两版结果与差异对照，便于观察付费版本升级带来的分组变化。",
    inputSchema: caseSchema(),
    async handler(args) {
      const data = await drg.compareCase(buildPayload(args));
      const text = [
        summarizeCase("2.0", data.v2),
        summarizeCase("3.0", data.v3),
        `【差异】${data.comparison?.summary ?? ""}`
      ].join("\n\n");
      return { text, json: { v2: publicResult(data.v2), v3: publicResult(data.v3), comparison: data.comparison ?? null } };
    }
  },
  {
    name: "drg_group_batch",
    title: "CHS-DRG 3.0 批量分组",
    description:
      "对最多 10 份病案批量执行 CHS-DRG 3.0 分组，返回每份病案的状态与 DRG，适合清单式核对。",
    inputSchema: {
      type: "object",
      properties: {
        cases: {
          type: "array",
          maxItems: 10,
          description: "病案列表，每项字段与 drg_group_case 相同（至少包含 principalDiagnosis）",
          items: caseSchema()
        }
      },
      required: ["cases"]
    },
    async handler(args) {
      const cases = Array.isArray(args.cases) ? args.cases.slice(0, 10) : [];
      if (!cases.length) throw new Error("cases 不能为空");
      const results = [];
      for (let index = 0; index < cases.length; index += 1) {
        try {
          const data = await drg.groupCase(buildPayload(cases[index] || {}));
          results.push({ index, status: data.status, statusLabel: statusLabel(data.status), drg: data.result?.drg ?? null, adrg: data.result?.adrg ?? null, mdc: data.result?.mdc ?? null, needs: data.needs ?? [], errors: (data.errors || []).map((e) => e.message) });
        } catch (error) {
          results.push({ index, status: "error", statusLabel: statusLabel("error"), errors: [error.message] });
        }
      }
      const grouped = results.filter((item) => item.status === "grouped").length;
      const text = [`共 ${results.length} 份，已确定分组 ${grouped} 份。`, ...results.map((item) => `#${item.index + 1} ${item.statusLabel}${item.adrg ? ` ${item.adrg}` : ""}${item.drg ? ` ${item.drg}` : ""}${item.errors?.length ? `（${item.errors.join("；")}）` : ""}`)].join("\n");
      return { text, json: { total: results.length, grouped, results } };
    }
  },
  {
    name: "drg_search_code",
    title: "诊断 / 手术编码检索",
    description: "在 CHS-DRG 2.0 / 3.0 数据表中按编码或名称关键词检索医保版诊断、手术操作编码。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "编码或名称关键词，例如 青光眼、E10.3、39.95" },
        type: { type: "string", enum: ["diagnosis", "procedure"], description: "检索类型：diagnosis 诊断（默认），procedure 手术操作" }
      },
      required: ["query"]
    },
    async handler(args) {
      const type = args.type === "procedure" ? "procedure" : "diagnosis";
      const data = await drg.searchCode(type, args.query);
      const items = data.items || [];
      const text = items.length
        ? items
            .map((item) => {
              const names = Object.values(item.names || {}).join(" / ");
              const versions = (item.versions || []).join("/");
              return `${item.code}  ${names}（${versions}）`;
            })
            .join("\n")
        : "未找到匹配编码。";
      return {
        text: `检索类型：${type === "procedure" ? "手术操作" : "诊断"}；命中 ${items.length} 条\n${text}`,
        json: { type, count: items.length, items }
      };
    }
  },
  {
    name: "drg_service_info",
    title: "分组服务与规则版本信息",
    description:
      "查询 DRG 分组服务运行状态、已加载的 2.0 / 3.0 规则版本、编码表规模与已知待核实口径，用于确认数据版本与合规边界。",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      const [health, meta] = await Promise.all([drg.health(), drg.meta()]);
      const text = [
        `服务状态：${health.ok ? "正常" : "异常"}`,
        ...(health.versions || []).map(
          (v) => `CHS-DRG ${v.version}：MDC ${v.counts.mdcs}、ADRG ${v.counts.adrgs}、DRG ${v.counts.drgs}，规则修订 ${v.ruleSet?.revision ?? "未标注"}`
        ),
        `分组架构：${meta.architecture}`,
        ...(meta.limitations?.length ? ["已知待核实项：", ...meta.limitations.map((item) => `- ${item}`)] : [])
      ].join("\n");
      return {
        text,
        json: {
          base: drg.apiBase(),
          health,
          meta: { version: meta.version, architecture: meta.architecture, counts: meta.counts, limitations: meta.limitations }
        }
      };
    }
  }
];
