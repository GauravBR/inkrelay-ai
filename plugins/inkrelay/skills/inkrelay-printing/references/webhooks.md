# InkRelay webhooks

Signed with HMAC-SHA256 in the [Standard Webhooks](https://www.standardwebhooks.com) format, retried for about 27 hours, logged per delivery and replayable.

## Create

```bash
curl https://api.inkrelay.app/v1/webhooks \
  -H "Authorization: Bearer $INKRELAY_API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/webhooks/inkrelay","events":["printjob.done","printjob.error"]}'
```

Needs the `admin` scope. The response holds `secret` (`whsec_...`) once; store it as `INKRELAY_WEBHOOK_SECRET`. An endpoint belongs to the key's mode. Live endpoints must be `https` and resolve to a public address; test endpoints may use `http` (a tunnel to a laptop).

## Events

`printjob.queued`, `printjob.sent`, `printjob.received`, `printjob.printing`, `printjob.done`, `printjob.error`, `printjob.cancelled`, `printjob.expired`, `computer.online`, `computer.offline`, `printer.added`, `printer.removed`, `printer.online`, `printer.offline`, `printer.updated`. Subscribe only to what you handle; most apps need `printjob.done` and `printjob.error`, plus `computer.offline` to alert staff.

## Payload and headers

```json
{ "id": "evt id", "type": "printjob.done", "timestamp": "2026-10-14T10:00:00.000Z", "mode": "live", "data": { "id": "job id", "state": "done", "stateMessage": null, "...": "the full print job" } }
```

Headers: `webhook-id` (event id, stable across retries), `webhook-timestamp` (unix seconds), `webhook-signature` (one or more `v1,<base64>` separated by spaces; two during a secret rotation).

## Verify

Use the raw request body exactly as received.

- Node: `ir.webhooks.verify(rawBody, headers, secret)` throws `WebhookVerificationError`. In Express use `express.text({ type: "application/json" })` for this route, not `express.json()`. In Next.js route handlers use `await req.text()`.
- Python: `from inkrelay import webhooks, WebhookVerificationError`, then `webhooks.verify(raw_body, headers, secret)`. Flask `request.get_data(as_text=True)`, FastAPI `(await request.body()).decode()`, Django `request.body.decode()`.
- Other languages: `base64(HMAC_SHA256(base64decode(secret without "whsec_"), "{webhook-id}.{webhook-timestamp}.{body}"))`, compare in constant time against each `v1,` entry, reject timestamps more than 300 seconds away.

## Delivery rules

- Answer any 2xx within 10 seconds, then do the work on a queue. Redirects are not followed.
- Retries after 5 s, 30 s, 2 min, 10 min, 30 min, 2 h, 8 h, 16 h (plus or minus 20 percent), then `failed`.
- At least once and possibly out of order: store handled `webhook-id` values and ignore a job state older than the one you have (`queued` < `sent` < `received` < `printing` < final).
- An endpoint failing for 5 days is disabled and owners get an email; re-enable with `PATCH /v1/webhooks/{id}` `{"enabled": true}`.
- `POST /v1/webhooks/{id}/ping` sends a signed `ping` event. `POST /v1/webhooks/{id}/rotate-secret` with `{"overlapSeconds": 86400}` rotates without downtime.

## No public endpoint?

Poll `GET /v1/events?dir=asc&limit=100`, then pass the returned `nextCursor` as `after` on each later call. Events appear about 2 seconds after they happen.
