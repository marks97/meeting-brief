# Meeting Capture extension

Auto-records web meetings and drops the audio into a private S3 inbox, so `meeting-brief`
can transcribe, archive and brief without anyone phone-recording. Install once, paste a
token, forget it.

```
meeting page    ->  capture.main.js (inside the page) mixes the call's remote audio tracks
                    + your mic track, records webm/opus, 5 s chunks
                ->  content.js -> background -> offscreen document holds the chunks
call ends       ->  POST meta to presign endpoint (token)  ->  presigned S3 PUT
                ->  s3://<inbox>/inbox/<workspace>/<ts>-<title>.webm  (+ .json sidecar)
meeting-brief   <-  ingest.sh list / pull  ->  ffmpeg -> m4a -> transcribe.sh -> arch/
```

The browser only ever holds the **token**, never AWS credentials.

### Why the recorder lives inside the page

`chrome.tabCapture` only works after the user clicks the extension on that tab, so it can
never start a recording on its own. v0.1/0.2 relied on it and silently recorded nothing on a
real call (2026-10-01). From v0.3 the automatic path never touches tab capture:
`capture.main.js` is a `world: MAIN` content script at `document_start`, so it wraps
`RTCPeerConnection` and `getUserMedia` before Meet's own scripts run. Remote audio tracks
(everyone else) and the mic track (you) are mixed with Web Audio into a `MediaRecorder`.
Recording starts when a peer connection is connected with live remote audio, and stops 1 s
after the connections close (15 s grace for a network blip). Tab closed or page stalled: the
background uploads what already arrived (`tabs.onRemoved`, a 30 s `alarms` watchdog). The
popup's manual Start still uses tab capture, which is the only way to record video.

Proven end to end on 2026-10-01 with Chromium + the unpacked extension on a real WebRTC call
(remote 440 Hz tone over a peer connection, 1200 Hz fake mic): both tones present every
second of the upload, tab-close mid-call uploads what was captured, auto-record off records
nothing. Rebuild the harness from this description if the recorder changes. Confirmed on a
real Google Meet call the same day: automatic start with no click (even alone), mic captured,
`reason: call_ended` on hang-up, Scribe transcript clean. Zoom web / Teams web not yet
confirmed live.

## Pieces

| Path | What |
|---|---|
| `extension/` | the MV3 browser extension (this folder) |
| `../ingest/presign-lambda/` | token-gated presign endpoint (Lambda + API Gateway) |
| `../ingest/ingest.sh` | list / pull / delete recordings in the inbox, for the skill to process |

## 1. Deploy the backend (once)

Needs AWS creds for your account in the shell and `aws`, `node`, `npm`, `zip`.

```bash
cd ../ingest/presign-lambda
BUCKET=your-meeting-inbox TOKEN="$(openssl rand -hex 24)" ./deploy.sh
```

It creates a private inbox bucket (public access fully blocked), the function, and an
API Gateway HTTP API, then prints the **Endpoint URL** and **token** to paste into the
extension. (It uses an HTTP API rather than a Lambda Function URL because function URLs with
auth NONE are rejected at the edge in some accounts.)

After deploy, `POST /api` presigns and `GET /extension` downloads this folder as a zip
(rebuilt on every `deploy.sh`). Only the presign call and the zip go through the endpoint;
recordings PUT straight to S3. The bucket's S3 CORS allows the extension's PUT. You can
optionally front the endpoint with your own custom domain.

The token is stored in the Lambda env and can be read back with:
`aws lambda get-function-configuration --function-name meeting-capture-presign --query 'Environment.Variables.UPLOAD_TOKEN' --output text`.

## 2. Load the extension

1. In a terminal: `curl -fsSL <your-endpoint>/install | sh`. It puts the extension in
   `~/Library/Application Support/Meeting Capture/extension` (Linux: `~/.local/share/meeting-capture/extension`),
   never Downloads, and copies that path to the clipboard. Chrome loads an unpacked extension
   from its folder, so that folder must stay put; the same command later updates it in place.
2. Chrome/Edge -> `chrome://extensions` -> enable **Developer mode** -> **Load unpacked** -> `Cmd+Shift+G`, paste, Open.
   Loaded unpacked from a stable folder, the extension keeps the same ID across updates and
   moves, so settings survive.
3. Open the extension **Options**:
   - **Endpoint URL**: paste the endpoint from step 1 (its `/api` path), plus the **Upload token**.
   - **Default workspace tag**, e.g. `my-project` (routes into that project's `arch/`; can be re-routed at ingest time).
   - Click **Grant microphone access** once (needed so your voice is captured; tab audio works without it).
   - Leave **Auto-record** on.

## 3. Use it

Join a Google Meet call. The badge shows **REC**. Leave the call and it uploads. That's it.

- **Auto-start caveat:** Chrome sometimes requires a user gesture to begin tab capture. If auto-start is blocked you get a "Click to record" notification and a `!` badge, open the popup and press **Start** once. Everything else (mixing, stop-on-leave, upload) is automatic.
- **Manual control:** the popup has Start / Stop for any call, including a tab the content script does not auto-detect.

## 4. Ingest (the skill side)

See `meeting-brief`'s SKILL.md, "Flow C". In short:

```bash
export MEETING_INBOX_BUCKET=your-meeting-inbox
export MEETING_INBOX_ENV=/path/to/a/.env/with/aws/creds   # if not in ambient env
../ingest/ingest.sh list
../ingest/ingest.sh pull inbox/my-project/<file>.webm /tmp/claude/<project>/meeting-in
#   -> run transcribe.sh on the .webm, archive per the sidecar's workspace, then:
../ingest/ingest.sh done inbox/my-project/<file>.webm
```

## Platforms

- **Auto-detected (join/leave, hands-off):** Google Meet, **Zoom web client** (`app.zoom.us/wc/...`), **Teams web** (`teams.microsoft.com`, `teams.live.com`). All three are granted at install and share one `content.js`; the per-platform signals live in its `PLATFORMS` map, so a vendor reskin is a one-spot fix.
- **Works via popup Start:** any other browser call (Whereby etc.) once you grant the host.
- **Does not work:** the native desktop Zoom / Teams apps. A browser extension cannot see audio outside the browser; that would need a separate desktop recorder.

## Audio vs video

Default is **audio only** (all the transcript needs, ~15-25 MB/hour). Turn on **Record video** in Options to also capture the tab's video (grid / screen-share) as webm; expect hundreds of MB for a long call. On ingest, video clips get their audio extracted for transcription (see SKILL.md Flow C) and the video is kept only if you want to rewatch it.

## UI

The popup and options page share one small design system in `ui.css`: tokens in both themes
(follows the system theme), self-hosted Geist / Geist Mono in `fonts/`, cards with no shadow,
mono for every number, id and path. The mark is a record dot on a `--pri` rounded square, and
the wordmark is `meet` in Geist Mono. Toolbar icons are generated, not drawn by hand:
`node .claude/skills/meeting-brief/scripts/extension-icons.mjs` writes `icons/icon-*.png`
(idle, blue) and `icons/rec-*.png` (recording, red; `background.js` swaps them in). Bump
`manifest.json`'s `version` on every UI change so the installed build is identifiable in
Options.

## Notes / limits

- Meet's DOM is obfuscated and shifts; join/leave detection lives in `content.js` `CONFIG` so it is a one-line fix when it drifts. The popup is the always-works fallback.
- Recording is mono-ish opus at 48 kbps: a 1 h call is roughly 15-25 MB.
- Chunks flush every 5 s (`timeslice`), so a browser crash loses seconds, not the meeting, up to the last flush held in the offscreen page.
- Recording other participants may need disclosure depending on where they are. That is on the operator.
