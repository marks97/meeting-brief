// Call recorder that runs INSIDE the meeting page (content script, world MAIN, document_start).
//
// Why here and not chrome.tabCapture: Chrome only lets an extension capture a tab after the
// user clicks the extension on that tab, so tab capture can never start on its own. The page
// itself already holds everything a recording needs: the remote participants' audio arrives
// as WebRTC tracks, and the user's voice is the mic track the page asked for. Wrapping
// RTCPeerConnection and getUserMedia before the page's own scripts run lets us mix those into
// a recording with no click and no permission prompt. Meet, Zoom web and Teams web are all
// WebRTC, so one recorder covers all three.
//
// This file has no chrome.* access. It talks to the isolated content script (content.js)
// over window.postMessage, which relays chunks to the extension.
(() => {
  if (window.__meetingCaptureMain) return;
  window.__meetingCaptureMain = true;

  const TAG = '__meetingCapture';
  const post = (msg, transfer) => window.postMessage({ [TAG]: 'page', ...msg }, '*', transfer || []);

  const remote = new Map(); // track.id -> remote audio track from the call
  const local = new Map();  // track.id -> this user's mic track (from getUserMedia)
  const pcs = new Set();
  const wired = new Map();  // track.id -> { node, el }

  let armed = false;        // set from settings by content.js (auto-record on and a token present)
  let rec = null;
  let ctx = null;
  let dest = null;
  let seq = 0;
  let stopTimer = null;
  let chain = Promise.resolve();

  const live = (t) => t.readyState === 'live';

  // --- hooks: these must be installed before the page creates its first connection ---------
  const NativePC = window.RTCPeerConnection;
  if (NativePC) {
    class MeetingCapturePC extends NativePC {
      constructor(...args) {
        super(...args);
        pcs.add(this);
        this.addEventListener('track', (e) => {
          if (e.track.kind !== 'audio') return;
          remote.set(e.track.id, e.track);
          wire(e.track);
          evaluate();
        });
        this.addEventListener('connectionstatechange', evaluate);
        this.addEventListener('iceconnectionstatechange', evaluate);
      }
      close() {
        super.close();
        evaluate(); // close() fires no state-change event
      }
    }
    window.RTCPeerConnection = MeetingCapturePC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = MeetingCapturePC;
  }

  const md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = function (constraints) {
      return gum(constraints).then((stream) => {
        stream.getAudioTracks().forEach((t) => { local.set(t.id, t); wire(t); });
        return stream;
      });
    };
  }

  // --- call state ----------------------------------------------------------------------------
  function pcState(pc) { return pc.connectionState || pc.iceConnectionState || 'new'; }

  function evaluate() {
    let connected = 0;
    let recovering = 0;
    for (const pc of pcs) {
      const s = pcState(pc);
      if (s === 'connected' || s === 'completed') connected += 1;
      else if (s === 'disconnected' || s === 'checking' || s === 'connecting') recovering += 1;
    }
    const remoteLive = [...remote.values()].some(live);
    const inCall = connected > 0 && remoteLive;

    if (inCall) {
      clearTimeout(stopTimer);
      stopTimer = null;
      if (!rec && armed) start();
      return;
    }
    if (rec && !stopTimer) {
      // A network blip shows as 'disconnected' and usually recovers; a hang-up shows as
      // 'closed'. Give the first a grace period, end the second straight away.
      stopTimer = setTimeout(() => stop('call_ended'), recovering ? 15000 : 1000);
    }
  }
  setInterval(evaluate, 3000);

  // --- recording -----------------------------------------------------------------------------
  function wire(t) {
    if (!ctx || wired.has(t.id) || !live(t)) return;
    const ms = new MediaStream([t]);
    // Chrome only renders remote WebRTC audio into Web Audio while the stream is also attached
    // to a media element. A muted one satisfies that and keeps us out of the speakers.
    const el = new Audio();
    el.muted = true;
    el.srcObject = ms;
    el.play().catch(() => {});
    const node = ctx.createMediaStreamSource(ms);
    node.connect(dest);
    wired.set(t.id, { node, el });
  }

  function start() {
    try {
      ctx = new AudioContext();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      dest = ctx.createMediaStreamDestination();
      for (const t of [...remote.values(), ...local.values()]) wire(t);

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 48000 });
      seq = 0;
      chain = Promise.resolve();
      // Chunks are handed over in order; the final dataavailable fires before 'stop', so
      // chaining keeps 'end' behind the last chunk.
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        chain = chain.then(async () => {
          const buf = await e.data.arrayBuffer();
          post({ type: 'chunk', seq: seq++, buf }, [buf]);
        });
      };
      rec.onstop = () => {
        chain = chain.then(() => { post({ type: 'end', chunks: seq }); cleanup(); });
      };
      rec.start(5000); // flush every 5s: a crash or a closed tab loses seconds, not the call
      post({ type: 'start', mic: [...local.values()].some(live) });
    } catch (e) {
      post({ type: 'error', error: String((e && e.message) || e) });
      cleanup();
    }
  }

  function stop() {
    clearTimeout(stopTimer);
    stopTimer = null;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch (_) { cleanup(); }
    }
  }

  function cleanup() {
    for (const { node, el } of wired.values()) {
      try { node.disconnect(); } catch (_) {}
      try { el.pause(); el.srcObject = null; } catch (_) {}
    }
    wired.clear();
    try { ctx && ctx.close(); } catch (_) {}
    ctx = null;
    dest = null;
    rec = null;
  }

  // --- messages from content.js ------------------------------------------------------------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'ext') return;
    if (e.data.type === 'config') {
      armed = !!e.data.armed;
      if (armed) evaluate();
      else stop();
    } else if (e.data.type === 'stop') {
      stop();
    }
  });

  window.addEventListener('pagehide', () => { if (rec) stop(); });
})();
