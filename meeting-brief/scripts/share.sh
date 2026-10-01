#!/usr/bin/env bash
# Upload a file to a PRIVATE S3 key in the current project's AWS account and
# print a presigned URL. Never makes anything public.
# Usage: share.sh <file> [project-dir] [expires-seconds]
set -euo pipefail
source "$(dirname "$0")/aws-env.sh"

F="${1:?usage: share.sh <file> [project-dir] [expires]}"
PROJ="${2:-$PWD}"
EXPIRES="${3:-604800}"   # 7 days, the SigV4 maximum

resolve_aws "$PROJ"

BUCKET="${MEETING_BRIEF_BUCKET:-}"
# Use a bucket with public access blocked. The audio is uploaded with a private ACL
# and shared only via a presigned URL; nothing here is ever made world-readable.
[ -n "$BUCKET" ] || { echo "ERROR: set MEETING_BRIEF_BUCKET to a private S3 bucket" >&2; exit 1; }

REGION=$(aws s3api get-bucket-location --bucket "$BUCKET" --output text)
[ "$REGION" = "None" ] && REGION=us-east-1
export AWS_DEFAULT_REGION="$REGION"

KEY="private/meeting-briefings/$(date -u +%Y-%m-%d)/$(basename "$F")"
aws s3 cp "$F" "s3://$BUCKET/$KEY" --acl private --content-type audio/mpeg --only-show-errors
aws s3 presign "s3://$BUCKET/$KEY" --expires-in "$EXPIRES"
echo "s3://$BUCKET/$KEY" >&2
