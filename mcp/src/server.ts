import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { InkRelay, InkRelayError, InkRelayTimeoutError, type PrintJob } from "@inkrelay/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const VERSION = "0.1.1";
const MAX_BYTES = 25 * 1024 * 1024;
const SOURCE = "inkrelay-mcp";

// Sent to the client at initialize; models read it before choosing a tool.
export const INSTRUCTIONS = `InkRelay is a cloud printing API: a small agent on Windows, macOS or Linux holds an outbound WebSocket to api.inkrelay.app, and a print job created with one HTTPS call is pushed to it at once, then reports queued, sent, received, printing and done.

How to use these tools:
- Call whoami first. Keys starting ir_test_ only see the four virtual printers of InkRelay Test Computer (Test A4 Laser, Test Letter Color, Test Receipt 80mm for ESC/POS, Test Label 4x6 for ZPL); test jobs finish in about 3 seconds, print nothing and cost nothing. Keys starting ir_live_ print on real paper and count toward the plan.
- Find a printer id with list_printers, then print_pdf (PDF by URL, base64 or local file) or print_raw (ZPL, ESC/POS or other printer language bytes).
- A print returns the final job when wait is true. Read state and stateMessage: done means the spooler finished; error carries the operating system's reason; stateMessage also lists options the printer ignored.
- Put [fail] in a test job title to force an error and exercise error handling.

When the user wants printing inside their own code, write it with the official SDKs (npm @inkrelay/sdk, PyPI inkrelay) and these rules: send an Idempotency-Key on POST /v1/printjobs (the SDKs do it), verify webhooks with the raw body (Standard Webhooks HMAC), prefer webhooks (printjob.done, printjob.error) over polling. Full docs: https://docs.inkrelay.app/llms-full.txt`;

export interface ServerOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Folder that filePath arguments must stay inside. */
  fileRoot?: string;
}

const optionsSchema = z
  .object({
    copies: z.number().int().min(1).max(999).optional(),
    paper: z
      .string()
      .optional()
      .describe("A name from the printer's papers or customPapers, e.g. A4"),
    duplex: z.enum(["one-sided", "long-edge", "short-edge"]).optional(),
    color: z.boolean().optional().describe("false prints grayscale"),
    dpi: z.string().optional().describe("e.g. 600x600, from the printer's dpis"),
    bin: z.string().optional().describe("Tray, from the printer's bins"),
    media: z.string().optional(),
    collate: z.boolean().optional(),
    fit_to_page: z.boolean().optional(),
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    pages: z.string().optional().describe("e.g. 1-3,5"),
    nup: z.number().int().min(1).max(16).optional(),
  })
  .strict()
  .describe(
    "PDF options. Omitted options use the printer's defaults; unsupported ones are ignored and listed in stateMessage.",
  );

const waitFields = {
  wait: z
    .boolean()
    .default(true)
    .describe("Wait until the job is done, error, cancelled or expired, then return it"),
  timeoutSeconds: z.number().int().min(1).max(300).default(60),
};

const jobFields = {
  printerId: z.string().describe("Printer id from list_printers"),
  title: z.string().min(1).max(255).describe("Shown in the dashboard and the OS print queue"),
  qty: z.number().int().min(1).max(100).optional().describe("How many times to print the document"),
  expireAfter: z.number().int().min(60).max(604800).optional(),
  idempotencyKey: z
    .string()
    .max(255)
    .optional()
    .describe(
      "Same key and body returns the first job instead of printing twice. Generated if omitted.",
    ),
};

const webhookEvents = [
  "printjob.queued",
  "printjob.sent",
  "printjob.received",
  "printjob.printing",
  "printjob.done",
  "printjob.error",
  "printjob.cancelled",
  "printjob.expired",
  "computer.online",
  "computer.offline",
  "printer.added",
  "printer.removed",
  "printer.online",
  "printer.offline",
  "printer.updated",
] as const;

const jobStates = [
  "queued",
  "sent",
  "received",
  "printing",
  "done",
  "error",
  "cancelled",
  "expired",
] as const;

const HINTS: Record<string, string> = {
  unauthorized: "Set INKRELAY_API_KEY to a key from https://app.inkrelay.app/api-keys.",
  insufficient_scope: "Create a key with the needed scope (read, print or admin) in the dashboard.",
  printer_disabled:
    "Mark the printer live in the dashboard, or call update_printer with enabled: true.",
  mode_mismatch:
    "ir_test_ keys only print to the virtual test printers and ir_live_ keys only to real ones.",
  not_found: "The id is not in this organization and mode; list it again with the same key.",
  invalid_content: "PDF content must start with %PDF-; use print_raw for printer language bytes.",
  invalid_content_url:
    "URLs must be public http(s) on port 80 or 443, at most 2048 characters, with no redirects.",
  not_cancellable: "The agent already received the job, so it can no longer be cancelled.",
  test_mode_daily_cap: "Test mode allows 500 jobs per UTC day.",
  file_expired: "Stored files are kept for 7 days; send the document again.",
  quota_exceeded: "The plan's prints are used up; upgrade in the dashboard billing page.",
};

const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const fail = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
});

function describeError(err: unknown): CallToolResult {
  if (err instanceof InkRelayTimeoutError) {
    return json({
      timedOut: true,
      note: "The job is not final yet and may still print. Call wait_for_print_job or get_print_job later.",
      job: err.job,
    });
  }
  if (err instanceof InkRelayError) {
    const hint = HINTS[err.code];
    return fail(
      `InkRelay API error ${err.status} ${err.code}: ${err.message}` +
        (err.requestId ? ` (request id ${err.requestId})` : "") +
        (hint ? `\nHint: ${hint}` : ""),
    );
  }
  return fail(err instanceof Error ? err.message : String(err));
}

function guard<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return describeError(err);
    }
  };
}

// Raw files a printer can take; anything else (keys, configs, source) is refused.
const RAW_EXTENSIONS = new Set([
  ".zpl",
  ".epl",
  ".dpl",
  ".prn",
  ".pcl",
  ".ps",
  ".escpos",
  ".raw",
  ".bin",
  ".txt",
]);

// Reads a file for printing. Only files under root (INKRELAY_FILE_ROOT, else the working
// directory, never / or the home folder) are allowed, symlinks are resolved first, and hidden paths are refused, so a
// prompt-injected tool call cannot send ~/.ssh or a .env file to a printer.
async function loadFile(root: string, path: string, kind: "pdf" | "raw"): Promise<Buffer> {
  const base = await realpath(root);
  // Desktop clients often start servers in / or the home folder; reading there is too broad.
  const home = await realpath(homedir()).catch(() => homedir());
  if (base === parse(base).root || base === home) {
    throw new Error(
      `filePath is turned off because this server runs in ${base}. Set INKRELAY_FILE_ROOT to the folder that holds your documents, or pass url or base64.`,
    );
  }
  const full = await realpath(resolve(base, path)).catch(() => {
    throw new Error(`${path} does not exist`);
  });
  const rel = relative(base, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${path} is outside ${base}. Set INKRELAY_FILE_ROOT to allow another folder.`);
  }
  if (rel.split(sep).some((part) => part.startsWith("."))) {
    throw new Error(`${path} is a hidden file or inside a hidden folder, which is not printed`);
  }
  if (kind === "raw" && !RAW_EXTENSIONS.has(extname(full).toLowerCase())) {
    throw new Error(`print_raw reads only ${[...RAW_EXTENSIONS].join(", ")} files`);
  }
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_BYTES) throw new Error(`${path} is ${info.size} bytes; the limit is 25 MB`);
  return readFile(full);
}

function exactlyOne(fields: Record<string, unknown>): string {
  const given = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (given.length !== 1) {
    throw new Error(`Pass exactly one of ${Object.keys(fields).join(", ")} (got ${given.length})`);
  }
  return given[0] as string;
}

const summarizePrinter = (p: {
  id: string;
  name: string;
  displayName: string | null;
  computerId: string;
  state: string;
  enabled: boolean;
  isDefault: boolean;
  defaultOptions: unknown;
}) => ({
  id: p.id,
  name: p.displayName ?? p.name,
  osName: p.name,
  computerId: p.computerId,
  state: p.state,
  live: p.enabled,
  isDefault: p.isDefault,
  defaultOptions: p.defaultOptions,
});

export function createServer(opts: ServerOptions = {}): McpServer {
  const apiKey = opts.apiKey ?? process.env.INKRELAY_API_KEY;
  const baseUrl = opts.baseUrl ?? process.env.INKRELAY_BASE_URL ?? "https://api.inkrelay.app";
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const fileRoot = opts.fileRoot ?? process.env.INKRELAY_FILE_ROOT ?? process.cwd();
  let client: InkRelay | undefined;

  // Built lazily so the server still starts (and lists its tools) without a key.
  const ir = () => {
    if (!apiKey) {
      throw new Error(
        "INKRELAY_API_KEY is not set. Create a key at https://app.inkrelay.app/api-keys (an ir_test_ key prints to free virtual printers) and add it to this MCP server's env.",
      );
    }
    client ??= new InkRelay({ apiKey, baseUrl, fetch: doFetch, sleep: opts.sleep });
    return client;
  };

  // For the two endpoints the SDK has no helper for.
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    ir();
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const e = data?.error ?? {};
      throw new InkRelayError(
        res.status,
        e.code ?? "http_error",
        e.message ?? res.statusText,
        e.request_id ?? res.headers.get("x-request-id"),
      );
    }
    return data as T;
  };

  const printAndMaybeWait = async (
    input: Parameters<InkRelay["printJobs"]["create"]>[0],
    a: { wait: boolean; timeoutSeconds: number; idempotencyKey?: string },
  ) => {
    const o = { idempotencyKey: a.idempotencyKey };
    const job: PrintJob = a.wait
      ? await ir().printJobs.createAndWait(input, { ...o, timeoutMs: a.timeoutSeconds * 1000 })
      : await ir().printJobs.create(input, o);
    return json(job);
  };

  const server = new McpServer(
    { name: "inkrelay", title: "InkRelay cloud printing", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "whoami",
    {
      title: "Identify the API key",
      description:
        "Returns the organization, plan, mode (test or live) and current usage behind INKRELAY_API_KEY. Call it first.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => json(await ir().whoami())),
  );

  server.registerTool(
    "list_computers",
    {
      title: "List computers",
      description:
        "Lists the computers running the InkRelay agent, with their state (online, offline, disabled), OS and agent version.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ limit }) => json((await ir().computers.list({ limit })).data)),
  );

  server.registerTool(
    "list_printers",
    {
      title: "List printers",
      description:
        "Lists printers with id, name, computer, online state, whether they are live (accept jobs) and their default options. Use get_printer for paper sizes, trays and other capabilities.",
      inputSchema: {
        computerId: z.string().optional().describe("Only printers of this computer"),
        liveOnly: z.boolean().default(false).describe("Only printers that accept jobs"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ computerId, liveOnly }) => {
      const out = [];
      for await (const p of ir().printers.iterate({ limit: 100 })) {
        if (computerId && p.computerId !== computerId) continue;
        if (liveOnly && !p.enabled) continue;
        out.push(summarizePrinter(p));
        if (out.length >= 500) break;
      }
      return json(out);
    }),
  );

  server.registerTool(
    "get_printer",
    {
      title: "Get a printer",
      description:
        "Returns one printer with its capabilities (papers in tenths of a millimetre, bins, dpis, duplex, color, nup), default options and custom paper sizes.",
      inputSchema: { printerId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ printerId }) => json(await ir().printers.get(printerId))),
  );

  server.registerTool(
    "update_printer",
    {
      title: "Update printer settings",
      description:
        "Sets a printer's display name, live switch (enabled), default options, custom paper sizes (tenths of a millimetre; replaces the whole list) or remarks. Needs a key with the admin scope.",
      inputSchema: {
        printerId: z.string(),
        displayName: z.string().nullable().optional(),
        enabled: z
          .boolean()
          .optional()
          .describe("The live switch: only enabled printers accept jobs"),
        defaultOptions: optionsSchema.optional(),
        customPapers: z
          .array(z.object({ name: z.string(), width: z.number().int(), height: z.number().int() }))
          .max(50)
          .optional(),
        remarks: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard(async ({ printerId, ...body }) =>
      json(await call("PATCH", `/v1/printers/${encodeURIComponent(printerId)}`, body)),
    ),
  );

  server.registerTool(
    "print_pdf",
    {
      title: "Print a PDF",
      description:
        "Prints a PDF on a printer. Pass exactly one of url (public or signed http(s) URL, fetched once), base64, or filePath (a local file, read by this server). Up to 25 MB. With an ir_live_ key this prints on paper and counts toward the plan; with ir_test_ it runs on a virtual printer.",
      inputSchema: {
        ...jobFields,
        url: z.url().optional(),
        base64: z.string().optional(),
        filePath: z
          .string()
          .optional()
          .describe("A file inside the folder this server runs in (or INKRELAY_FILE_ROOT)"),
        options: optionsSchema.optional(),
        ...waitFields,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (a) => {
      const which = exactlyOne({ url: a.url, base64: a.base64, filePath: a.filePath });
      let contentType: "pdf_uri" | "pdf_base64" = "pdf_base64";
      let content: string;
      if (which === "url") {
        contentType = "pdf_uri";
        content = a.url as string;
      } else if (which === "filePath") {
        const bytes = await loadFile(fileRoot, a.filePath as string, "pdf");
        if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
          return fail(
            `${a.filePath} is not a PDF (it does not start with %PDF-). Use print_raw for other bytes.`,
          );
        }
        content = bytes.toString("base64");
      } else {
        content = (a.base64 as string).replace(/^data:application\/pdf;base64,/, "");
      }
      return printAndMaybeWait(
        {
          printerId: a.printerId,
          title: a.title,
          contentType,
          content,
          qty: a.qty,
          expireAfter: a.expireAfter,
          options: a.options,
          source: SOURCE,
        },
        a,
      );
    }),
  );

  server.registerTool(
    "print_raw",
    {
      title: "Print raw bytes (ZPL, ESC/POS)",
      description:
        "Sends printer language bytes unchanged to a label or receipt printer, e.g. ZPL (^XA...^XZ) or ESC/POS. Pass exactly one of text (each character U+0000 to U+00FF becomes one byte, so \\u001b is ESC), base64, url or filePath. Options do not apply. The OS queue must accept raw data (CUPS raw queue, or the printer's own or Generic / Text Only driver on Windows).",
      inputSchema: {
        ...jobFields,
        text: z.string().optional(),
        base64: z.string().optional(),
        url: z.url().optional(),
        filePath: z
          .string()
          .optional()
          .describe("A file inside the folder this server runs in (or INKRELAY_FILE_ROOT)"),
        ...waitFields,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (a) => {
      const which = exactlyOne({
        text: a.text,
        base64: a.base64,
        url: a.url,
        filePath: a.filePath,
      });
      let contentType: "raw_uri" | "raw_base64" = "raw_base64";
      let content: string;
      if (which === "text") {
        const text = a.text as string;
        if ([...text].some((c) => (c.codePointAt(0) ?? 0) > 0xff)) {
          return fail(
            "text has characters above U+00FF. Encode it to the printer's code page yourself and pass base64.",
          );
        }
        content = Buffer.from(text, "latin1").toString("base64");
      } else if (which === "url") {
        contentType = "raw_uri";
        content = a.url as string;
      } else if (which === "filePath") {
        content = (await loadFile(fileRoot, a.filePath as string, "raw")).toString("base64");
      } else {
        content = a.base64 as string;
      }
      return printAndMaybeWait(
        {
          printerId: a.printerId,
          title: a.title,
          contentType,
          content,
          qty: a.qty,
          expireAfter: a.expireAfter,
          source: SOURCE,
        },
        a,
      );
    }),
  );

  server.registerTool(
    "get_print_job",
    {
      title: "Get a print job",
      description:
        "Returns a print job with its state, stateMessage and the time of each state change, plus its full event history.",
      inputSchema: { jobId: z.string(), includeEvents: z.boolean().default(true) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ jobId, includeEvents }) => {
      const job = await ir().printJobs.get(jobId);
      if (!includeEvents) return json(job);
      const events = await call<{ data: unknown[] }>(
        "GET",
        `/v1/printjobs/${encodeURIComponent(jobId)}/events`,
      );
      return json({ ...job, events: events.data });
    }),
  );

  server.registerTool(
    "wait_for_print_job",
    {
      title: "Wait for a print job",
      description:
        "Polls a print job until it is done, error, cancelled or expired (or the timeout passes) and returns it.",
      inputSchema: { jobId: z.string(), timeoutSeconds: waitFields.timeoutSeconds },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async ({ jobId, timeoutSeconds }) => {
      const final = new Set<string>(["done", "error", "cancelled", "expired"]);
      const deadline = Date.now() + timeoutSeconds * 1000;
      const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      let job = await ir().printJobs.get(jobId);
      while (!final.has(job.state)) {
        if (Date.now() >= deadline) throw new InkRelayTimeoutError(job);
        await sleep(1000);
        job = await ir().printJobs.get(jobId);
      }
      return json(job);
    }),
  );

  server.registerTool(
    "list_print_jobs",
    {
      title: "List print jobs",
      description:
        "Lists recent print jobs, newest first, optionally filtered by printer, computer or state.",
      inputSchema: {
        printerId: z.string().optional(),
        computerId: z.string().optional(),
        state: z.enum(jobStates).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (q) => json((await ir().printJobs.list(q)).data)),
  );

  server.registerTool(
    "cancel_print_job",
    {
      title: "Cancel a print job",
      description:
        "Cancels a job that is still queued or sent. Once the agent has received it, the API answers 409 not_cancellable.",
      inputSchema: { jobId: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async ({ jobId }) => json(await ir().printJobs.cancel(jobId))),
  );

  server.registerTool(
    "reprint_print_job",
    {
      title: "Reprint a job",
      description:
        "Prints the stored file of an earlier job again (files are kept 7 days), on the same printer or another one of the same mode.",
      inputSchema: {
        jobId: z.string(),
        printerId: z.string().optional().describe("Defaults to the original printer"),
        title: z.string().min(1).max(255).optional(),
        ...waitFields,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (a) => {
      const original = await ir().printJobs.get(a.jobId);
      return printAndMaybeWait(
        {
          printerId: a.printerId ?? original.printerId,
          title: a.title ?? `${original.title} (reprint)`.slice(0, 255),
          reprintOf: original.id,
          source: SOURCE,
        },
        a,
      );
    }),
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get print usage",
      description:
        "Returns the plan, the live prints used and included this billing period, and earlier periods.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => json(await ir().usage())),
  );

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description:
        "Reads the event feed (the same events webhooks deliver). For new events use dir asc with after set to the last nextCursor.",
      inputSchema: {
        after: z.string().optional(),
        dir: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (q) => json(await ir().events.list(q))),
  );

  server.registerTool(
    "list_webhooks",
    {
      title: "List webhook endpoints",
      description: "Lists the webhook endpoints of this key's mode.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async () => json((await ir().webhooks.list()).data)),
  );

  server.registerTool(
    "create_webhook",
    {
      title: "Create a webhook endpoint",
      description:
        "Creates an endpoint that receives signed events (Standard Webhooks HMAC). Returns the whsec_ signing secret once: tell the user to store it as INKRELAY_WEBHOOK_SECRET. Live endpoints need https. Needs the admin scope.",
      inputSchema: {
        url: z.url(),
        events: z.array(z.enum(webhookEvents)).min(1),
        description: z.string().max(255).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (body) => json(await ir().webhooks.create(body))),
  );

  server.registerTool(
    "ping_webhook",
    {
      title: "Send a test webhook",
      description:
        "Queues a signed test delivery with type ping to an endpoint. Needs the admin scope.",
      inputSchema: { webhookId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ webhookId }) => json(await ir().webhooks.ping(webhookId))),
  );

  return server;
}
