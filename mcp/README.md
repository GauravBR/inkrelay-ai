# @inkrelay/mcp

MCP server for the [InkRelay](https://inkrelay.app) printing API. It lets an AI assistant list your printers and print PDFs, ZPL labels and ESC/POS receipts on printers attached to Windows, macOS and Linux computers.

Works with Claude Code, Claude Desktop, Cursor, VS Code (GitHub Copilot), OpenAI Codex, Windsurf and any client that speaks the Model Context Protocol over stdio.

## Get a key

Sign in at [app.inkrelay.app](https://app.inkrelay.app), open API keys and create one. Start with a test key (`ir_test_...`): it only reaches four virtual printers (Test A4 Laser, Test Letter Color, Test Receipt 80mm, Test Label 4x6), finishes jobs in about 3 seconds and costs nothing. A live key (`ir_live_...`) prints on paper.

## Add it to your client

**Claude Code**

```bash
claude mcp add-json inkrelay '{"command":"npx","args":["-y","@inkrelay/mcp"],"env":{"INKRELAY_API_KEY":"ir_test_your_key"}}'
```

**Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and **Windsurf** (`~/.codeium/windsurf/mcp_config.json`)

```json
{
  "mcpServers": {
    "inkrelay": {
      "command": "npx",
      "args": ["-y", "@inkrelay/mcp"],
      "env": { "INKRELAY_API_KEY": "ir_test_your_key" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "inputs": [{ "type": "promptString", "id": "inkrelay-key", "description": "InkRelay API key", "password": true }],
  "servers": {
    "inkrelay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@inkrelay/mcp"],
      "env": { "INKRELAY_API_KEY": "${input:inkrelay-key}" }
    }
  }
}
```

**OpenAI Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.inkrelay]
command = "npx"
args = ["-y", "@inkrelay/mcp"]
env = { INKRELAY_API_KEY = "ir_test_your_key" }
```

Docs search is a separate hosted server at `https://docs.inkrelay.app/mcp` (streamable HTTP), for example:

```bash
claude mcp add-json inkrelay-docs '{"type":"http","url":"https://docs.inkrelay.app/mcp"}'
```

## Tools

| Tool | What it does |
|---|---|
| `whoami` | Organization, plan, mode (test or live) and usage of the key |
| `list_computers` | Computers running the agent and their state |
| `list_printers` | Printers with id, computer, online state, live switch and defaults |
| `get_printer` | Capabilities: papers, trays, dpis, duplex, color, n-up |
| `update_printer` | Display name, live switch, default options, custom paper sizes (admin scope) |
| `print_pdf` | Print a PDF from a URL, base64 or a local file; waits for the final state by default |
| `print_raw` | Print ZPL, ESC/POS or other printer language bytes from text, base64, a URL or a local file |
| `get_print_job` | A job with its state, message and full event history |
| `wait_for_print_job` | Wait until a job is done, error, cancelled or expired |
| `list_print_jobs` | Recent jobs, filtered by printer, computer or state |
| `cancel_print_job` | Cancel a job that is still queued or sent |
| `reprint_print_job` | Print an earlier job's stored file again |
| `get_usage` | Live prints used and included this billing period |
| `list_events` | The event feed (the same events webhooks deliver) |
| `list_webhooks`, `create_webhook`, `ping_webhook` | Manage signed webhook endpoints (admin scope) |

Things to try: *"Which printers do I have?"*, *"Print this invoice PDF on the A4 laser, two copies, duplex"*, *"Print a 4x6 ZPL test label that says Order 1042"*, *"Why did my last job fail?"*.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `INKRELAY_API_KEY` | none | Your `ir_test_` or `ir_live_` key. The server starts without it and tells the model how to get one |
| `INKRELAY_BASE_URL` | `https://api.inkrelay.app` | Override for a proxy |
| `INKRELAY_FILE_ROOT` | the working directory | Folder that `filePath` arguments must stay inside. File reads are off when this resolves to `/`, a drive root or the home folder (common for desktop clients), so set it there. Hidden files and folders are never read, and `print_raw` reads only printer files (`.zpl`, `.epl`, `.prn`, `.pcl`, `.ps`, `.escpos`, `.raw`, `.bin`, `.txt`) |

`print_pdf`, `print_raw` and `reprint_print_job` send an `Idempotency-Key` on every job (pass your own with `idempotencyKey`), so a retried call never prints twice. Jobs carry `source: "inkrelay-mcp"`. With a live key, jobs print on paper and count toward your plan, so keep tool approval on in your client.

## Building printing into your own code

The MCP server is for operating printers from an assistant. To add printing to an application, use the SDKs, [`@inkrelay/sdk`](https://www.npmjs.com/package/@inkrelay/sdk) and [`inkrelay`](https://pypi.org/project/inkrelay/), and give your coding agent the [`inkrelay-printing` skill](https://github.com/GauravBR/inkrelay-ai/tree/main/plugins/inkrelay/skills/inkrelay-printing).

Docs: https://docs.inkrelay.app/ai

## Development

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## License

MIT
