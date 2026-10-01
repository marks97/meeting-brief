#!/usr/bin/env bash
# Transcribe audio files with ElevenLabs Scribe v2, diarized, in parallel.
# Usage: transcribe.sh <outdir> <audio-file>...
# Writes <outdir>/raw-<basename>.json per input. Idempotent: skips existing non-empty output.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
load_key

OUT="${1:?usage: transcribe.sh <outdir> <audio>...}"; shift
[ $# -gt 0 ] || { echo "no audio files given" >&2; exit 1; }
mkdir -p "$OUT"

KEYTERMS_FILE="${KEYTERMS_FILE:-$(dirname "$0")/../keyterms.txt}"
# Scribe v2 wants ONE repeated multipart field per term. A JSON array in a single
# `keyterms` field is rejected ("All keywords must be less than 50 characters" --
# the whole array is read as one keyword). Terms >=50 chars are dropped, not sent.
KEYTERMS_ARGS=()
if [ -f "$KEYTERMS_FILE" ]; then
  while IFS= read -r term; do
    [ -n "$term" ] || continue
    [ "${#term}" -lt 50 ] || { echo "skip keyterm (>=50 chars): $term" >&2; continue; }
    KEYTERMS_ARGS+=(-F "keyterms=$term")
  done < <(grep -vE '^[[:space:]]*(#|$)' "$KEYTERMS_FILE")
fi

pids=()
for f in "$@"; do
  base=$(basename "$f"); base="${base%.*}"
  slug=$(echo "$base" | tr -cs 'A-Za-z0-9' '-' | sed 's/^-//;s/-$//')
  dest="$OUT/raw-$slug.json"
  if [ -s "$dest" ]; then echo "skip (exists): $dest"; continue; fi
  (
    code=$(curl -sS -X POST "https://api.elevenlabs.io/v1/speech-to-text" \
      -H "xi-api-key: $ELEVENLABS_API_KEY" \
      -F "file=@$f" \
      -F "model_id=scribe_v2" \
      -F "diarize=true" \
      "${KEYTERMS_ARGS[@]}" \
      -o "$dest" -w '%{http_code}')
    if [ "$code" != "200" ]; then
      echo "FAIL $slug http=$code: $(head -c 300 "$dest")" >&2
      rm -f "$dest"; exit 1
    fi
    echo "ok $slug ($(stat -c%s "$dest") bytes)"
  ) &
  pids+=($!)
done

rc=0
for p in "${pids[@]:-}"; do wait "$p" || rc=1; done
exit $rc
