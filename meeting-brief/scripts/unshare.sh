#!/usr/bin/env bash
# Delete a previously shared object (and optionally the local file).
# Usage: unshare.sh <s3://bucket/key> [project-dir] [local-file-to-rm]
set -euo pipefail
source "$(dirname "$0")/aws-env.sh"
URI="${1:?usage: unshare.sh <s3://bucket/key> [project-dir] [local-file]}"
resolve_aws "${2:-$PWD}"
B=$(echo "$URI" | sed 's|s3://||; s|/.*||')
REGION=$(aws s3api get-bucket-location --bucket "$B" --output text); [ "$REGION" = "None" ] && REGION=us-east-1
AWS_DEFAULT_REGION="$REGION" aws s3 rm "$URI"
[ -n "${3:-}" ] && [ -f "$3" ] && { rm -f "$3"; echo "removed local $3"; }
