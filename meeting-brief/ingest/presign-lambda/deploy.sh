#!/usr/bin/env bash
# Deploy (or redeploy) the presign endpoint into your AWS account.
# Idempotent: safe to re-run. Needs AWS creds in the environment (export them, or
# `source` a .env that sets AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) and `aws`,
# `node`, `npm`, `zip` on PATH.
#
#   BUCKET=your-meeting-inbox TOKEN="$(openssl rand -hex 24)" ./deploy.sh
#
# Prints the Function URL (the extension's "endpoint") and the token at the end.
set -euo pipefail
cd "$(dirname "$0")"

REGION="${REGION:-us-east-1}"
BUCKET="${BUCKET:?set BUCKET, e.g. your-meeting-inbox}"
TOKEN="${TOKEN:?set TOKEN, e.g. TOKEN=\$(openssl rand -hex 24)}"
FUNC="${FUNC:-meeting-capture-presign}"
ROLE="${ROLE:-${FUNC}-role}"
MAX_BYTES="${MAX_BYTES:-524288000}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "account: $ACCOUNT_ID  region: $REGION  bucket: $BUCKET  func: $FUNC"
if [ -n "${EXPECT_ACCOUNT:-}" ] && [ "$ACCOUNT_ID" != "$EXPECT_ACCOUNT" ]; then
  echo "ABORT: resolved account $ACCOUNT_ID != EXPECT_ACCOUNT $EXPECT_ACCOUNT (wrong creds?)" >&2
  exit 3
fi

# 1. Private inbox bucket (block all public access).
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
# The extension PUTs from a chrome-extension:// origin, so the browser preflights it.
# CORS grants no access by itself; the presigned URL is still the only way in.
aws s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration \
  '{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["PUT"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}'

# 2. IAM role for the function.
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17","Statement":[{"Effect":"Allow",
    "Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "waiting for role to propagate..."; sleep 12
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name s3-inbox-put --policy-document "{
  \"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",
  \"Action\":[\"s3:PutObject\"],\"Resource\":\"arn:aws:s3:::${BUCKET}/inbox/*\"}]}"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query 'Role.Arn' --output text)

# 3. Package.
rm -rf build && mkdir build
cp index.mjs package.json build/
# Bundle the extension as a zip with one top-level folder, so unzipping yields a folder
# to point "Load unpacked" at. Served at GET /extension.
HERE=$(pwd)
EXT_STAGE=$(mktemp -d)
cp -r ../../extension "$EXT_STAGE/meeting-capture-extension"
( cd "$EXT_STAGE" && zip -qr "$HERE/build/extension.zip" meeting-capture-extension )
rm -rf "$EXT_STAGE"
( cd build && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 )
( cd build && zip -qr ../function.zip . )

# 4. Create or update the function.
ENV="Variables={UPLOAD_TOKEN=$TOKEN,INBOX_BUCKET=$BUCKET,MAX_BYTES=$MAX_BYTES}"
if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNC" --region "$REGION" \
    --zip-file fileb://function.zip >/dev/null
  aws lambda wait function-updated --function-name "$FUNC" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNC" --region "$REGION" \
    --environment "$ENV" --timeout 20 --memory-size 256 >/dev/null
else
  aws lambda create-function --function-name "$FUNC" --region "$REGION" \
    --runtime nodejs20.x --handler index.handler --role "$ROLE_ARN" \
    --zip-file fileb://function.zip --timeout 20 --memory-size 256 \
    --environment "$ENV" >/dev/null
  aws lambda wait function-active --function-name "$FUNC" --region "$REGION"
fi

# 5. Public endpoint via API Gateway HTTP API. (Lambda Function URLs with auth NONE are
#    rejected at the edge in some accounts; HTTP API is the reliable public path. The
#    handler gates every request with the bearer token and sets its own CORS headers, and
#    HTTP API payload format 2.0 matches the event shape it already reads.)
aws lambda delete-function-url-config --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1 || true
FN_ARN=$(aws lambda get-function --function-name "$FUNC" --region "$REGION" --query 'Configuration.FunctionArn' --output text)
API_ID=$(aws apigatewayv2 get-apis --region "$REGION" --query "Items[?Name=='$FUNC'].ApiId | [0]" --output text)
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  # Quick-create: catch-all route -> Lambda proxy (payload v2), auto-deployed $default stage.
  API_ID=$(aws apigatewayv2 create-api --region "$REGION" --name "$FUNC" \
    --protocol-type HTTP --target "$FN_ARN" --query ApiId --output text)
fi
# Let API Gateway invoke the function.
aws lambda add-permission --function-name "$FUNC" --region "$REGION" \
  --statement-id apigw-invoke --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*" >/dev/null 2>&1 || true
URL="https://$API_ID.execute-api.$REGION.amazonaws.com/"

rm -rf build function.zip
echo
echo "================ extension options ================"
echo "Endpoint URL : $URL"
echo "Upload token : $TOKEN"
echo "Inbox bucket : s3://$BUCKET/inbox/<workspace>/"
echo "==================================================="
