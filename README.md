# PocketBase GIF Listener

Listens in real-time to the `captures` collection on PocketBase and generates animated GIFs from images captured by four unique cameras, grouped by a time window (first capture timestamp + 5 seconds).

## What this does
- Subscribes to real-time `create` events from the `captures` collection.
- Buffers incoming records per time-based group (anchored at the first capture's timestamp) and per device.
- Waits up to 5 seconds from the first entry in a group for all four device IDs (`esp32s3cam-01` to `esp32s3cam-04`).
- If complete, fetches image files, builds a ping-pong GIF (1→4→1), saves to `output/`, and logs a JSON result.
- On timeout or error, logs a JSON entry with `status: timeout|error` and details.

## Setup
1. Install Node.js 18+.
2. Install dependencies:

```powershell
npm install
```

3. Optional: Create a `.env` to override defaults.

```
POCKETBASE_URL=https://cameradb.jakobgrote.de
OUTPUT_DIR=output
FRAME_DELAY_MS=120
TIMEOUT_MS=5000
LOG_LEVEL=info
```

## Run
```powershell
npm start
```

GIFs are saved under `output/` with names like `gif_20240618142342_20240618_142342.gif` (timestamp-based). If a file conflict exists, a numeric suffix is appended.

## Notes
- Only processes device IDs: esp32s3cam-01..04.
- Ignores existing records; only listens for new `create` events.
- Uses `sharp` to normalize frames and `gif-encoder-2` to assemble the GIF.

### JSON log schema per attempt
```
{
	"timestamp_group": "2024-06-18T14:23:42Z", // ISO timestamp of the group's first entry
	"record_ids": ["rec_1", "rec_2", "rec_3", "rec_4"],
	"device_ids": ["esp32s3cam-01", "esp32s3cam-02", "esp32s3cam-03", "esp32s3cam-04"],
	"gif_path": "./output/gif_20240618_142342_20240618_142342.gif",
	"status": "created" // or "timeout" | "error"
}
```
