# 工具参考

所有工具通过 MCP `tools/list` 暴露，通过 `tools/call` 调用。返回内容为 MCP `content` 文本块：先给可读摘要，再附结构化 JSON 代码块。

---

## `drg_group_case`

按 CHS-DRG 3.0（A 型）规则对单个住院病案首页做确定性分组。

**输入**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `principalDiagnosis` | string | ✅ | 主要诊断编码（医保版 ICD-10） |
| `otherDiagnoses` | string[] | | 其他诊断编码 |
| `principalProcedure` | string | | 主要手术或操作编码（医保版 ICD-9-CM-3） |
| `otherProcedures` | string[] | | 其他手术或操作编码 |
| `sex` | `M` / `F` | | 性别 |
| `ageYears` | number | | 周岁 |
| `ageDays` | integer | | 天龄（新生儿） |
| `birthWeightGrams` | integer | | 出生体重（克），2.0 早产儿分组使用 |
| `admissionWeightGrams` | integer | | 入院体重（克），3.0 早产儿分组使用 |
| `ventilationHours` | number | | 呼吸机使用时长（小时） |
| `dischargeDisposition` | string | | 离院方式 |
| `caseId` | string | | 病案标识 |

**返回**：`status`、`result`（`mdc`/`adrg`/`drg`/`severity`/`basicGroup`）、`needs`、`errors`、`warnings`、`trace`、精简 `ruleSet`。

**示例**

```json
{
  "name": "drg_group_case",
  "arguments": {
    "principalDiagnosis": "E10.300x051+H42.0*",
    "sex": "F",
    "ageYears": 75
  }
}
```

```text
【CHS-DRG 3.0】已确定分组
  MDC：MDCC 眼疾病及功能障碍
  ADRG：CV1 各种类型青光眼
  DRG：CV1H 各种类型青光眼，大于等于 70 岁
  严重度：NONE
```

---

## `drg_compare_versions`

同一份病案分别按 2.0 与 3.0 独立规则分组，输出两版结果与差异对照。入参同 `drg_group_case`。

**返回**：`v2`、`v3`（各自的完整结果）、`comparison`（`comparable` / `sameResult` / `differences` / `summary`）。

**示例**

```json
{
  "name": "drg_compare_versions",
  "arguments": {
    "principalDiagnosis": "P07.200",
    "sex": "F",
    "ageDays": 10,
    "birthWeightGrams": 1200,
    "admissionWeightGrams": 1200
  }
}
```

```text
【CHS-DRG 2.0】已确定分组
  ADRG：PS1 极度发育不全（出生体重＜1500g）
  DRG：PS15 极度发育不全（出生体重＜1500g），不伴严重合并症或并发症

【CHS-DRG 3.0】已确定分组
  ADRG：PS2 极度发育不全（入院体重 1000-1499g）
  DRG：PS29 极度发育不全（入院体重 1000-1499g）

【差异】两版结果存在差异，请对照病组名称与规则轨迹。
```

---

## `drg_group_batch`

对最多 10 份病案批量执行 CHS-DRG 3.0 分组。

**输入**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `cases` | object[] | ✅ | 每项字段同 `drg_group_case`，最多 10 项 |

**返回**：`total`、`grouped`、`results[]`（每项的 `index` / `status` / `drg` / `adrg` / `mdc` / `needs` / `errors`）。

---

## `drg_search_code`

在 2.0 / 3.0 数据表中按编码或名称关键词检索医保版诊断、手术操作编码。

**输入**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `query` | string | ✅ | 编码或名称关键词，如 `青光眼`、`E10.3`、`39.95` |
| `type` | `diagnosis` / `procedure` | | 检索类型，默认 `diagnosis` |

**返回**：`type`、`count`、`items[]`（`code` / `names` / `versions`）。最多返回 20 条。

---

## `drg_service_info`

查询服务运行状态、已加载的 2.0 / 3.0 规则版本、编码表规模与已知待核实口径。

**输入**：无。

**返回**：上游地址、`health`、`meta`（`version` / `architecture` / `counts` / `limitations`）。

---

## 状态取值

| `status` | 含义 |
| --- | --- |
| `grouped` | 当前输入下唯一确定的 DRG，`result.drg` 有效 |
| `needs-data` | 缺少年龄 / 体重 / 性别等必需字段，`needs` 列出待补字段 |
| `invalid` | 主诊缺失、格式非法、不在本版数据表、性别与主诊系统冲突等 |
| `ungrouped` | 已知规则下未命中 ADRG/DRG |
| `qy` | 主要手术/操作与主要诊断不属于同一 MDC（歧义组），官方未提供最终编码，参考 `qyCandidate` |
| `error` | 服务端异常 |
