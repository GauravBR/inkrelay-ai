import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

const job = (over: Record<string, unknown> = {}) => ({
  id: "job-1",
  printerId: "p-1",
  title: "Hello",
  state: "queued",
  stateMessage: null,
  ...over,
});

// A fake API: each route returns [status, body]; every request is recorded.
function fakeApi(routes: Record<string, (c: Call) => [number, unknown]>) {
  const calls: Call[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: Call = {
      method: init.method ?? "GET",
      url: url.pathname + url.search,
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    const handler = routes[key];
    const [status, body] = handler
      ? handler(call)
      : [404, { error: { code: "not_found", message: `no route ${key}`, request_id: "r-1" } }];
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "r-1" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function connect(
  fetch: typeof globalThis.fetch,
  apiKey: string | undefined = "ir_test_x",
  fileRoot?: string,
) {
  const server = createServer({
    apiKey,
    fetch,
    fileRoot,
    baseUrl: "https://api.test",
    sleep: async () => {},
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
const parsed = (r: unknown) => JSON.parse(text(r));

describe("InkRelay MCP server", () => {
  it("lists every tool and sends instructions", async () => {
    const client = await connect(fakeApi({}).fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "cancel_print_job",
        "create_webhook",
        "get_print_job",
        "get_printer",
        "get_usage",
        "list_computers",
        "list_events",
        "list_print_jobs",
        "list_printers",
        "list_webhooks",
        "ping_webhook",
        "print_pdf",
        "print_raw",
        "reprint_print_job",
        "update_printer",
        "wait_for_print_job",
        "whoami",
      ].sort(),
    );
    expect(client.getInstructions()).toContain("ir_test_");
  });

  it("starts without a key and explains how to get one", async () => {
    const client = await connect(fakeApi({}).fetch, "");
    const r = await client.callTool({ name: "whoami", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("INKRELAY_API_KEY is not set");
  });

  it("prints a PDF by URL and waits until done", async () => {
    let polls = 0;
    const api = fakeApi({
      "POST /v1/printjobs": () => [201, job()],
      "GET /v1/printjobs/job-1": () => [200, job({ state: ++polls < 2 ? "printing" : "done" })],
    });
    const client = await connect(api.fetch);
    const r = await client.callTool({
      name: "print_pdf",
      arguments: { printerId: "p-1", title: "Hello", url: "https://inkrelay.app/sample.pdf" },
    });
    expect(parsed(r).state).toBe("done");
    const post = api.calls[0] as Call;
    expect(post.headers.authorization).toBe("Bearer ir_test_x");
    expect(post.headers["idempotency-key"]).toBeTruthy();
    expect(post.body).toMatchObject({
      printerId: "p-1",
      contentType: "pdf_uri",
      content: "https://inkrelay.app/sample.pdf",
      source: "inkrelay-mcp",
    });
  });

  it("prints a local PDF file as base64 without waiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkrelay-mcp-"));
    const file = join(dir, "a.pdf");
    await writeFile(file, "%PDF-1.4 test");
    const api = fakeApi({ "POST /v1/printjobs": () => [201, job()] });
    const client = await connect(api.fetch, undefined, dir);
    const r = await client.callTool({
      name: "print_pdf",
      arguments: { printerId: "p-1", title: "File", filePath: "a.pdf", wait: false },
    });
    expect(parsed(r).state).toBe("queued");
    expect(api.calls[0]?.body).toMatchObject({
      contentType: "pdf_base64",
      content: Buffer.from("%PDF-1.4 test").toString("base64"),
    });
  });

  it("refuses a local file that is not a PDF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkrelay-mcp-"));
    const file = join(dir, "a.txt");
    await writeFile(file, "hello");
    const api = fakeApi({});
    const client = await connect(api.fetch, undefined, dir);
    const r = await client.callTool({
      name: "print_pdf",
      arguments: { printerId: "p-1", title: "File", filePath: file },
    });
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("only reads printable files inside the file root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "inkrelay-mcp-out-"));
    const secret = join(outside, "secret.pdf");
    await writeFile(secret, "%PDF-1.4 secret");
    const root = await mkdtemp(join(tmpdir(), "inkrelay-mcp-root-"));
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh", "id.pdf"), "%PDF-1.4 key");
    await writeFile(join(root, "config.yaml"), "token: x");
    await symlink(secret, join(root, "link.pdf"));
    const api = fakeApi({});
    const client = await connect(api.fetch, undefined, root);
    const attempts: [string, string][] = [
      ["print_pdf", secret],
      ["print_pdf", "../secret.pdf"],
      ["print_pdf", "link.pdf"],
      ["print_pdf", ".ssh/id.pdf"],
      ["print_raw", "config.yaml"],
    ];
    for (const [name, filePath] of attempts) {
      const r = await client.callTool({
        name,
        arguments: { printerId: "p-1", title: "x", filePath },
      });
      expect(r.isError, `${name} ${filePath}`).toBe(true);
    }
    expect(api.calls).toHaveLength(0);
  });

  it("turns file reads off when the root is the home folder or a drive root", async () => {
    const api = fakeApi({});
    for (const root of [homedir(), "/"]) {
      const client = await connect(api.fetch, undefined, root);
      const r = await client.callTool({
        name: "print_pdf",
        arguments: { printerId: "p-1", title: "x", filePath: "a.pdf" },
      });
      expect(text(r)).toContain("INKRELAY_FILE_ROOT");
    }
    expect(api.calls).toHaveLength(0);
  });

  it("requires exactly one content source", async () => {
    const client = await connect(fakeApi({}).fetch);
    const r = await client.callTool({
      name: "print_pdf",
      arguments: { printerId: "p-1", title: "x", url: "https://a.test/a.pdf", base64: "JVBERi0=" },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("exactly one");
  });

  it("encodes raw text byte for byte", async () => {
    const api = fakeApi({ "POST /v1/printjobs": () => [201, job()] });
    const client = await connect(api.fetch);
    await client.callTool({
      name: "print_raw",
      arguments: {
        printerId: "p-1",
        title: "Receipt",
        text: "\u001b@Hi\n\u001dV\u0000",
        wait: false,
      },
    });
    const body = api.calls[0]?.body as { contentType: string; content: string };
    expect(body.contentType).toBe("raw_base64");
    expect([...Buffer.from(body.content, "base64")]).toEqual([
      0x1b, 0x40, 0x48, 0x69, 0x0a, 0x1d, 0x56, 0x00,
    ]);
  });

  it("refuses raw text outside one byte per character", async () => {
    const client = await connect(fakeApi({}).fetch);
    const r = await client.callTool({
      name: "print_raw",
      arguments: { printerId: "p-1", title: "x", text: "price: 5€" },
    });
    expect(r.isError).toBe(true);
  });

  it("turns API errors into readable results with a hint", async () => {
    const api = fakeApi({
      "POST /v1/printjobs": () => [
        422,
        { error: { code: "mode_mismatch", message: "Printer is live", request_id: "req-9" } },
      ],
    });
    const client = await connect(api.fetch);
    const r = await client.callTool({
      name: "print_pdf",
      arguments: { printerId: "p-1", title: "x", url: "https://a.test/a.pdf" },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("422 mode_mismatch");
    expect(text(r)).toContain("req-9");
    expect(text(r)).toContain("Hint:");
  });

  it("reprints on the original printer with reprintOf", async () => {
    const api = fakeApi({
      "GET /v1/printjobs/job-1": () => [200, job({ state: "error" })],
      "POST /v1/printjobs": () => [201, job({ id: "job-2" })],
    });
    const client = await connect(api.fetch);
    await client.callTool({
      name: "reprint_print_job",
      arguments: { jobId: "job-1", wait: false },
    });
    expect(api.calls[1]?.body).toEqual({
      printerId: "p-1",
      title: "Hello (reprint)",
      reprintOf: "job-1",
      source: "inkrelay-mcp",
    });
  });

  it("returns a job with its events", async () => {
    const api = fakeApi({
      "GET /v1/printjobs/job-1": () => [200, job({ state: "done" })],
      "GET /v1/printjobs/job-1/events": () => [
        200,
        { data: [{ state: "queued" }, { state: "done" }] },
      ],
    });
    const client = await connect(api.fetch);
    const r = await client.callTool({ name: "get_print_job", arguments: { jobId: "job-1" } });
    expect(parsed(r).events).toHaveLength(2);
  });

  it("filters printers to live ones on one computer", async () => {
    const p = (id: string, computerId: string, enabled: boolean) => ({
      id,
      name: `OS ${id}`,
      displayName: null,
      computerId,
      state: "online",
      enabled,
      isDefault: false,
      defaultOptions: {},
      capabilities: { papers: {} },
    });
    const api = fakeApi({
      "GET /v1/printers": () => [
        200,
        {
          data: [p("a", "c1", true), p("b", "c1", false), p("c", "c2", true)],
          hasMore: false,
          nextCursor: null,
        },
      ],
    });
    const client = await connect(api.fetch);
    const r = await client.callTool({
      name: "list_printers",
      arguments: { computerId: "c1", liveOnly: true },
    });
    const list = parsed(r);
    expect(list.map((x: { id: string }) => x.id)).toEqual(["a"]);
    expect(list[0].capabilities).toBeUndefined();
  });

  it("patches printer settings", async () => {
    const api = fakeApi({
      "PATCH /v1/printers/p-1": (c) => [200, { id: "p-1", ...(c.body as object) }],
    });
    const client = await connect(api.fetch);
    await client.callTool({
      name: "update_printer",
      arguments: { printerId: "p-1", enabled: true, defaultOptions: { paper: "A4" } },
    });
    expect(api.calls[0]).toMatchObject({
      method: "PATCH",
      body: { enabled: true, defaultOptions: { paper: "A4" } },
    });
  });
});
