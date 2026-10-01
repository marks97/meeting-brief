// Isolated-world content script for Meet, Zoom web and Teams web.
//
// The recording itself happens in capture.main.js, inside the page. This script is the bridge:
// it tells the page recorder whether it may record (auto-record on and a token set), relays
// its audio chunks to the extension (window.postMessage in, chrome.runtime out), and reads the
// call's title and in-call state for the popup.

const TAG = '__meetingCapture';

const PLATFORMS = {
  'google-meet': {
    match: (h) => h === 'meet.google.com',
    // Joined call lives at meet.google.com/xxx-xxxx-xxx (the meeting code).
    inCall: () => {
      if (!/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(\b|$)/i.test(location.pathname)) return false;
      return hasAny([
        'button[aria-label*="Leave call" i]',
        'button[aria-label*="Abandonar" i]',
        'div[data-meeting-code]',
        'div[jscontroller][data-call-start-time]'
      ]) || /^\s*Meet\s*[-–]\s*\S/.test(document.title);
    },
    code: () => (location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i) || [])[1] || '',
    title: () => document.title.replace(/^\s*Meet\s*[-–]\s*/, '').trim()
  },
  'zoom': {
    match: (h) => /(^|\.)zoom\.us$/.test(h),
    // Zoom web client runs under /wc/ (e.g. app.zoom.us/wc/<id>/start).
    inCall: () => location.pathname.includes('/wc/') && hasAny([
      'button[aria-label*="Leave" i]',
      '.footer-button__leave',
      '#wc-footer',
      'button[aria-label*="End" i][aria-label*="meeting" i]'
    ]),
    code: () => (location.pathname.match(/\/wc\/(\d+)/) || [])[1] || '',
    title: () => (document.title || 'Zoom meeting').replace(/\s*[-–]\s*Zoom.*$/i, '').trim() || 'Zoom meeting'
  },
  'teams': {
    match: (h) => h === 'teams.microsoft.com' || h === 'teams.live.com',
    inCall: () => hasAny([
      'button[aria-label*="Leave" i]',
      '#hangup-button',
      '[data-tid="call-end"]',
      '[data-tid="toggle-mute"]',
      '[data-tid="call-roster-button"]'
    ]),
    code: () => '',
    title: () => (document.title || 'Teams meeting').replace(/\s*\|\s*Microsoft Teams.*$/i, '').trim() || 'Teams meeting'
  }
};

function hasAny(selectors) {
  for (const sel of selectors) { try { if (document.querySelector(sel)) return true; } catch (_) {} }
  return false;
}

const platformName = Object.keys(PLATFORMS).find((k) => PLATFORMS[k].match(location.hostname)) || null;
const P = platformName ? PLATFORMS[platformName] : null;

let inCall = false;

function scrapeMeta() {
  let title = '';
  let code = '';
  try { title = (P && P.title()) || document.title || ''; } catch (_) {}
  try { code = (P && P.code()) || ''; } catch (_) {}
  const participants = [];
  try {
    document.querySelectorAll('[data-tid="roster-participant-name"], [role="listitem"] [data-self-name], [role="list"] span[dir="auto"]').forEach((el) => {
      const t = (el.textContent || '').trim();
      if (t && t.length < 60 && !participants.includes(t)) participants.push(t);
    });
  } catch (_) {}
  return { platform: platformName || 'web', code, url: location.href, title: title || code || 'meeting', participants: participants.slice(0, 25) };
}

// --- settings -> page recorder ---------------------------------------------------------------
async function pushConfig() {
  const d = await chrome.storage.sync.get({ autoRecord: true, token: '' });
  window.postMessage({ [TAG]: 'ext', type: 'config', armed: !!(d.autoRecord && d.token) }, '*');
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.autoRecord || changes.token)) pushConfig();
});
pushConfig();

// --- page recorder -> extension --------------------------------------------------------------
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const send = (msg) => { try { chrome.runtime.sendMessage({ target: 'background', ...msg }); } catch (_) {} };

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data[TAG] !== 'page') return;
  const m = e.data;
  if (m.type === 'start') send({ type: 'REC_START', meta: scrapeMeta(), mic: !!m.mic });
  else if (m.type === 'chunk') send({ type: 'REC_CHUNK', seq: m.seq, b64: toBase64(m.buf) });
  else if (m.type === 'end') send({ type: 'REC_END', chunks: m.chunks, meta: scrapeMeta() });
  else if (m.type === 'error') send({ type: 'REC_ERROR', error: m.error });
});

// --- popup + background -> here --------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_META') { sendResponse({ ...scrapeMeta(), inCall }); return true; }
  if (msg.type === 'STOP_PAGE') { window.postMessage({ [TAG]: 'ext', type: 'stop' }, '*'); sendResponse({ ok: true }); return true; }
});

// --- DOM: in-call state, for the popup only ------------------------------------------------
// Deliberately NOT a stop signal: these selectors are a guess at each vendor's markup, and a
// flicker would cut a live recording in two. The recorder stops on the connection closing.
function tick() {
  if (!P) return;
  try { inCall = P.inCall(); } catch (_) { inCall = false; }
}
if (P) {
  tick();
  setInterval(tick, 2500);
  window.addEventListener('focus', tick);
  document.addEventListener('visibilitychange', tick);
}
