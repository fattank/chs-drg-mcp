# 上架腾讯云 MCP 广场 —— 材料与清单

本文件用于申请将本 MCP 收录进腾讯云 **MCP 广场**（`https://cloud.tencent.com/developer/mcp`）。
所有内容可直接复制到提交表单 / 邮件 / 工单。

> 说明：腾讯云 MCP 广场目前以**官方 + 精选第三方**收录为主，没有公开自助发布入口。
> 常见路径是：**开源到 GitHub → 通过腾讯云开发者社区联系收录**（如 `cloudcommunity@tencent.com`）。
> 本文件帮你把材料一次备齐。

---

## 1. 基本信息

| 字段 | 建议填写 |
| --- | --- |
| 名称 | CHS-DRG 病案分组器 |
| 英文名 | CHS-DRG Grouper |
| 类别 | 医疗健康 / 数据查询 |
| 标签 | DRG、医保、病案首页、分组、ICD、CHS-DRG、医院管理 |
| 开源仓库 | `https://github.com/fattank/chs-drg-mcp` |
| 官网 | `http://47.109.152.150:4173`（演示） |
| 图标 | 512×512 PNG（建议深蓝底白字 “DRG”） |
| 许可 | Apache-2.0 |

**一句话简介（≤ 60 字）**

> 按国家医保局 CHS-DRG 2.0 / 3.0 规则，对住院病案首页做确定性分组，返回 MDC、ADRG、DRG 与分组依据。

**详细描述**

> CHS-DRG 病案分组器提供中国国家医保局 CHS-DRG 2.0 与 3.0 两个版本的病案分组能力。用户提供住院病案首页的主要诊断、其他诊断、主要手术操作、其他手术操作，以及性别、年龄、出生/入院体重等必要字段后，工具按确定性规则链执行：输入校验 → Pre-MDC / MDC → ADRG → DRG 细分 → 严重度（CC/MCC）判定，返回 MDC、ADRG、DRG 编码与名称、严重度、分组状态和分组依据轨迹。服务同时支持 2.0 / 3.0 双版本对照，并提供诊断与手术操作编码检索。所有计算在服务端完成，不返回支付标准、费率或结算金额，结果仅供病案与医保管理人员核对参考。

---

## 2. 连接方式

| 传输 | 地址 | 说明 |
| --- | --- | --- |
| HTTP+SSE | `https://你的域名/sse`（当前演示：`http://47.109.152.150:4174/sse`） | 优先 |
| Streamable HTTP | `https://你的域名/mcp`（当前演示：`http://47.109.152.150:4174/mcp`） | 备选 |
| 健康检查 | `https://你的域名/health` | 探活 |
| 鉴权 | 默认无 | 如需：`Authorization: Bearer <token>` |

`initialize` 返回：

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": { "listChanged": false } },
  "serverInfo": {
    "name": "chs-drg-grouper",
    "title": "CHS-DRG 2.0/3.0 分组服务",
    "version": "1.0.0",
    "websiteUrl": "http://47.109.152.150:4173"
  }
}
```

---

## 3. 工具清单

| 工具 | 作用 |
| --- | --- |
| `drg_group_case` | CHS-DRG 3.0 单病例分组 |
| `drg_compare_versions` | CHS-DRG 2.0 / 3.0 双版本对照 |
| `drg_group_batch` | CHS-DRG 3.0 批量分组（≤ 10 份） |
| `drg_search_code` | 诊断 / 手术操作编码检索 |
| `drg_service_info` | 服务状态与规则版本 |

完整参数与返回见 [`docs/tools.md`](./tools.md)。

---

## 4. 数据与隐私说明（审核常问）

| 问题 | 回答 |
| --- | --- |
| 是否上传/存储用户数据？ | 否。连接器仅在内存中转发病案编码，计算后立即返回，不落库、不记录正文日志。 |
| 是否向第三方传输数据？ | 否。仅在本项目自有的服务端完成计算。 |
| 是否包含支付/结算金额？ | 否。只返回分组编码与名称。 |
| 是否需要 API Key？ | 默认不需要；可按平台要求开启 Bearer Token。 |
| 结果可否直接用于结算？ | 否。仅供参考，以医保经办机构口径为准。 |
| 已知局限 | 少数口径（MDCZ 完整入口、特殊 MDC 优先级、跨 MDC 的 QY 回退、异版编码映射）标注为待核实，相关病例返回待核对提示，不臆造结果。 |

---

## 5. 合规声明

> 本服务为病案分组计算工具，依据公开的国家医保局 CHS-DRG 分组方案实现，仅供医院病案、医保、质控人员核对分组结果使用，不构成任何结算、支付或法律意见。分组结果以医保经办机构最终认定口径为准。使用本服务不代表获得任何官方认证。

---

## 6. 审核前自检

```bash
# 健康检查
curl -s https://你的域名/health

# MCP 握手
curl -s -X POST https://你的域名/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'

# 工具列表
curl -s -X POST https://你的域名/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# SSE 握手（应返回 event: endpoint）
curl -sN --max-time 5 https://你的域名/sse | head -3
```

## 7. 联系与投稿

- 腾讯云开发者社区邮箱：`cloudcommunity@tencent.com`
- 提交内容：仓库地址 + 上面的基本信息 + 连接方式 + 工具清单 + 隐私/合规说明
- 保持服务持续在线、HTTPS 证书有效，以便平台安全扫描通过
