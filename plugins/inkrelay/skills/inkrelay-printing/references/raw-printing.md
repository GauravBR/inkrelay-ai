# Raw printing: ZPL labels and ESC/POS receipts

Raw jobs send your bytes to the printer unchanged. Use `contentType` `raw_base64` (or `raw_uri` for a URL serving the bytes). Options do not apply; `qty` repeats the job.

## ZPL (Zebra and compatible label printers)

```ts
const zpl = "^XA^FO50,50^A0N,50,50^FDOrder 1042^FS^FO50,120^BCN,100,Y,N,N^FD1042^FS^XZ";
await ir.printJobs.create(
  { printerId: labelPrinterId, title: "Label 1042", contentType: "raw_base64", content: Buffer.from(zpl, "ascii").toString("base64") },
  { idempotencyKey: "order-1042-label" },
);
```

Every label starts with `^XA` and ends with `^XZ`; without `^XZ` the printer waits for more data. Carrier labels that arrive as ZPL (many shipping APIs return them base64 encoded) can be sent as they are with `raw_base64`. Carrier labels that arrive as PDF go through `pdf_base64` to a printer with a driver.

## ESC/POS (receipt printers)

```python
import base64
data = b"\x1b@"                      # initialize
data += b"\x1ba\x01" + b"Thank you\n" # centre, text
data += b"\x1ba\x00" + b"Total 12.50\n"
data += b"\n\n\n" + b"\x1dV\x00"      # feed and full cut
ir.print_jobs.create({"printerId": receipt_printer_id, "title": "Receipt 77", "contentType": "raw_base64",
                      "content": base64.b64encode(data).decode()})
```

- Build bytes, not text. Text uses the printer's code page: select it with `ESC t n` and encode yourself, for example `"é".encode("cp858")`. Do not send UTF-8 unless the printer is set to it.
- Receipt printers print only after a line feed and never cut on their own.

## Printer queue setup

- Windows: the agent writes with the `RAW` datatype. Use the printer's own driver or "Generic / Text Only". Add network-shared printers as local TCP/IP printers (the service runs as LocalSystem and cannot see per-user `\\server\printer` connections).
- macOS and Linux: the agent submits `application/vnd.cups-raw`. Create a raw CUPS queue: `lpadmin -p NAME -E -v DEVICE_URI -m raw`.

## Test without hardware

With an `ir_test_` key, "Test Receipt 80mm" accepts ESC/POS and "Test Label 4x6" accepts ZPL. Both finish in about 3 seconds.
