# InkRelay AI kit

MCP server, Agent Skill and Claude Code plugin for [InkRelay](https://inkrelay.app), a cloud printing API. Use them to let an AI assistant print on your printers, or to have a coding agent add printing to your app.

| Piece | Use it to | Install |
|---|---|---|
| [`@inkrelay/mcp`](mcp/) | List printers, print PDFs, ZPL labels and ESC/POS receipts, follow jobs, manage webhooks from an MCP client | `npx -y @inkrelay/mcp` |
| [`inkrelay-printing` skill](plugins/inkrelay/skills/inkrelay-printing/SKILL.md) | Give a coding agent the API rules, SDK usage, webhook verification and raw printing details | Claude Code plugin, or copy the folder |
| [`inkrelay-integrator` agent](plugins/inkrelay/agents/inkrelay-integrator.md) | Add printing to a project: SDK, config, print module, webhook route, tests, one test print | Claude Code plugin |
| Docs MCP server | Search the InkRelay docs from an MCP client | `https://docs.inkrelay.app/mcp` |
| [AGENTS.md snippet](templates/AGENTS.md) | Give agents without skills the same rules | Paste into `AGENTS.md`, `CLAUDE.md` or Cursor rules |

## Quick start

1. Sign in at [app.inkrelay.app](https://app.inkrelay.app) and create a key under API keys. A test key (`ir_test_...`) prints only to four virtual printers (A4 laser, Letter color, 80 mm receipt, 4x6 label) and costs nothing.
2. Add the MCP server to Claude Code (other clients are in [mcp/README.md](mcp/README.md)):

   ```bash
   claude mcp add-json inkrelay '{"command":"npx","args":["-y","@inkrelay/mcp"],"env":{"INKRELAY_API_KEY":"ir_test_your_key"}}'
   ```

3. Ask: "Print https://inkrelay.app/sample.pdf on Test A4 Laser and tell me when it is done."

### Claude Code plugin

Installs the MCP server, the docs MCP server, the skill and the agent together. Set `INKRELAY_API_KEY` in your shell, start Claude Code and run:

```text
/plugin marketplace add GauravBR/inkrelay-ai
/plugin install inkrelay@inkrelay
```

Then ask, for example: "Add label printing to this app with InkRelay."

### Skill only

Copy [`plugins/inkrelay/skills/inkrelay-printing`](plugins/inkrelay/skills/inkrelay-printing) into your agent's skills folder (for Claude Code, `.claude/skills/` in the project or `~/.claude/skills/`). It uses the Agent Skills format (`SKILL.md` with `name` and `description`), so other agents that read that format can load it too.

## What InkRelay does

- An agent runs as a system service on Windows, macOS or Linux (including Raspberry Pi) next to the printers. It connects out on port 443 and keeps a WebSocket to `api.inkrelay.app`, so nothing needs to be opened on the network.
- Your code sends `POST /v1/printjobs` with a printer id and a PDF (URL or base64) or raw bytes (ZPL, ESC/POS). The job is sent to the agent as soon as it is stored. Test jobs reach `done` in about 3 seconds.
- Each job reports `queued`, `sent`, `received`, `printing`, then `done` or `error` with the operating system's message, and keeps its event history.
- Webhooks are signed in the Standard Webhooks format (HMAC), cover 15 event types, retry for about 27 hours and can be replayed.
- `Idempotency-Key` on job creation makes retries safe. The limit is 20 requests per second per key.
- SDKs: `@inkrelay/sdk` (npm) and `inkrelay` (PyPI). OpenAPI 3.1 spec and a Postman collection.
- Request fields match PrintNode's, so PrintNode integrations move with a base URL and id change ([migration guide](https://docs.inkrelay.app/guides/migrating-from-printnode)).
- Test mode is free. The Lite plan includes 50 live prints a month on one computer ([pricing](https://inkrelay.app/pricing)).

## Links

- Website: https://inkrelay.app
- Docs: https://docs.inkrelay.app (single file for agents: https://docs.inkrelay.app/llms-full.txt)
- API: https://api.inkrelay.app, OpenAPI at https://docs.inkrelay.app/openapi/openapi.json
- SDKs: [`@inkrelay/sdk`](https://www.npmjs.com/package/@inkrelay/sdk), [`inkrelay`](https://pypi.org/project/inkrelay/)

## License

MIT
