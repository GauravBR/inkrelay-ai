---
name: inkrelay-printing
description: Add printing to an app with the InkRelay cloud printing API. Use when code must print PDFs, invoices, packing slips, shipping labels (ZPL), receipts (ESC/POS) or any document to a physical printer on Windows, macOS or Linux from a server, web app, SaaS, ERP, POS, warehouse or kitchen system; when building remote, silent or kiosk printing without a print dialog; when replacing PrintNode, Google Cloud Print or QZ Tray; or when handling InkRelay print jobs, printers, webhooks or test mode.
---

# Print from code with InkRelay

InkRelay is a cloud printing API. A small agent runs as a system service on the computer the printers are attached to (Windows, macOS, Linux, Raspberry Pi) and keeps an outbound WebSocket to `api.inkrelay.app`. Your code sends one HTTPS request; the job is pushed to the agent at once and reports `queued`, `sent`, `received`, `printing`, then `done` or `error` with the spooler's own message. No ports to open, no print dialog, no browser plugin.

Base URL `https://api.inkrelay.app/v1`. Auth `Authorization: Bearer <key>` (or Basic with the key as username, PrintNode style). Docs for agents: `https://docs.inkrelay.app/llms-full.txt`.

## Workflow

1. **Pick the SDK for the project's language.** TypeScript or JavaScript (Node 18+): `npm install @inkrelay/sdk`. Python 3.10+: `pip install inkrelay`. Anything else: plain HTTPS (see [references/api.md](references/api.md)). Do not hand-roll HTTP in a language that has an SDK: the SDKs add retries, idempotency keys, pagination and webhook verification.
2. **Configure the key from the environment.** Read `INKRELAY_API_KEY`; never hard-code it or commit it. Add it to `.env.example` with a placeholder. Keys start `ir_test_` (virtual printers only, free) or `ir_live_` (real printers). Create keys at `https://app.inkrelay.app/api-keys` with the least scope: `print` for printing, `read` for listing, `admin` for printer settings and webhooks.
3. **Store printer ids, not names.** Printer ids are UUID strings. Let the user pick a printer from `GET /v1/printers` (or the dashboard) and save its id in config or the database, one per role (for example `INVOICE_PRINTER_ID`, `LABEL_PRINTER_ID`).
4. **Create the job.** One call per document. Use `contentType` `pdf_uri` (a public or signed URL, fetched once) or `pdf_base64` for PDFs, `raw_base64` or `raw_uri` for ZPL and ESC/POS. Max 25 MB.
5. **Track the result.** In production, subscribe a webhook to `printjob.done` and `printjob.error` and update your record. In scripts and tests, `createAndWait` / `create_and_wait` is fine. Always read `state` and `stateMessage`; a failed print is a job in `error`, not an exception.
6. **Test with an `ir_test_` key first.** Four virtual printers (Test A4 Laser, Test Letter Color, Test Receipt 80mm, Test Label 4x6) finish in about 3 seconds. Put `[fail]` in the title to force `error`. Then switch to an `ir_live_` key and real printer ids; nothing else changes.

## TypeScript

```ts
import { InkRelay, InkRelayError } from "@inkrelay/sdk";

const ir = new InkRelay(); // reads INKRELAY_API_KEY

export async function printInvoice(invoiceId: string, pdfUrl: string) {
  try {
    const job = await ir.printJobs.create(
      {
        printerId: process.env.INVOICE_PRINTER_ID!,
        title: `Invoice ${invoiceId}`,
        contentType: "pdf_uri",
        content: pdfUrl, // signed URL valid for a few minutes
        options: { copies: 1, paper: "A4", duplex: "long-edge" },
      },
      { idempotencyKey: `invoice-${invoiceId}` }, // a retry can never print twice
    );
    return job.id; // store it; the webhook reports done or error
  } catch (err) {
    if (err instanceof InkRelayError) console.error(err.status, err.code, err.requestId);
    throw err;
  }
}
```

## Python

```python
from inkrelay import InkRelay, InkRelayError

ir = InkRelay()  # reads INKRELAY_API_KEY

def print_label(order_id: str, zpl: str, printer_id: str) -> str:
    import base64
    job = ir.print_jobs.create(
        {"printerId": printer_id, "title": f"Label {order_id}", "contentType": "raw_base64",
         "content": base64.b64encode(zpl.encode("ascii")).decode()},
        idempotency_key=f"label-{order_id}",
    )
    return job["id"]
```

`AsyncInkRelay` offers the same API for asyncio (`async with AsyncInkRelay() as ir:`).

## Webhooks (production status)

Create an endpoint in the dashboard or with `POST /v1/webhooks` (admin scope); the `whsec_` secret is shown once, store it as `INKRELAY_WEBHOOK_SECRET`. Verify every request with the **raw body**, never re-serialized JSON:

```ts
app.post("/webhooks/inkrelay", express.text({ type: "application/json" }), (req, res) => {
  try { ir.webhooks.verify(req.body, req.headers, process.env.INKRELAY_WEBHOOK_SECRET!); }
  catch { return res.status(400).end(); }
  const event = JSON.parse(req.body); // { id, type, timestamp, mode, data: PrintJob }
  // Delivery is at least once and may be out of order: skip seen event ids, ignore older states.
  res.status(204).end();
});
```

Python: `from inkrelay import webhooks; webhooks.verify(raw_body, headers, secret)`. Answer 2xx within 10 seconds and do slow work on a queue. Details: [references/webhooks.md](references/webhooks.md).

## Rules that prevent real bugs

- Send an `Idempotency-Key` on every `POST /v1/printjobs` derived from your own record (`order-1042-label`). Same key and body returns the first job; same key with a different body is `422 idempotency_key_reused`.
- Rate limit is 20 requests per second per key; on `429` wait for `Retry-After`. The SDKs do this.
- The printer must be live (`enabled: true`), else `422 printer_disabled`. A test key on a live printer, or the reverse, is `422 mode_mismatch`.
- `pdf_uri` URLs must be public `http(s)` on port 80 or 443, under 2048 characters, with no redirects. Private addresses are refused. Base64 PDFs must start with `%PDF-`.
- Jobs can be cancelled only while `queued` or `sent` (`POST /v1/printjobs/{id}/cancel`).
- Reprint without resending the file: `{ printerId, title, reprintOf: jobId }` (files kept 7 days).
- Raw jobs ignore options. Build raw payloads as bytes, end ZPL with `^XZ`, end receipts with line feeds and a cut command. See [references/raw-printing.md](references/raw-printing.md).
- Unsupported options are ignored and listed in `stateMessage`; read the printer's `capabilities` before hard-coding paper or tray names. See [references/api.md](references/api.md).

## Going live checklist

1. Install the agent on the computer with the printers: `curl -fsSL https://dl.inkrelay.app/agent/install.sh | sudo sh` (macOS, Linux) or `irm https://dl.inkrelay.app/agent/install.ps1 | iex` in an admin PowerShell (Windows). Approve the computer at `app.inkrelay.app/device`.
2. Tick the printers that should accept jobs (agent page or dashboard).
3. Create an `ir_live_` key, set real printer ids, create a live `https` webhook endpoint.
4. Watch the first jobs in the dashboard.

Migrating from PrintNode: see [references/printnode-migration.md](references/printnode-migration.md). Framework recipes (Next.js, Express, FastAPI, Django, Laravel, queues): see [references/recipes.md](references/recipes.md).

If the InkRelay MCP server is connected, use its tools (`list_printers`, `print_pdf`, `print_raw`, `get_print_job`) to find real printer ids and send a test print while you build.
