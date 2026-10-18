# InkRelay API reference (condensed)

Base `https://api.inkrelay.app`. All paths below are under it. JSON in, JSON out. Every response has `X-Request-Id`. OpenAPI: `https://docs.inkrelay.app/openapi/openapi.json`.

## Auth and keys

- `Authorization: Bearer ir_live_...` or `ir_test_...`. Basic auth with the key as username and an empty password also works.
- Scopes: `read` (list and get), `print` (create, cancel jobs), `admin` (printer settings, webhooks).
- The key's mode decides what it sees: a resource of the other mode answers `404`.

## Endpoints

| Method and path | Purpose | Scope |
|---|---|---|
| `GET /v1/whoami` | Organization, plan, mode and usage of the key | read |
| `GET /v1/computers` | Computers running the agent (`online`, `offline`, `disabled`) | read |
| `GET /v1/computers/{id}` | One computer | read |
| `PATCH /v1/computers/{id}` | Rename, disable, re-enable | admin |
| `DELETE /v1/computers/{id}` | Remove a computer and revoke its agent | admin |
| `GET /v1/computers/{id}/printers` | Printers of one computer | read |
| `GET /v1/printers` | All printers | read |
| `GET /v1/printers/{id}` | One printer with `capabilities`, `defaultOptions`, `customPapers` | read |
| `PATCH /v1/printers/{id}` | `displayName`, `enabled` (live), `defaultOptions`, `customPapers`, `remarks` | admin |
| `GET /v1/printers/{id}/printjobs` | Jobs of one printer | read |
| `POST /v1/printjobs` | Create a print job | print |
| `GET /v1/printjobs` | List jobs; filter `printerId`, `computerId`, `state`, `createdFrom`, `createdTo` | read |
| `GET /v1/printjobs/{id}` | One job | read |
| `POST /v1/printjobs/{id}/cancel` | Cancel while `queued` or `sent` | print |
| `GET /v1/printjobs/{id}/events` | State history with message and actor | read |
| `GET /v1/events` | Event feed, same events as webhooks | read |
| `GET /v1/usage` | Live prints used and included this period | read |
| `GET/POST /v1/webhooks`, `GET/PATCH/DELETE /v1/webhooks/{id}` | Webhook endpoints | admin |
| `GET /v1/webhooks/{id}/deliveries` | Delivery log | admin |
| `POST /v1/webhooks/{id}/ping` | Test delivery | admin |
| `POST /v1/webhooks/{id}/rotate-secret` | New secret with overlap | admin |
| `POST /v1/webhooks/deliveries/{id}/replay` | Send a delivery again | admin |

Pagination: `limit` (1 to 100, default 25), `after` (an id), `dir` (`asc` or `desc`). Body `{ data, hasMore, nextCursor }`; pass `nextCursor` as the next `after`. SDKs: `list()` for a page, `iterate()` for all.

## Create a print job

```json
{
  "printerId": "0192f1a0-7c00-7000-8000-0000000000bb",
  "title": "Invoice 1042",
  "contentType": "pdf_uri",
  "content": "https://files.example.com/invoice-1042.pdf",
  "source": "my-erp",
  "qty": 1,
  "expireAfter": 86400,
  "options": { "copies": 1, "paper": "A4", "duplex": "long-edge" }
}
```

| Field | Rules |
|---|---|
| `printerId` | Required. A live printer of the key's mode |
| `title` | Required. 1 to 255 characters |
| `contentType` | `pdf_uri`, `pdf_base64`, `raw_uri`, `raw_base64` |
| `content` | URL (http or https, ports 80 and 443, max 2048 chars, no redirects, public address) or base64. Max 25 MB decoded |
| `authentication` | `{ "type": "BasicAuth", "credentials": { "user", "pass" } }` for a protected URL |
| `qty` | 1 to 100 |
| `expireAfter` | Seconds the job may wait for the computer, 60 to 604800, default 86400 |
| `options` | PDF only, see below |
| `reprintOf` | Instead of `contentType` and `content`: print an earlier job's stored file again (kept 7 days, then `410 file_expired`) |

Response `201` with the job. Header `Idempotency-Key` (up to 255 chars, kept 24 hours) makes retries safe; a replay answers with `Idempotent-Replayed: true`.

## Job states

`queued` (stored) then `sent` (pushed to the agent; resent after 60 s without acknowledgement, up to 3 times) then `received` (agent has the file) then `printing` (in the OS spooler) then `done` (spooler finished). Final states: `done`, `error` (reason in `stateMessage`), `cancelled`, `expired` (not received within `expireAfter`). `printing` without `done` for 15 minutes becomes `error` with `spooler timeout`.

## Options

| Option | Values |
|---|---|
| `copies` | 1 to 999 |
| `paper` | A name from `capabilities.papers` or `customPapers` |
| `duplex` | `one-sided`, `long-edge`, `short-edge` |
| `color` | `false` for grayscale |
| `dpi` | From `capabilities.dpis`, e.g. `600x600` |
| `bin` | From `capabilities.bins` |
| `media` | From `capabilities.medias` |
| `collate`, `fit_to_page` | booleans |
| `rotate` | 0, 90, 180, 270 |
| `pages` | `1-3,5` |
| `nup` | 1 to 16 (macOS and Linux) |

Omitted options come from the printer's `defaultOptions`. Unknown option names are `400`. Unsupported values are ignored and listed in `stateMessage`. On Windows, PDF jobs ignore `dpi`, `media`, `collate`, `nup` and `rotate` 180.

`capabilities.papers` maps names to `[width, height]` in tenths of a millimetre (`"A4": [2100, 2970]`); a `null` height is a roll. `customPapers` adds sizes such as `{ "name": "Label 100x150", "width": 1000, "height": 1500 }` (max 50, the list is replaced on each PATCH).

## Errors

Shape `{ "error": { "code", "message", "request_id" } }`. Switch on `code`.

| Status | Codes |
|---|---|
| 400 | `invalid_request` |
| 401 | `unauthorized` |
| 403 | `insufficient_scope`, `forbidden` |
| 404 | `not_found` (also for the other mode) |
| 409 | `idempotency_in_progress`, `not_cancellable`, `endpoint_disabled` |
| 410 | `file_expired` |
| 413 | `content_too_large` |
| 422 | `invalid_content`, `invalid_content_url`, `printer_disabled`, `mode_mismatch`, `idempotency_key_reused`, `invalid_url` |
| 429 | rate limit (20 requests per second per key) or `test_mode_daily_cap` (500 test jobs per UTC day). Honour `Retry-After` |
| 5xx | Retry with backoff and the same `Idempotency-Key` |

SDK errors: `InkRelayError` with `status`, `code`, `requestId` (`request_id` in Python); `InkRelayTimeoutError` from `createAndWait` with the last `job`.
