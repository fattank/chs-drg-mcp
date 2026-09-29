# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | ✅ |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Open a private vulnerability report via GitHub Security Advisories: **Security → Report a vulnerability**.
- Or email the maintainer listed in the repository profile.

Please include:

- affected version / endpoint;
- a minimal reproduction (request + observed behavior);
- impact assessment (e.g. data exposure, injection, denial of service).

We aim to acknowledge reports within 72 hours.

## Scope

This project is a protocol adapter. Typical concerns:

- **Upstream abuse**: the connector forwards requests to the configured `DRG_API_BASE`. In public deployments, protect the upstream with authentication and rate limiting.
- **Authentication bypass**: if `DRG_MCP_AUTH_TOKEN` is unset, the MCP endpoints are public by design (required for marketplace probing). Set the token to require `Authorization: Bearer <token>`.
- **Transport security**: put the service behind HTTPS. Terminate TLS at Nginx/Caddy (see `deploy/`) or set `TLS_CERT` / `TLS_KEY` directly.

## Data handling

- The connector does **not** persist request bodies or store clinical data.
- It does **not** log case content.
- Only the minimum fields required for grouping are accepted.

## Out of scope

- Correctness of DRG grouping rules (this repository contains no rules; report to the upstream service).
- Vulnerabilities in third-party MCP clients/platforms.
