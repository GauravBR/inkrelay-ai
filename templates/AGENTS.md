## Printing (InkRelay)

This project prints through InkRelay (https://inkrelay.app), a cloud printing API. Agent-friendly docs: https://docs.inkrelay.app/llms-full.txt

- Use the official SDK: `@inkrelay/sdk` (Node 18+) or `inkrelay` (Python 3.10+). Other languages call `https://api.inkrelay.app/v1` with `Authorization: Bearer $INKRELAY_API_KEY`.
- Read the key from `INKRELAY_API_KEY` and printer ids from configuration. Never commit keys. `ir_test_` keys print only to virtual printers; `ir_live_` keys print on paper.
- Create jobs with `POST /v1/printjobs` (`printerId`, `title`, `contentType` of `pdf_uri`, `pdf_base64`, `raw_uri` or `raw_base64`, `content`) and an `Idempotency-Key` built from the business record (for example `order-1042-label`).
- A failed print is a job with `state: "error"` and a reason in `stateMessage`, not an exception. Track results with webhooks (`printjob.done`, `printjob.error`) verified against the raw request body with `INKRELAY_WEBHOOK_SECRET`.
- ZPL and ESC/POS go as `raw_base64` bytes; print options apply to PDFs only.
- Test against the virtual printers first; put `[fail]` in a test job title to force an error.
