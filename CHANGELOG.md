# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-29

### Added

- MCP server with `Streamable HTTP` (`/mcp`) and `HTTP+SSE` (`/sse`) transports.
- Tools:
  - `drg_group_case` — CHS-DRG 3.0 single-case grouping.
  - `drg_compare_versions` — CHS-DRG 2.0 / 3.0 comparison.
  - `drg_group_batch` — CHS-DRG 3.0 batch grouping (≤ 10 cases).
  - `drg_search_code` — diagnosis / procedure code search.
  - `drg_service_info` — service status and rule versions.
- Optional Bearer-token authentication (`DRG_MCP_AUTH_TOKEN`).
- Optional direct TLS (`TLS_CERT` / `TLS_KEY`).
- Zero-dependency, offline end-to-end test suite (`npm test`).
- systemd unit and Nginx HTTPS reverse-proxy examples under `deploy/`.
