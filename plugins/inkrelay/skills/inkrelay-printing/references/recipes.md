# Framework recipes

Each recipe reads `INKRELAY_API_KEY` and a printer id from the environment and stores the job id on your own record.

## Next.js (App Router)

```ts
// app/api/orders/[id]/print/route.ts
import { InkRelay } from "@inkrelay/sdk";
const ir = new InkRelay();

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await ir.printJobs.create(
    { printerId: process.env.INVOICE_PRINTER_ID!, title: `Order ${id}`, contentType: "pdf_uri", content: await signedInvoiceUrl(id) },
    { idempotencyKey: `order-${id}-invoice` },
  );
  return Response.json({ jobId: job.id, state: job.state });
}

// app/api/webhooks/inkrelay/route.ts
export async function POST(req: Request) {
  const body = await req.text(); // raw body for the signature
  try { ir.webhooks.verify(body, Object.fromEntries(req.headers), process.env.INKRELAY_WEBHOOK_SECRET!); }
  catch { return new Response(null, { status: 400 }); }
  const event = JSON.parse(body);
  await markPrintJob(event.data.id, event.data.state, event.data.stateMessage);
  return new Response(null, { status: 204 });
}
```

Run on the Node.js runtime (the SDK uses `node:crypto`), not the Edge runtime.

## FastAPI

```python
import os
from fastapi import FastAPI, Request, Response
from inkrelay import AsyncInkRelay, webhooks, WebhookVerificationError

app = FastAPI()
ir = AsyncInkRelay()

@app.post("/orders/{order_id}/label")
async def print_label(order_id: str):
    job = await ir.print_jobs.create(
        {"printerId": os.environ["LABEL_PRINTER_ID"], "title": f"Label {order_id}",
         "contentType": "raw_base64", "content": await label_zpl_base64(order_id)},
        idempotency_key=f"order-{order_id}-label",
    )
    return {"jobId": job["id"]}

@app.post("/webhooks/inkrelay")
async def inkrelay_webhook(request: Request):
    body = (await request.body()).decode()
    try:
        webhooks.verify(body, request.headers, os.environ["INKRELAY_WEBHOOK_SECRET"])
    except WebhookVerificationError:
        return Response(status_code=400)
    ...
    return Response(status_code=204)
```

## Django

```python
from django.views.decorators.csrf import csrf_exempt
from django.http import HttpResponse
from inkrelay import webhooks, WebhookVerificationError

@csrf_exempt
def inkrelay_webhook(request):
    try:
        webhooks.verify(request.body.decode(), request.headers, settings.INKRELAY_WEBHOOK_SECRET)
    except WebhookVerificationError:
        return HttpResponse(status=400)
    ...
    return HttpResponse(status=204)
```

## PHP / Laravel (no SDK: plain HTTPS)

```php
$response = Http::withToken(config('services.inkrelay.key'))
    ->withHeaders(['Idempotency-Key' => "order-{$order->id}-invoice"])
    ->retry(3, 500, throw: false)
    ->post('https://api.inkrelay.app/v1/printjobs', [
        'printerId' => config('services.inkrelay.invoice_printer'),
        'title' => "Invoice {$order->number}",
        'contentType' => 'pdf_base64',
        'content' => base64_encode($pdfBytes),
    ]);
$jobId = $response->json('id');
```

The same pattern works in Go, Ruby, Java, C# or any language: POST JSON with a Bearer key and an `Idempotency-Key`, retry `429` (after `Retry-After`) and `5xx` with the same key.

## Background queues

Print from a job queue (BullMQ, Sidekiq, Celery, Laravel queues) rather than inside a user request when documents are generated on the fly. Use your record id in the `Idempotency-Key` so a retried queue job never prints twice, and let the webhook, not the queue job, mark the print as finished.

## Letting users choose a printer

Show `GET /v1/printers` filtered to `enabled: true`, display `displayName ?? name` with the computer name, and save the selected `id`. Watch `printer.offline` and `computer.offline` webhooks to warn users before they print.
