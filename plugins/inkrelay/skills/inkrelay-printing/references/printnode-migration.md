# Migrating a PrintNode integration to InkRelay

InkRelay keeps PrintNode's request shape, so most code moves by changing the base URL, the key and the ids.

| PrintNode | InkRelay |
|---|---|
| `https://api.printnode.com` | `https://api.inkrelay.app/v1` (every path gains `/v1`) |
| Basic `KEY:` | Same works; `Authorization: Bearer ir_live_...` also accepted |
| Integer ids | UUID strings: change number columns and types |
| `POST /printjobs` returns a bare integer | Returns the job object; read `id` |
| `X-Idempotency-Key`, duplicate gives 409 | `Idempotency-Key`; same key and body returns the first job, different body 422 |
| `DELETE /printjobs/{set}` | `POST /v1/printjobs/{id}/cancel` |
| `GET /printjobs/{set}/states` | `GET /v1/printjobs/{id}/events` |
| Set URLs like `/printers/1,3` | One id per path |
| States `new`, `sent_to_client`, `done`, `error`, `expired` | `queued`, `sent`, `received`, `printing`, `done`, `error`, `expired`, `cancelled` |
| `expireAfter` default 14 days | Default 24 hours, range 60 to 604800 seconds |
| 10 requests per second per account | 20 per second per key |
| Errors `{uid, code, message}` | `{error: {code, message, request_id}}` |
| Webhooks with a shared secret header | HMAC signatures (Standard Webhooks), 15 event types, retries for about 27 hours, replay |
| `X-Child-Account-*`, scales, `/account/*` | Not supported |

Unchanged: `printerId`, `title`, `source`, `contentType` (`pdf_uri`, `pdf_base64`, `raw_uri`, `raw_base64`), `content`, `qty`, `options`, `authentication`.

## Steps

1. Install the InkRelay agent on each print computer and tick its printers.
2. Map old printer ids to the new ones from `GET /v1/printers` (match on `name` and computer `hostname`) and migrate stored ids.
3. Swap the HTTP client for `@inkrelay/sdk` or `inkrelay`, or change the base URL and headers.
4. Read `id` from the create response; replace cancel and states calls.
5. Replace PrintNode webhook handling with signature verification.
6. Run the suite against an `ir_test_` key and the virtual printers, then switch to `ir_live_`.
