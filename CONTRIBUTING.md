# Contributing

Thanks for your interest in improving CHS-DRG MCP Server!

## Ground rules

- This repository only contains the **MCP protocol adapter**. Do not add DRG grouping rules, code tables or engine logic.
- Keep it **dependency-free**. The server must run on stock Node.js ≥ 20.
- Never commit real patient data. Use synthetic codes in tests and examples.

## Development

```bash
git clone https://github.com/fattank/chs-drg-mcp.git
cd chs-drg-mcp

# run the offline end-to-end test suite
npm test
```

There is no build step and no `npm install` required.

## Adding or changing a tool

1. Edit `src/tools.mjs` (`TOOLS` array): name, title, description, `inputSchema`, handler.
2. If the tool needs a new upstream call, add it to `src/drg-client.mjs`.
3. Keep tool names lower_snake_case and prefix them meaningfully.
4. Update `docs/tools.md` and both `README.md` / `README.en.md` tool tables.
5. Add or adjust a test in `test/mcp.test.mjs` using the built-in mock upstream.

## Commit style

Use clear, scoped messages, e.g.:

```
feat(tools): add drg_group_batch
fix(transport): return 406 when SSE is required
docs(readme): clarify self-hosting
```

## Pull requests

- Describe the motivation and the behavior change.
- Make sure `npm test` passes.
- Keep changes focused; one topic per PR.
- Do not include generated artifacts or secrets.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE).
