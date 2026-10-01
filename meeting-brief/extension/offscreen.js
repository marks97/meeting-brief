// Offscreen document. Two jobs:
//
// 1. Automatic recordings (page mode): the meeting page records itself (capture.main.js) and
//    its 5 s chunks are parked here, keyed by session, until the call ends. This document
//    outlives the meeting tab, so closing the tab mid-call still uploads what was captured.
//
// 2. Manual recordings (tab mode, popup Start): captures tab audio (everyone else on the call)
//    + the microphone (you), mixes the audio, optionally includes the tab's video, records to
//    webm. On a web call your own mic is sent OUT to the call, not played back into your tab,
//    so tab audio = remote participants and mic = you; both are needed for a transcript.
//
// Either way it uploads on stop.

// --- page mode: chunk store ----------------------------------------------------------------
const sessions = new Map(); // id -> Map(seq -> Uint8Array)

function sessionFor(id) {
  if (!sessions.has(id)) sessions.set(id, new Map());
  return sessions.get(id);
}

function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

async function finalizeSession({ id, chunks, meta, upload }) {
  const parts = sessionFor(id);
  // The end signal can overtake the last chunk on the way here; wait briefly for it.
  const deadline = Date.now() + 5000;
  while (chunks && parts.size < chunks && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  sessions.delete(id);
  if (!parts.size) return { ok: false, error: 'no audio was captured' };

  const ordered = [...parts.keys()].sort((a, b) => a - b).map((k) => parts.get(k));
  const blob = new Blob(ordered, { type: 'audio/webm' });
  const full = { ...meta, bytes: blob.size, contentType: 'audio/webm', chunks: ordered.length };
  try {
    const key = await uploadBlob(blob, full, upload);
    return { ok: true, key, bytes: blob.size };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), bytes: blob.size };
  }
}

// --- tab mode: manual capture --------------------------------------------------------------

let recorder = null;
let chunks = [];
let audioCtx = null;
let tabStream = null;
let micStream = null;
let current = null; // { meta, startedAt, contentType }
let micCaptured = false;

function pickMime(video) {
  const cands = video
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  for (const c of cands) if (MediaRecorder.isTypeSupported(c)) return c;
  return video ? 'video/webm' : 'audio/webm';
}

async function startRecording({ streamId, startedAt, meta, recordVideo }) {
  if (recorder) return { ok: false, error: 'already_recording' };
  chunks = [];
  micCaptured = false;
  const wantVideo = !!recordVideo;

  // 1. Tab capture: audio always, video too when requested (one getUserMedia, same id).
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: wantVideo ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } : false
  });

  // 2. Microphone. Needs the mic grant to already exist (options page establishes it).
  //    If absent we record tab-only rather than failing the whole meeting.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    micCaptured = true;
  } catch (e) {
    micStream = null;
  }

  // 3. Mix audio into one destination the recorder reads.
  audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  if (tabStream.getAudioTracks().length) {
    const tabSrc = audioCtx.createMediaStreamSource(new MediaStream(tabStream.getAudioTracks()));
    tabSrc.connect(dest);
    tabSrc.connect(audioCtx.destination); // keep the call audible; tab capture would mute it
  }
  if (micStream) {
    const micSrc = audioCtx.createMediaStreamSource(micStream);
    micSrc.connect(dest); // mic to recording only, never to speakers (would echo you back)
  }

  // 4. Assemble the recorded stream: mixed audio, plus the tab video track when wanted.
  const tracks = [dest.stream.getAudioTracks()[0]];
  if (wantVideo && tabStream.getVideoTracks()[0]) tracks.unshift(tabStream.getVideoTracks()[0]);
  const outStream = new MediaStream(tracks);

  const contentType = wantVideo ? 'video/webm' : 'audio/webm';
  const opts = { mimeType: pickMime(wantVideo), audioBitsPerSecond: 48000 };
  if (wantVideo) opts.videoBitsPerSecond = 1500000;
  recorder = new MediaRecorder(outStream, opts);
  recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  recorder.start(5000); // flush every 5s so a crash loses seconds, not the meeting

  current = { meta, startedAt, contentType };
  return { ok: true, micCaptured, video: wantVideo };
}

function teardown() {
  try { tabStream && tabStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { audioCtx && audioCtx.close(); } catch (_) {}
  tabStream = micStream = audioCtx = null;
}

async function stopRecording({ endedAt, reason, upload }) {
  if (!recorder) return { ok: false, error: 'not_recording' };
  const contentType = current.contentType;

  const blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: contentType }));
    recorder.stop();
  });
  teardown();
  recorder = null;

  const meta = {
    ...current.meta,
    startedAt: current.startedAt,
    endedAt,
    reason,
    micCaptured,
    durationMs: Date.parse(endedAt) - Date.parse(current.startedAt),
    bytes: blob.size,
    contentType
  };
  current = null;

  try {
    const key = await uploadBlob(blob, meta, upload);
    return { ok: true, key, bytes: blob.size };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), bytes: blob.size };
  }
}

// Two-step upload: ask our endpoint to presign a PUT (and stash the sidecar), then PUT
// the media straight to S3. The browser never holds AWS credentials, only the token.
async function uploadBlob(blob, meta, upload) {
  const presignRes = await fetch(upload.endpoint, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + upload.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace: meta.workspace || '',
      filename: suggestName(meta),
      contentType: meta.contentType,
      bytes: meta.bytes,
      meta
    })
  });
  if (!presignRes.ok) throw new Error('presign ' + presignRes.status + ': ' + (await presignRes.text()).slice(0, 200));
  const { putUrl, key } = await presignRes.json();
  if (!putUrl) throw new Error('presign returned no putUrl');

  // A long upload must not outlive the service worker that is waiting on it.
  const ping = setInterval(() => { chrome.runtime.sendMessage({ target: 'background', type: 'UPLOAD_PROGRESS' }).catch(() => {}); }, 10000);
  try {
    const putRes = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': meta.contentType }, body: blob });
    if (!putRes.ok) throw new Error('s3 put ' + putRes.status);
  } finally {
    clearInterval(ping);
  }
  return key;
}

function suggestName(meta) {
  const ts = (meta.startedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const slug = (meta.title || 'meeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'meeting';
  return `${ts}-${slug}.webm`; // webm container for both audio-only and video
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  (async () => {
    if (msg.type === 'SESSION_START') { sessionFor(msg.id); sendResponse({ ok: true }); }
    else if (msg.type === 'SESSION_CHUNK') { sessionFor(msg.id).set(msg.seq, fromBase64(msg.b64)); sendResponse({ ok: true }); }
    else if (msg.type === 'SESSION_FINALIZE') sendResponse(await finalizeSession(msg));
    else if (msg.type === 'START_RECORDING') sendResponse(await startRecording(msg));
    else if (msg.type === 'STOP_RECORDING') sendResponse(await stopRecording(msg));
  })();
  return true;
});
