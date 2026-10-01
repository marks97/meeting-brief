#!/usr/bin/env bash
# Pull meeting recordings the extension dropped into the S3 inbox, so meeting-brief's
# normal Flow A can transcribe + archive them. Routing (which workspace's arch/ a clip
# belongs to) is left to the caller / the model, using the sidecar meta -- this script
# only lists, downloads and deletes.
#
# Configure:
#   MEETING_INBOX_BUCKET   the private inbox bucket (required)
#   MEETING_INBOX_ENV      a .env with AWS creds (optional; otherwise the ambient
#                          environment or AWS_PROFILE is used)
#
# Usage:
#   ingest.sh list                      # pending recordings, newest first, with title
#   ingest.sh pull <key> <outdir>       # download media + sidecar, print the meta
#   ingest.sh done <key>                # delete the media + sidecar after archiving
#   ingest.sh retag <key> <workspace>   # move a clip to inbox/<workspace>/ unprocessed
set -euo pipefail

BUCKET="${MEETING_INBOX_BUCKET:?set MEETING_INBOX_BUCKET to your private inbox bucket}"
if [ -n "${MEETING_INBOX_ENV:-}" ] && [ -f "$MEETING_INBOX_ENV" ]; then
  set -a; # shellcheck disable=SC1090
  . "$MEETING_INBOX_ENV"; set +a
  export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-${AWS_ACCESS_KEY:-}}"
  export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-${AWS_ACCESS_SECRET:-}}"
fi
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

sidecar_key() { echo "${1%.*}.json"; }

cmd_list() {
  # List audio objects (skip the .json sidecars), newest first.
  local rows
  rows=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix inbox/ \
    --query 'sort_by(Contents,&LastModified)[?!ends_with(Key,`.json`)].[Key,Size,LastModified]' \
    --output text 2>/dev/null || true)
  if [ -z "$rows" ]; then echo "(inbox empty)"; return; fi
  printf '%s\n' "$rows" | tac | while IFS=$'\t' read -r key size modified; do
    local title=""
    title=$(aws s3 cp "s3://$BUCKET/$(sidecar_key "$key")" - 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s);process.stdout.write((m.title||"")+" | "+(m.startedAt||"")+" | "+((m.participants||[]).join(", ")))}catch{}})' 2>/dev/null || true)
    printf '%-52s %8s KB   %s\n' "$key" "$((size/1024))" "${title:-<no sidecar>}"
  done
}

cmd_pull() {
  local key="$1" out="${2:?usage: pull <key> <outdir>}"
  mkdir -p "$out"
  aws s3 cp "s3://$BUCKET/$key" "$out/$(basename "$key")"
  aws s3 cp "s3://$BUCKET/$(sidecar_key "$key")" "$out/$(basename "$(sidecar_key "$key")")" 2>/dev/null || echo "(no sidecar)" >&2
  echo "downloaded to: $out/$(basename "$key")"
  echo "--- meta ---"
  cat "$out/$(basename "$(sidecar_key "$key")")" 2>/dev/null || true
}

cmd_done() {
  local key="$1"
  aws s3 rm "s3://$BUCKET/$key"
  aws s3 rm "s3://$BUCKET/$(sidecar_key "$key")" 2>/dev/null || true
  echo "removed from inbox: $key"
}

# Hand a clip to another workspace without transcribing it here.
cmd_retag() {
  local key="$1" ws="${2:?usage: retag <key> <workspace>}"
  local dest="inbox/${ws}/$(basename "$key")"
  aws s3 mv "s3://$BUCKET/$key" "s3://$BUCKET/$dest"
  aws s3 mv "s3://$BUCKET/$(sidecar_key "$key")" "s3://$BUCKET/$(sidecar_key "$dest")" 2>/dev/null || true
  echo "retagged: $key -> $dest"
}

case "${1:-}" in
  list) cmd_list ;;
  pull) shift; cmd_pull "$@" ;;
  done) shift; cmd_done "$@" ;;
  retag) shift; cmd_retag "$@" ;;
  *) echo "usage: ingest.sh {list|pull <key> <outdir>|done <key>|retag <key> <workspace>}" >&2; exit 2 ;;
esac
