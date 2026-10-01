const $ = (id) => document.getElementById(id);
const DEFAULT_ENDPOINT = ''; // set below by the user; no endpoint is baked in
const EYE = '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>';
const EYE_OFF = '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>';

let saveTimer = null;

function pill(el, kind, text) { el.className = `pill ${kind}`; el.textContent = text; el.hidden = false; }
const isOn = (el) => el.getAttribute('aria-checked') === 'true';
const setSwitch = (el, on) => el.setAttribute('aria-checked', on ? 'true' : 'false');

function renderToken() {
  const has = !!$('token').value.trim();
  pill($('tokenPill'), has ? 'ok' : 'warn', has ? 'Token set' : 'No token');
}

function markDirty() {
  clearTimeout(saveTimer);
  pill($('saveState'), 'warn', 'Unsaved changes');
}

async function load() {
  const d = await chrome.storage.sync.get({ endpoint: DEFAULT_ENDPOINT, token: '', workspace: '', autoRecord: true, recordVideo: false });
  $('endpoint').value = d.endpoint || DEFAULT_ENDPOINT;
  $('token').value = d.token;
  $('workspace').value = d.workspace;
  setSwitch($('autoRecord'), d.autoRecord);
  setSwitch($('recordVideo'), d.recordVideo);
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  $('revealIcon').innerHTML = EYE;
  renderToken();
}

for (const id of ['endpoint', 'token', 'workspace']) {
  $(id).addEventListener('input', () => { markDirty(); if (id === 'token') renderToken(); });
}
for (const id of ['autoRecord', 'recordVideo']) {
  $(id).addEventListener('click', () => { setSwitch($(id), !isOn($(id))); markDirty(); });
}

$('reveal').addEventListener('click', () => {
  const show = $('token').type === 'password';
  $('token').type = show ? 'text' : 'password';
  $('revealIcon').innerHTML = show ? EYE_OFF : EYE;
  $('reveal').setAttribute('aria-label', show ? 'Hide token' : 'Show token');
  $('reveal').title = show ? 'Hide token' : 'Show token';
});

$('save').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    endpoint: $('endpoint').value.trim() || DEFAULT_ENDPOINT,
    token: $('token').value.trim(),
    workspace: $('workspace').value.trim(),
    autoRecord: isOn($('autoRecord')),
    recordVideo: isOn($('recordVideo'))
  });
  pill($('saveState'), 'ok', 'Saved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { $('saveState').hidden = true; }, 2000);
});

// Microphone: show the real permission state, not just the result of the last click.
function renderMic(state) {
  // Automatic recordings take your voice from the call's own mic, so this only matters for
  // recordings started from the popup.
  if (state === 'granted') {
    pill($('micPill'), 'ok', 'Granted');
    $('mic').hidden = true;
    $('micText').textContent = 'Automatic recordings use the call\'s own mic. This is only for recordings you start from the popup, and it is granted.';
  } else if (state === 'denied') {
    pill($('micPill'), 'bad', 'Blocked');
    $('mic').hidden = true;
    $('micText').textContent = 'Automatic recordings are unaffected. Popup recordings will only capture everyone else until you allow the mic for this extension in Chrome settings.';
  } else {
    pill($('micPill'), 'muted', 'Not needed yet');
    $('mic').hidden = false;
    $('micText').textContent = 'Automatic recordings use the call\'s own mic. Grant this only if you also want your voice in recordings you start from the popup.';
  }
}

async function watchMic() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    renderMic(status.state);
    status.onchange = () => renderMic(status.state);
  } catch (_) {
    renderMic('prompt');
  }
}

$('mic').addEventListener('click', async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    renderMic('granted');
  } catch (e) {
    renderMic(e && e.name === 'NotAllowedError' ? 'denied' : 'prompt');
  }
});

load();
watchMic();
