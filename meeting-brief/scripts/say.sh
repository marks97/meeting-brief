#!/usr/bin/env bash
# Turn a spoken-script text file into an MP3, at a given speed, and print the path.
# Usage: say.sh <script.txt> <out.mp3> [speed] [voice_id]
# Splits on blank-line paragraph boundaries into <=3500 char chunks, keeps prosody
# continuous with previous_text/next_text, stitches, then applies speed with ffmpeg.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
load_key

SRC="${1:?usage: say.sh <script.txt> <out.mp3> [speed] [voice]}"
OUT="${2:?}"
SPEED="${3:-1.5}"
VOICE="${4:-${MEETING_BRIEF_VOICE:-onwK4e9ZLuTAKqWW03F9}}"   # default narration voice (a calm broadcast read)
MODEL="${MEETING_BRIEF_MODEL:-eleven_multilingual_v2}"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# chunk the script on paragraph boundaries, max 3500 chars
python3 - "$SRC" "$TMP" <<'PY'
import sys, os
src, tmp = sys.argv[1], sys.argv[2]
paras = [p for p in open(src, encoding='utf-8').read().split('\n\n') if p.strip()]
chunks, cur = [], ''
for p in paras:
    if cur and len(cur) + len(p) + 2 > 3500:
        chunks.append(cur); cur = p
    else:
        cur = f'{cur}\n\n{p}' if cur else p
if cur: chunks.append(cur)
for i, c in enumerate(chunks):
    open(os.path.join(tmp, f'chunk-{i:03d}.txt'), 'w', encoding='utf-8').write(c)
print(len(chunks))
PY

N=$(ls "$TMP"/chunk-*.txt | wc -l)
i=0
for f in "$TMP"/chunk-*.txt; do
  prev=""; nxt=""
  [ $i -gt 0 ] && prev=$(tail -c 400 "$TMP/chunk-$(printf '%03d' $((i-1))).txt")
  [ $((i+1)) -lt "$N" ] && nxt=$(head -c 400 "$TMP/chunk-$(printf '%03d' $((i+1))).txt")
  jq -n --rawfile t "$f" --arg p "$prev" --arg n "$nxt" --arg m "$MODEL" \
    '{text:$t, model_id:$m, previous_text:$p, next_text:$n,
      voice_settings:{stability:0.45, similarity_boost:0.75, style:0.0, use_speaker_boost:true}}' \
    > "$TMP/body-$i.json"
  code=$(curl -sS -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE?output_format=mp3_44100_128" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" -H "Content-Type: application/json" \
    --data @"$TMP/body-$i.json" -o "$TMP/part-$i.mp3" -w '%{http_code}')
  [ "$code" = "200" ] || { echo "TTS chunk $i failed http=$code: $(head -c 300 "$TMP/part-$i.mp3")" >&2; exit 1; }
  i=$((i+1))
done

cat "$TMP"/part-*.mp3 > "$TMP/joined.mp3"

# ffmpeg atempo only accepts 0.5-2.0 per filter; chain for anything outside that.
mkdir -p "$(dirname "$OUT")"
if [ "$(python3 -c "print(1 if abs($SPEED-1.0)<0.01 else 0)")" = "1" ]; then
  cp "$TMP/joined.mp3" "$OUT"
else
  CHAIN=$(python3 -c "
s=$SPEED; parts=[]
while s > 2.0: parts.append('atempo=2.0'); s/=2.0
while s < 0.5: parts.append('atempo=0.5'); s/=0.5
parts.append('atempo=%.4f' % s)
print(','.join(parts))")
  ffmpeg -v error -y -i "$TMP/joined.mp3" -filter:a "$CHAIN" -b:a 128k "$OUT"
fi

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")
printf '%s\n' "$OUT"
printf 'speed=%s duration=%dm%02ds size=%s\n' "$SPEED" \
  "$(python3 -c "print(int($DUR//60))")" "$(python3 -c "print(int($DUR%60))")" \
  "$(stat -c%s "$OUT")" >&2
