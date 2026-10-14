# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-10-14

### Added

- Access log (on by default, one JSONL file per day under `logs/`, directory `0700` / file `0600`, never exposed over HTTP). Records caller IP, a daily-rotating visitor id, method, path, status, latency, User-Agent, session id, the platform name the client reports in `clientInfo`, and per-request tool-call outcomes (`calls` / `callSuccesses` / `callFailures`). Request bodies and JSON-RPC `params` are never logged.
- `X-DRG-Client` marker header on upstream calls, so the grouping service can tell which connector forwarded a request.
- New environment variables: `DRG_MCP_ACCESS_LOG`, `DRG_MCP_ACCESS_LOG_DIR`, `DRG_MCP_ACCESS_LOG_TZ`, `DRG_ACCESS_LOG_RETRY_MS`, `DRG_ACCESS_SALT`, `DRG_MCP_TRUST_PROXY`, `DRG_CLIENT_ID`.

### Fixed

- Batch JSON-RPC requests: every `tools/call` inside an array is now counted, and requests are matched to responses by id **type** (numeric `1` and string `"1"` no longer collide).
- Failed tool calls (unknown tool `-32602`, or `result.isError`) are recorded as failures instead of being counted as usage.
- A client disconnect mid-call no longer drops the log record — call attempts are registered before the tool runs.
- The reported platform name is no longer lost when a server-to-client stream is opened or closed.
- Log-write failures (including asynchronous `ENOSPC`) now enter a cooldown instead of re-probing synchronously on every request.
- SSE responses (`GET /mcp`, `/sse`) flush headers immediately instead of waiting for the first 25s heartbeat.

## [1.1.0] - 2026-10-01

### Added

- `useMapping` input flag: map national-clinical (国临版) codes to insurance (医保版) codes before grouping (rule-table first, mapping fallback, single hop).
- `drg_mapping_query` tool: query the national-clinical → insurance code mapping, for diagnosis / procedure, with an insurance-gray-code filter.
- Grouping results now include `mapping` / `mappingTrace`, exposing mapped codes and insurance "gray" code flags.
- `drg_service_info` now reports mapping-table sizes and gray-code counts.

## [1.0.0] - 2026-09-29

### Added

- MCP server with `Streamable HTTP` (`/mcp`) and `HTTP+SSE` (`/sse`) transports.
- Tools:
  - `drg_group_case` — CHS-DRG 3.0 single-case grouping.
  - `drg_compare_versions` — CHS-DRG 2.0 / 3.0 comparison.
  - `drg_group_batch` — CHS-DRG 3.0 batch grouping (≤ 10 cases).
  - `drg_mapping_query` — national-clinical → insurance code mapping query.
  - `drg_search_code` — diagnosis / procedure code search.
  - `drg_service_info` — service status and rule versions.
- Optional Bearer-token authentication (`DRG_MCP_AUTH_TOKEN`).
- Optional direct TLS (`TLS_CERT` / `TLS_KEY`).
- Zero-dependency, offline end-to-end test suite (`npm test`).
- systemd unit and Nginx HTTPS reverse-proxy examples under `deploy/`.
