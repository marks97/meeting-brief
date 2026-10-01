#!/usr/bin/env node
// Turn a Scribe v2 diarized response into a timestamped, speaker-grouped transcript.
// Usage: format-transcript.mjs <raw.json> [--map speaker_0=Alice,speaker_1=Bob]
import fs from 'fs';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: format-transcript.mjs <raw.json> [--map s0=Name,...]'); process.exit(1); }

const mapArg = rest[rest.indexOf('--map') + 1];
const names = {};
if (rest.includes('--map') && mapArg) {
  for (const pair of mapArg.split(',')) {
    const [k, v] = pair.split('=');
    if (k && v) names[k.trim()] = v.trim();
  }
}

const d = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!d.words) { console.log(d.text ?? JSON.stringify(d).slice(0, 500)); process.exit(0); }

const turns = [];
let cur = null;
for (const w of d.words) {
  if (w.type === 'audio_event') continue;
  const sp = w.speaker_id || 'speaker_0';
  if (!cur || cur.sp !== sp) { cur = { sp, start: w.start, text: '' }; turns.push(cur); }
  cur.text += w.text;
}

const ts = s => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
for (const t of turns) {
  const txt = t.text.trim();
  if (!txt) continue;
  console.log(`[${ts(t.start)}] ${names[t.sp] ?? t.sp}: ${txt}\n`);
}
