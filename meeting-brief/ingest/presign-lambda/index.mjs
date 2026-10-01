// Presign endpoint for the Meeting Capture extension.
// Deployed as a Lambda Function URL (or behind API Gateway) in your AWS account. The
// extension sends its token + meta; this validates the token, stashes a .json sidecar, and
// returns a one-time presigned S3 PUT so the browser uploads the audio straight to the
// private inbox bucket without ever holding AWS credentials.
//
// Env:
//   UPLOAD_TOKEN   shared secret the extension sends as "Authorization: Bearer <token>"
//   INBOX_BUCKET   private S3 bucket, e.g. your-meeting-inbox
//   MAX_BYTES      optional upload cap (default 524288000 = 500 MB)

import { readFileSync, existsSync } from 'node:fs';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// WHEN_REQUIRED stops SDK v3 baking a CRC32-of-empty-body checksum into presigned PUT
// URLs, which S3 can reject once a real body arrives.
const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
// The extension zip is bundled into the deployment package by deploy.sh.
const EXT_ZIP = new URL('./extension.zip', import.meta.url).pathname;
const BUCKET = process.env.INBOX_BUCKET;
const TOKEN = process.env.UPLOAD_TOKEN;
const MAX_BYTES = parseInt(process.env.MAX_BYTES || '524288000', 10);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type'
};

const reply = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(obj)
});

const san = (s, re, fallback) => {
  const out = String(s || '').replace(re, '').slice(0, 120);
  return out || fallback;
};

// Length-insensitive constant-time compare so a wrong token cannot be timed out.
function tokenOk(got) {
  if (!TOKEN || !got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(TOKEN);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] || 0);
  return diff === 0;
}

// GET /extension: the unpacked-extension zip, public (it holds no secrets; the token is
// typed into the options page after install).
function serveExtension() {
  if (!existsSync(EXT_ZIP)) return reply(404, { error: 'extension_not_bundled' });
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="meeting-capture-extension.zip"',
      'Cache-Control': 'no-store',
      ...CORS
    },
    body: readFileSync(EXT_ZIP).toString('base64'),
    isBase64Encoded: true
  };
}

// GET /install: `curl -fsSL <your-endpoint>/install | sh` installs or updates the unpacked
// extension into a permanent per-user folder, so it never lives in Downloads. The download
// URL points back at whichever host served this script, so it works for any deployment.
// Loaded unpacked from a stable folder, the extension keeps the same ID across updates, so
// the token in Options survives every update.
const installScript = (base) => `#!/bin/sh
# Meeting Capture: install or update the unpacked Chrome extension.
set -e
case "$(uname -s)" in
  Darwin) DIR="$HOME/Library/Application Support/Meeting Capture" ;;
  *) DIR="\${XDG_DATA_HOME:-$HOME/.local/share}/meeting-capture" ;;
esac
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL ${base}/extension -o "$TMP/ext.zip"
unzip -q "$TMP/ext.zip" -d "$TMP"
mkdir -p "$DIR"
rm -rf "$DIR/extension"
mv "$TMP/meeting-capture-extension" "$DIR/extension"
VER=$(sed -n 's/.*"version": *"\\([^"]*\\)".*/\\1/p' "$DIR/extension/manifest.json" | head -1)
echo "Meeting Capture v$VER is in: $DIR/extension"
if command -v pbcopy >/dev/null 2>&1; then printf %s "$DIR/extension" | pbcopy; echo "(path copied to the clipboard)"; fi
echo
echo "First install: chrome://extensions > Developer mode > Load unpacked,"
echo "  press Cmd+Shift+G, paste the path, Open."
echo "Update: press the reload arrow on Meeting Capture in chrome://extensions."
`;

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || 'POST';
  const path = (event?.rawPath || '/').replace(/\/+$/, '') || '/';
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (method === 'GET' && (path === '/extension' || path === '/extension.zip')) return serveExtension();
  if (method === 'GET' && (path === '/install' || path === '/install.sh')) {
    const host = (event.headers && (event.headers.host || event.headers.Host)) || event?.requestContext?.domainName || '';
    const base = host ? `https://${host}` : '';
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }, body: installScript(base) };
  }
  // POST /api is the presign call; POST / is kept for the raw execute-api URL.
  if (!(method === 'POST' && (path === '/api' || path === '/'))) return reply(404, { error: 'not_found' });

  if (!BUCKET || !TOKEN) return reply(500, { error: 'server_not_configured' });

  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  const got = auth.replace(/^Bearer\s+/i, '');
  if (!tokenOk(got)) return reply(401, { error: 'unauthorized' });

  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    body = JSON.parse(raw || '{}');
  } catch (_) { return reply(400, { error: 'bad_json' }); }

  const contentType = String(body.contentType || 'audio/webm');
  if (!/^(audio|video)\//.test(contentType)) return reply(400, { error: 'content_type_must_be_audio_or_video' });
  const bytes = Number(body.bytes || 0);
  if (bytes && bytes > MAX_BYTES) return reply(413, { error: 'too_large', maxBytes: MAX_BYTES });

  const workspace = san(body.workspace, /[^a-zA-Z0-9._-]/g, 'unsorted').toLowerCase();
  const filename = san((body.filename || 'meeting.webm').split(/[\\/]/).pop(), /[^a-zA-Z0-9._-]/g, 'meeting.webm');
  const key = `inbox/${workspace}/${filename}`;

  // Stash the sidecar now so ingest has the meta even if the PUT never happens.
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key.replace(/\.[^.]+$/, '') + '.json',
      Body: JSON.stringify(body.meta || body, null, 2),
      ContentType: 'application/json'
    }));
  } catch (e) {
    return reply(502, { error: 'sidecar_failed', detail: String(e && e.message || e) });
  }

  const putUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: 900 }
  );

  return reply(200, { putUrl, key, bucket: BUCKET });
};
