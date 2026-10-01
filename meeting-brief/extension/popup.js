const $ = (id) => document.getElementById(id);

const PLATFORM = { 'google-meet': 'Google Meet', zoom: 'Zoom', teams: 'Microsoft Teams' };
const ICON = {
  ok: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  bad: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  micOff: '<line x1="2" x2="22" y1="2" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  audio: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>'
};
const svg = (paths) => `<svg class="icon" viewBox="0 0 24 24">${paths}</svg>`;

let tab = null;
let state = { phase: 'idle', active: null, needsClick: null };
let timer = null;

const fmtBytes = (n) => !n ? '0 KB' : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
// inbox/<ws>/<iso-ts>-<slug>.webm -> "inbox/<ws> · <slug>.webm" (a key format we write).
function shortKey(key) {
  const [, ws, file] = String(key || '').split('/');
  if (!file) return key || '';
  return `inbox/${ws} · ${file.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, '')}`;
}
function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map((v) => String(v).padStart(2, '0')).join(':');
}

function setStatus(kind, text, live) {
  $('status').className = `pill ${kind}`;
  $('statusText').textContent = text;
  $('statusDot').className = live ? 'dot live' : 'dot';
}

async function render() {
  const cfg = await chrome.storage.sync.get({ token: '', workspace: '', autoRecord: true, recordVideo: false });
  const { lastUpload } = await chrome.storage.local.get('lastUpload');
  let meta = null;
  if (tab) { try { meta = await chrome.tabs.sendMessage(tab.id, { type: 'GET_META' }); } catch (_) {} }

  const recording = state.phase === 'recording';
  const uploading = state.phase === 'uploading';

  // Header
  $('mark').className = recording ? 'mark s26 rec' : 'mark s26';
  if (recording) setStatus('bad', 'Recording', true);
  else if (uploading) setStatus('pri', 'Uploading', true);
  else if (state.needsClick) setStatus('warn', 'Needs a click', false);
  else setStatus('muted', 'Idle', false);

  $('setupNote').hidden = !!cfg.token;
  $('clickNote').hidden = !(state.needsClick && tab && state.needsClick.tabId === tab.id && !recording);

  // This tab
  $('tabCard').hidden = recording || uploading;
  if (meta && meta.platform && PLATFORM[meta.platform]) {
    $('tabPlatform').textContent = PLATFORM[meta.platform];
    $('tabCode').textContent = meta.code || '';
    $('tabTitle').textContent = meta.title || 'Untitled call';
    $('tabHint').textContent = !cfg.autoRecord
      ? 'Auto-record is off. Press Start to record this call.'
      : meta.inCall
        ? 'In a call. Recording starts on its own once audio flows.'
        : 'Recording starts on its own when you join.';
  } else {
    $('tabPlatform').textContent = 'This tab';
    $('tabCode').textContent = '';
    $('tabTitle').textContent = tab && tab.title ? tab.title : 'Not a call';
    $('tabHint').textContent = 'Not a Meet, Zoom or Teams call. Start records this tab anyway.';
  }

  // Recording card
  $('recCard').hidden = !(recording || uploading);
  if (recording || uploading) {
    const a = state.active || {};
    $('recLabel').textContent = uploading ? 'Uploading' : 'Recording';
    $('timer').hidden = uploading;
    $('recTitle').textContent = uploading
      ? `${(a.meta && a.meta.title) || 'Call'} · keep Chrome open until it finishes`
      : (a.meta && a.meta.title) || 'Call';
    $('recTitle').style.whiteSpace = uploading ? 'normal' : '';
    $('micChip').className = a.micCaptured ? 'pill ok' : 'pill warn';
    $('micChip').innerHTML = a.micCaptured ? `${svg(ICON.mic)}Mic on` : `${svg(ICON.micOff)}No mic`;
    $('mediaChip').innerHTML = a.video ? `${svg(ICON.video)}Video` : `${svg(ICON.audio)}Audio`;
    clearInterval(timer);
    const tick = () => { $('timer').textContent = clock(Date.now() - Date.parse(a.startedAt)); };
    if (a.startedAt && recording) { tick(); timer = setInterval(tick, 1000); }
  } else {
    clearInterval(timer);
  }

  // Actions
  $('start').hidden = recording || uploading;
  $('start').disabled = !cfg.token;
  $('stop').hidden = !recording;

  // Last upload
  if (lastUpload && !recording && !uploading) {
    $('lastNote').hidden = false;
    $('lastNote').className = `note ${lastUpload.ok ? 'ok' : 'bad'}`;
    $('lastIcon').innerHTML = lastUpload.ok ? ICON.ok : ICON.bad;
    $('lastHead').textContent = lastUpload.ok
      ? `Uploaded ${fmtBytes(lastUpload.bytes)} · ${ago(lastUpload.at)}`
      : `Upload failed · ${ago(lastUpload.at)}`;
    $('lastSub').textContent = lastUpload.ok ? shortKey(lastUpload.key) : (lastUpload.error || '');
  } else {
    $('lastNote').hidden = true;
  }

  // Footer
  $('foot').textContent = `${cfg.workspace || 'no workspace'} · auto ${cfg.autoRecord ? 'on' : 'off'}`;
}

async function refresh() {
  try { state = (await chrome.runtime.sendMessage({ target: 'background', type: 'POPUP_STATUS' })) || state; } catch (_) {}
  await render();
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'POPUP_START', tabId: tab.id });
  if (!res || !res.ok) {
    await chrome.storage.local.set({ lastUpload: { ok: false, error: `Could not start: ${(res && res.error) || 'unknown'}`, at: Date.now() } });
  }
  refresh();
});

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  state.phase = 'uploading';
  render();
  await chrome.runtime.sendMessage({ target: 'background', type: 'POPUP_STOP' });
  $('stop').disabled = false;
  refresh();
});

$('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
  setInterval(refresh, 2000);
})();
