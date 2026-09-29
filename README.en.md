# CHS-DRG MCP Server

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-6E56CF.svg)](https://modelcontextprotocol.io/)

> A [Model Context Protocol](https://modelcontextprotocol.io/) server for **CHS-DRG 2.0 / 3.0**, the DRG payment grouping scheme used by China's national medical insurance system.
> Send inpatient medical-record codes, get deterministic `MDC / ADRG / DRG` grouping results with the full rationale.
> Works out of the box with **WorkBuddy, CodeBuddy, Claude, Cursor** and any MCP-compatible client.

English | [简体中文](./README.md)

---

## What it is

A standard, lightweight MCP connector that exposes DRG grouping as tools to AI agents:

- Input a hospital discharge record (principal diagnosis + procedures + age/sex/weight) → returns `MDC / ADRG / DRG`, severity, grouping status and a step-by-step rationale;
- Supports **side-by-side comparison of CHS-DRG 2.0 vs 3.0**;
- Provides **code search** for diagnoses / procedures and **rule-version info**.

The core grouping engine runs on an independent server. This repository is only a protocol adapter and **contains no grouping rules or algorithm implementation**.

## Features

| Feature | Description |
| --- | --- |
| Standard MCP | `Streamable HTTP` (2025-03-26 / 2025-06-18) and `HTTP+SSE` (2024-11-05) transports |
| Dual-version grouping | Independent CHS-DRG 2.0 and 3.0 rules with diff comparison |
| Deterministic | `status` distinguishes `grouped` / `needs-data` / `invalid` / `ungrouped` / `qy`; never fabricates a result |
| Explainable | Each result carries a trace of the MDC → ADRG → severity → DRG decision path |
| Zero dependencies | Requires only Node.js ≥ 20; no `npm install` |
| Remote-first | Hosted endpoint, no local installation needed |

## Quick start

### Option 1: Use the hosted endpoint (recommended)

The server is already hosted as a remote MCP service. Point your client at:

```
SSE endpoint:        http://47.109.152.150:4174/sse
Streamable HTTP:     http://47.109.152.150:4174/mcp
Health check:        http://47.109.152.150:4174/health
```

> This is a demo IP + HTTP endpoint. For production, use an HTTPS domain (see [self-hosting](./docs/self-hosting.md)).

**WorkBuddy / CodeBuddy** — add a custom MCP server:

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

**Claude Desktop / Cursor** (stdio-only clients, bridged via `mcp-remote`):

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

### Option 2: Self-host

```bash
git clone https://github.com/fattank/chs-drg-mcp.git
cd chs-drg-mcp

DRG_API_BASE=https://your-drg-service.example.com MCP_PORT=4174 node mcp-server.mjs
```

> Self-hosting requires a working upstream DRG service. To simply use the grouping capability, use Option 1.

## Tools

| Tool | Purpose | Required |
| --- | --- | --- |
| `drg_group_case` | CHS-DRG 3.0 grouping for a single case | `principalDiagnosis` |
| `drg_compare_versions` | CHS-DRG 2.0 / 3.0 comparison | `principalDiagnosis` |
| `drg_group_batch` | CHS-DRG 3.0 batch grouping (≤ 10 cases) | `cases[].principalDiagnosis` |
| `drg_search_code` | Diagnosis / procedure code search | `query` |
| `drg_service_info` | Service status and rule versions | — |

Full parameter reference: [docs/tools.md](./docs/tools.md).

## Examples

**Single case**

> Group this case with drg_group_case: principal diagnosis `E10.300x051+H42.0*`, female, 75 years old.

```text
[CHS-DRG 3.0] grouped
  MDC:  MDCC Eye diseases and disorders
  ADRG: CV1 Glaucoma, various types
  DRG:  CV1H Glaucoma, various types, age >= 70
  Severity: NONE
```

**Dual-version comparison**

> Compare CHS-DRG 2.0 and 3.0 for: principal diagnosis `P07.200`, female, 10 days old, birth weight 1200g, admission weight 1200g.

```text
[CHS-DRG 2.0] grouped
  ADRG: PS1 Extreme immaturity (birth weight < 1500g)
  DRG:  PS15 Extreme immaturity (birth weight < 1500g) w/o severe CC

[CHS-DRG 3.0] grouped
  ADRG: PS2 Extreme immaturity (admission weight 1000-1499g)
  DRG:  PS29 Extreme immaturity (admission weight 1000-1499g)

[Difference] The two versions differ; compare DRG names and rule traces.
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `DRG_API_BASE` | `http://127.0.0.1:4173` | Upstream DRG grouping service |
| `DRG_API_TIMEOUT_MS` | `20000` | Upstream timeout (ms) |
| `MCP_HOST` | `0.0.0.0` | Listen address |
| `MCP_PORT` | `4174` | Listen port |
| `DRG_MCP_AUTH_TOKEN` | empty | Enables `Authorization: Bearer <token>` auth when set |
| `TLS_CERT` / `TLS_KEY` | empty | Serve HTTPS directly when both are set |

## Security & privacy

- **No algorithm**: this repository contains no DRG rules, code tables or calculation logic; grouping happens on an independent server.
- **No storage**: the connector only forwards requests in memory; it does not persist records or log clinical content.
- **Minimal data**: only the codes and demographics required for grouping.
- **No payment data**: never returns tariffs, payment standards or settlement amounts.
- **Auth recommended**: set `DRG_MCP_AUTH_TOKEN` and use HTTPS end-to-end in public deployments.

See [SECURITY.md](./SECURITY.md) to report issues.

## Disclaimer

This project is a case-grouping **computation tool** implemented from the publicly available CHS-DRG grouping scheme. It is intended for hospital case-mix, insurance and quality-control staff to verify grouping results, and **does not constitute billing, payment or legal advice**. Final grouping is subject to the medical insurance agency's determination. Use of this project does not imply any official certification.

## Deployment

See [docs/self-hosting.md](./docs/self-hosting.md). systemd + Nginx HTTPS reverse-proxy examples are in [`deploy/`](./deploy).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache License 2.0](./LICENSE) © 2026 fattank

## Contact

- WeChat: scan the QR code below (please mention "DRG" when adding)
- Issues & feedback: [GitHub Issues](https://github.com/fattank/chs-drg-mcp/issues)

<img src="./assets/wechat-qrcode.png" alt="WeChat QR code" width="260" />
