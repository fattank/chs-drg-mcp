# CHS-DRG MCP Server

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-6E56CF.svg)](https://modelcontextprotocol.io/)

> 面向中国医保 **CHS-DRG 2.0 / 3.0** 的 [MCP](https://modelcontextprotocol.io/) 服务端。
> 输入住院病案首页编码，返回确定性的 MDC / ADRG / DRG 分组结果与分组依据。
> 可被 **WorkBuddy、CodeBuddy、Claude、Cursor** 等任何支持 MCP 的客户端直接调用。

[English](./README.en.md) | 简体中文

---

## 这是什么

一个标准、轻量的 MCP 连接器，把 DRG 病案分组能力以工具（Tool）的形式暴露给 AI 智能体：

- 一份病案首页（主要诊断 + 手术操作 + 年龄/性别/体重等）→ 返回 `MDC / ADRG / DRG`、严重度、分组状态和每一步分组依据；
- 同时支持 **2.0 与 3.0 双版本对照**，方便观察医保付费版本升级带来的分组差异；
- 提供诊断 / 手术操作 **编码检索** 和 **规则版本查询**。

核心分组算法在独立的服务端运行，本仓库只是标准协议适配层，**不包含任何分组规则或算法实现**。

## 特性

| 特性 | 说明 |
| --- | --- |
| 标准 MCP 协议 | 支持 `Streamable HTTP`（2025-03-26 / 2025-06-18）与 `HTTP+SSE`（2024-11-05）两种传输 |
| 双版本分组 | CHS-DRG 2.0 与 3.0 独立规则，支持并排对照 |
| 确定性结果 | 返回 `status` 区分 `grouped` / `needs-data` / `invalid` / `ungrouped` / `qy`，不臆造结果 |
| 分组依据 | 每个结果附带 trace，展示 MDC → ADRG → 严重度 → DRG 的判定过程 |
| 零第三方依赖 | 仅需 Node.js ≥ 20，无 `npm install` |
| 远程优先 | 无需本地安装，直接连接托管端点即可使用 |

## 快速开始

### 方式一：连接托管端点（推荐）

本项目已部署为远程 MCP 服务，**无需安装任何东西**，把你的 MCP 客户端指向：

```
SSE 端点：         http://47.109.152.150:4174/sse
Streamable HTTP：  http://47.109.152.150:4174/mcp
健康检查：         http://47.109.152.150:4174/health
```

> 目前为演示用的 IP + HTTP 端点，生产环境建议使用 HTTPS 域名（见 [部署文档](./docs/self-hosting.md)）。

**WorkBuddy / CodeBuddy**：在「连接器 / MCP 服务管理」中添加自定义 MCP：

```json
{
  "mcpServers": {
    "chs-drg-grouper": {
      "type": "sse",
      "url": "http://47.109.152.150:4174/sse"
    }
  }
}
```

**Claude Desktop / Cursor**（仅支持本地 stdio 的客户端，用 `mcp-remote` 桥接）：

```json
{
  "mcpServers": {
    "chs-drg-grouper": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://47.109.152.150:4174/sse"]
    }
  }
}
```

### 方式二：自建

```bash
git clone https://github.com/fattank/chs-drg-mcp.git
cd chs-drg-mcp

# 指向你自己的 DRG 分组服务
DRG_API_BASE=https://your-drg-service.example.com MCP_PORT=4174 node mcp-server.mjs
```

> 自建需要一个可用的上游 DRG 分组服务；若只想直接使用分组能力，请用方式一。

## 提供的工具

| 工具 | 作用 | 必填参数 |
| --- | --- | --- |
| `drg_group_case` | CHS-DRG 3.0 单病例分组 | `principalDiagnosis` |
| `drg_compare_versions` | CHS-DRG 2.0 / 3.0 双版本对照 | `principalDiagnosis` |
| `drg_group_batch` | CHS-DRG 3.0 批量分组（≤ 10 份） | `cases[].principalDiagnosis` |
| `drg_search_code` | 诊断 / 手术操作编码检索 | `query` |
| `drg_service_info` | 服务状态与规则版本 | 无 |

完整参数说明见 [docs/tools.md](./docs/tools.md)。

### 病案字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `principalDiagnosis` | string | **必填**，主要诊断编码（医保版 ICD-10），如 `E10.300x051+H42.0*` |
| `otherDiagnoses` | string[] | 其他诊断编码 |
| `principalProcedure` | string | 主要手术或操作编码（医保版 ICD-9-CM-3） |
| `otherProcedures` | string[] | 其他手术或操作编码 |
| `sex` | `M` / `F` | 性别 |
| `ageYears` | number | 周岁 |
| `ageDays` | integer | 天龄（新生儿） |
| `birthWeightGrams` | integer | 出生体重（克），2.0 早产儿分组使用 |
| `admissionWeightGrams` | integer | 入院体重（克），3.0 早产儿分组使用 |
| `ventilationHours` | number | 呼吸机使用时长（小时） |
| `dischargeDisposition` | string | 离院方式 |
| `caseId` | string | 病案标识（可选） |

## 使用示例

**单病例分组**

> 请调用 drg_group_case：主要诊断 `E10.300x051+H42.0*`，女性，75 岁。

```text
【CHS-DRG 3.0】已确定分组
  MDC：MDCC 眼疾病及功能障碍
  ADRG：CV1 各种类型青光眼
  DRG：CV1H 各种类型青光眼，大于等于 70 岁
  严重度：NONE
```

**双版本对照**

> 对比这个病案在 2.0 和 3.0 的分组差异：主要诊断 `P07.200`，女，出生 10 天，出生体重 1200g，入院体重 1200g。

```text
【CHS-DRG 2.0】已确定分组
  ADRG：PS1 极度发育不全（出生体重＜1500g）
  DRG：PS15 极度发育不全（出生体重＜1500g），不伴严重合并症或并发症

【CHS-DRG 3.0】已确定分组
  ADRG：PS2 极度发育不全（入院体重 1000-1499g）
  DRG：PS29 极度发育不全（入院体重 1000-1499g）

【差异】两版结果存在差异，请对照病组名称与规则轨迹。
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DRG_API_BASE` | `http://127.0.0.1:4173` | 上游 DRG 分组服务地址 |
| `DRG_API_TIMEOUT_MS` | `20000` | 上游调用超时（毫秒） |
| `MCP_HOST` | `0.0.0.0` | 监听地址 |
| `MCP_PORT` | `4174` | 监听端口 |
| `DRG_MCP_AUTH_TOKEN` | 空 | 设置后启用 `Authorization: Bearer <token>` 鉴权 |
| `TLS_CERT` / `TLS_KEY` | 空 | 同时设置时以 HTTPS 启动 |

## 安全与隐私

- **不含算法**：本仓库不包含任何 DRG 分组规则、编码表或计算逻辑，分组在独立服务端完成。
- **不存储病案**：连接器仅做内存中的请求转发，不落库、不记录病案正文。
- **最小数据**：只接收分组所必需的编码与患者基本字段。
- **不含支付信息**：不返回费率、支付标准或结算金额。
- **建议鉴权**：公开部署时请设置 `DRG_MCP_AUTH_TOKEN`，并全链路使用 HTTPS。

发现安全问题请见 [SECURITY.md](./SECURITY.md)。

## 免责声明

本项目为病案分组**计算工具**，依据国家医保局公开的 CHS-DRG 分组方案实现，仅供医院病案、医保、质控人员核对分组结果使用，**不构成任何结算、支付或法律意见**。分组结果以医保经办机构最终认定口径为准。使用本项目不代表获得任何官方认证。

## 部署

见 [docs/self-hosting.md](./docs/self-hosting.md)（systemd + Nginx HTTPS 反向代理示例在 [`deploy/`](./deploy)）。

## 参与贡献

见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

[Apache License 2.0](./LICENSE) © 2026 fattank
