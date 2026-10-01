// Service worker: owns the recording session and wires the pieces together.
//
// Two ways a recording starts:
//   page  automatic. capture.main.js records inside the meeting page and streams 5 s chunks
//         here via content.js; they are parked in the offscreen document, which survives the
//         tab closing, and uploaded when the call ends.
//   tab   manual, from the popup's Start. chrome.tabCapture, which Chrome only allows after a
//         click on the extension, and is the only way to also record video.
// The session is mirrored into chrome.storage.session so a worker restart mid-call (MV3
// workers are evicted when idle) loses nothing.

const OFFSCREEN_PATH = 'offscreen.html';
const DEFAULT_ENDPOINT = ''; // set on the Options page; no endpoint is baked in
const WATCHDOG = 'mc-watchdog';
const ICONS = {
  idle: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  rec: { 16: 'icons/rec-16.png', 32: 'icons/rec-32.png', 48: 'icons/rec-48.png', 128: 'icons/rec-128.png' }
};

// { id, mode: 'page'|'tab', tabId, startedAt, meta, micCaptured, video, lastChunkAt }
let active = null;
let uploading = null; // the session being uploaded, for the popup
let creating = null;

async function getActive() {
  if (active) return active;
  try { active = (await chrome.storage.session.get('active')).active || null; } catch (_) {}
  return active;
}
async function setActive(a) {
  active = a;
  try { a ? await chrome.storage.session.set({ active: a }) : await chrome.storage.session.remove('active'); } catch (_) {}
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'BLOBS'],
      justification: 'Hold meeting audio until the call ends, record manual tab captures, and upload.'
    }).finally(() => { creating = null; });
  }
  await creating;
}
async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

async function getConfig() {
  const d = await chrome.storage.sync.get({
    endpoint: DEFAULT_ENDPOINT, token: '', workspace: '', autoRecord: true, recordVideo: false
  });
  if (!d.endpoint) d.endpoint = DEFAULT_ENDPOINT;
  return d;
}

function setRecordingUi(on) {
  try { chrome.action.setIcon({ path: on ? ICONS.rec : ICONS.idle }); } catch (_) {}
  try {
    chrome.action.setBadgeText({ text: on ? 'REC' : '' });
    if (on) chrome.action.setBadgeBackgroundColor({ color: '#C0332E' });
  } catch (_) {}
}

function notify(title, message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon-128.png', title, message }); } catch (_) {}
}

// Later meta wins field by field, but never overwrites with an empty value: Meet only shows
// the call's title after you join, while participants may only be scraped at the start.
function mergeMeta(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (Array.isArray(v) ? v.length : v && v !== 'meeting') out[k] = v;
  }
  return out;
}

// --- page mode (automatic) ---------------------------------------------------------------
async function pageStart(tabId, meta, mic) {
  if (await getActive()) return { ok: false, error: 'already_recording' };
  const a = { id: crypto.randomUUID(), mode: 'page', tabId, startedAt: new Date().toISOString(), meta: meta || {}, micCaptured: !!mic, video: false, lastChunkAt: Date.now() };
  await setActive(a);
  await toOffscreen({ type: 'SESSION_START', id: a.id });
  setRecordingUi(true);
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  return { ok: true };
}

async function pageChunk(tabId, seq, b64) {
  const a = await getActive();
  if (!a || a.mode !== 'page' || a.tabId !== tabId) return;
  a.lastChunkAt = Date.now();
  await setActive(a);
  await toOffscreen({ type: 'SESSION_CHUNK', id: a.id, seq, b64 });
}

// --- tab mode (manual Start in the popup) ------------------------------------------------
async function tabStart(tabId, meta) {
  const cfg = await getConfig();
  if (!cfg.token) return { ok: false, error: 'not_configured' };
  if (await getActive()) return { ok: false, error: 'already_recording' };
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    return { ok: false, error: 'capture_blocked', detail: String(e) };
  }
  const startedAt = new Date().toISOString();
  const a = { id: crypto.randomUUID(), mode: 'tab', tabId, startedAt, meta: meta || {}, micCaptured: false, video: !!cfg.recordVideo };
  await setActive(a);
  const res = await toOffscreen({
    type: 'START_RECORDING', streamId, startedAt, recordVideo: !!cfg.recordVideo,
    meta: { ...meta, workspace: cfg.workspace, startedAt }
  });
  if (res && res.ok) {
    a.micCaptured = !!res.micCaptured;
    await setActive(a);
    setRecordingUi(true);
  } else {
    await setActive(null);
    notify('Recording failed to start', (res && res.error) || 'unknown');
  }
  return res || { ok: false };
}

// --- ending, for both modes --------------------------------------------------------------
async function finalize(a, reason, extra = {}) {
  await setActive(null); // first, so a second end signal (tab closing after hang-up) is a no-op
  chrome.alarms.clear(WATCHDOG);
  setRecordingUi(false);
  uploading = a;
  const cfg = await getConfig();
  const meta = {
    ...mergeMeta(a.meta, extra.meta),
    workspace: cfg.workspace, startedAt: a.startedAt, endedAt: new Date().toISOString(),
    reason, micCaptured: a.micCaptured, capture: a.mode
  };
  const upload = { endpoint: cfg.endpoint, token: cfg.token };
  let res;
  try {
    res = a.mode === 'page'
      ? await toOffscreen({ type: 'SESSION_FINALIZE', id: a.id, chunks: extra.chunks, meta, upload })
      : await toOffscreen({ type: 'STOP_RECORDING', endedAt: meta.endedAt, reason, upload });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  uploading = null;

  const lastUpload = {
    ok: !!(res && res.ok), key: res && res.key, bytes: res && res.bytes,
    error: res && res.ok ? null : (res && res.error) || 'unknown',
    title: meta.title, at: Date.now()
  };
  try { await chrome.storage.local.set({ lastUpload }); } catch (_) {}
  if (lastUpload.ok) notify('Meeting uploaded', `${meta.title || 'Recording'} · ${Math.max(1, Math.round((lastUpload.bytes || 0) / 1024))} KB`);
  else notify('Meeting upload failed', lastUpload.error);
  return res;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target && msg.target !== 'background') return;
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    switch (msg.type) {
      case 'REC_START':
        sendResponse(await pageStart(tabId, msg.meta, msg.mic));
        return;
      case 'REC_CHUNK':
        await pageChunk(tabId, msg.seq, msg.b64);
        sendResponse({ ok: true });
        return;
      case 'REC_END': {
        const a = await getActive();
        sendResponse(a && a.mode === 'page' && a.tabId === tabId ? await finalize(a, 'call_ended', { chunks: msg.chunks, meta: msg.meta }) : { ok: false });
        return;
      }
      case 'REC_ERROR':
        notify('Meeting Capture could not record', msg.error || 'unknown');
        sendResponse({ ok: true });
        return;
      case 'UPLOAD_PROGRESS': // offscreen pings during long uploads so this worker stays alive
        sendResponse({ ok: true });
        return;
      case 'POPUP_START': {
        let meta = {};
        try { meta = (await chrome.tabs.sendMessage(msg.tabId, { type: 'GET_META' })) || {}; } catch (_) {}
        sendResponse(await tabStart(msg.tabId, meta));
        return;
      }
      case 'POPUP_STOP': {
        const a = await getActive();
        if (!a) { sendResponse({ ok: false, error: 'not_recording' }); return; }
        if (a.mode === 'page') {
          // Ask the page to stop so its last chunk is flushed; if the tab cannot answer,
          // finalize with what has already arrived.
          try { await chrome.tabs.sendMessage(a.tabId, { type: 'STOP_PAGE' }); sendResponse({ ok: true }); }
          catch (_) { sendResponse(await finalize(a, 'manual')); }
        } else {
          sendResponse(await finalize(a, 'manual'));
        }
        return;
      }
      case 'POPUP_STATUS': {
        const a = await getActive();
        sendResponse({ phase: uploading ? 'uploading' : a ? 'recording' : 'idle', active: a || uploading, needsClick: null });
        return;
      }
      default:
    }
  })();
  return true; // async response
});

// The tab closed mid-call: upload what arrived (at most the last 5 s is lost).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const a = await getActive();
  if (a && a.tabId === tabId) finalize(a, 'tab_closed');
});

// The page stopped sending chunks without a clean end (navigated away, crashed, slept).
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG) return;
  const a = await getActive();
  if (!a) { chrome.alarms.clear(WATCHDOG); return; }
  if (a.mode === 'page' && Date.now() - (a.lastChunkAt || 0) > 25000) finalize(a, 'stalled');
});
