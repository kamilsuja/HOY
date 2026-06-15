'use strict';
/**
 * lib/storage.js — listing/ID photo uploads.
 *
 * Two modes, chosen by env:
 *   S3 mode  (production): set S3_BUCKET, S3_REGION, S3_KEY, S3_SECRET, and
 *            optionally S3_ENDPOINT (for Cloudflare R2 / Backblaze / MinIO) and
 *            S3_PUBLIC_BASE (CDN or public bucket URL). The client asks for a
 *            presigned PUT URL and uploads the file straight to storage — the
 *            bytes never touch this server. Zero-dependency SigV4 below.
 *   local mode (dev/no keys): the client POSTs a base64 data URL and we write
 *            it under public/uploads/ and return a local URL. Works instantly.
 *
 * Interface:
 *   mode()                       -> 's3' | 'local'
 *   presign(key, contentType)    -> { uploadUrl, publicUrl, method:'PUT', headers }
 *   saveLocal(dataUrl)           -> { publicUrl }   (local mode)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const S3 = {
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION || 'auto',
  key: process.env.S3_KEY,
  secret: process.env.S3_SECRET,
  endpoint: process.env.S3_ENDPOINT,            // e.g. https://<acct>.r2.cloudflarestorage.com
  publicBase: process.env.S3_PUBLIC_BASE,       // e.g. https://cdn.hoy.so
};
function mode() { return (S3.bucket && S3.key && S3.secret) ? 's3' : 'local'; }

function hmac(key, str) { return crypto.createHmac('sha256', key).update(str).digest(); }
function sha256hex(str) { return crypto.createHash('sha256').update(str).digest('hex'); }

/** AWS Signature V4 presigned PUT URL (path-style; works with S3, R2, B2, MinIO). */
function presign(objectKey, contentType) {
  if (mode() !== 's3') throw new Error('S3 not configured');
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const service = 's3';
  const host = S3.endpoint ? new URL(S3.endpoint).host : `${S3.bucket}.s3.${S3.region}.amazonaws.com`;
  const canonicalUri = S3.endpoint ? `/${S3.bucket}/${objectKey}` : `/${objectKey}`;
  const credentialScope = `${dateStamp}/${S3.region}/${service}/aws4_request`;
  const q = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${S3.key}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': 'host',
  });
  const canonicalRequest = [
    'PUT', canonicalUri, q.toString(),
    `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + S3.secret, dateStamp);
  const kRegion = hmac(kDate, S3.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  q.append('X-Amz-Signature', signature);
  const scheme = S3.endpoint ? new URL(S3.endpoint).protocol.replace(':', '') : 'https';
  const uploadUrl = `${scheme}://${host}${canonicalUri}?${q.toString()}`;
  const publicUrl = S3.publicBase
    ? `${S3.publicBase.replace(/\/$/, '')}/${objectKey}`
    : `${scheme}://${host}${canonicalUri}`;
  return { uploadUrl, publicUrl, method: 'PUT', headers: { 'Content-Type': contentType || 'application/octet-stream' } };
}

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
function saveLocal(dataUrl) {
  const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Expected a base64 data URL');
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) throw new Error('File too large (max 8MB)');
  const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const name = crypto.randomBytes(8).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { publicUrl: '/uploads/' + name };
}

module.exports = { mode, presign, saveLocal, UPLOAD_DIR };
