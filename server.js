'use strict';
/**
 * server.js — Hoy backend (hardened MVP, zero runtime deps for the JSON store).
 *
 * Run:  node server.js     (Node 18+)        Open: http://localhost:3000
 *
 * Hardening in this version:
 *  - Async data layer (JSON by default; Postgres via DATABASE_URL — db.js).
 *  - OTP codes stored as HMAC, session tokens stored hashed, both with expiry.
 *  - Rate limiting on auth + booking endpoints.
 *  - Notifications sent through a retry queue (a provider hiccup is retried).
 *  - CORS locked to ALLOWED_ORIGIN (dev: localhost only); security headers.
 *
 * Endpoints
 *  GET  /health
 *  GET  / | /index.html | /app        -> serves public/index.html (the app)
 *  GET  /listings  /experiences  /listings/:id
 *  POST /auth/request-code  { contact }
 *  POST /auth/verify        { contact, code }  -> { token }
 *  POST /auth/logout        (Bearer)
 *  GET  /me/bookings        (Bearer)
 *  POST /bookings           (Bearer) { listingId, checkIn, checkOut, guests, guestChannel }
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const notify = require('./notify');
const { hmac, hashToken, randomToken, sixDigitCode, safeEqual } = require('./lib/security');
const { limit } = require('./lib/ratelimit');
const queue = require('./lib/queue');
const storage = require('./lib/storage');
const identity = require('./lib/identity');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DEV_RETURN_OTP = !PROD;                 // dev convenience: return the code
const OTP_TTL_MS = 10 * 60 * 1000;            // 10 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PROVIDERS_ON = !!(process.env.RESEND_API_KEY || process.env.TWILIO_ACCOUNT_SID);
const ALLOWED = (process.env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---- card payments (Stripe Checkout; test-mode until real keys are set) ----
const crypto = require('crypto');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAYMENTS_ON = !!STRIPE_SECRET_KEY;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
console.log('[hoy] startup · payments:', PAYMENTS_ON ? 'ON' : 'OFF', '· stripeKey:', STRIPE_SECRET_KEY ? STRIPE_SECRET_KEY.slice(0, 8) + '…' : 'MISSING', '· appUrl:', APP_URL);
async function stripeRequest(path, params) {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error((data.error && data.error.message) || 'Stripe error');
  return data;
}
// ---- live currency rates: auto-updates daily, free, no API key needed ---- let fxRates = { USD:1, GBP:0.79, EUR:0.92, CAD:1.36, NOK:10.7, SEK:10.5 }; // safe fallbacks let fxDate = null, fxAt = 0; async function getRates() {   if (Date.now() - fxAt < 6*60*60*1000) return { rates: fxRates, date: fxDate }; // refresh at most every 6h   fxAt = Date.now();   try {     const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=GBP,EUR,CAD,NOK,SEK');     const d = await r.json();     if (d && d.rates && d.rates.EUR) { fxRates = Object.assign({ USD:1 }, d.rates); fxDate = d.date || null; }   } catch (e) { console.log('[hoy] fx fetch failed, keeping last rates:', e.message); }   return { rates: fxRates, date: fxDate }; } function verifyStripeSig(raw, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = {};
  String(sigHeader).split(',').forEach((kv) => { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i)] = kv.slice(i + 1); });
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.' + raw).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* -------------------- pricing (same rules as the app) -------------------- */
function computePricing({ price, nights, guests, isExperience }) {
  const sub = isExperience ? price * guests : price * nights;
  const cleaning = isExperience ? 0 : 15;
  const guestFee = Math.round(sub * 0.12);
  const total = sub + cleaning + guestFee;
  const hostFee = Math.round(sub * 0.03);
  const payout = sub + cleaning - hostFee;
  return { sub, cleaning, guestFee, hostFee, total, payout };
}
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function nightsBetween(a, b) { const n = Math.round((startOfDay(b) - startOfDay(a)) / 864e5); return n > 0 ? n : 0; }
function overlaps(booked, inTs, outTs) { return (booked || []).some(([s, e]) => inTs < e && outTs > s); }

// ---- cancellation policy ----
const GUEST_FEE_WINDOW_HRS = 24;   // guest cancels inside 24h of start -> fee applies
const GUEST_CANCEL_FEE_PCT = 0.20; // 20% of the booking
const HOST_LATE_WINDOW_HRS = 72;   // host cancel inside 72h of start = a "late" cancellation
const HOST_SUSPEND_RATE = 0.25;    // host cancels >=25% of their bookings -> suspended
const HOST_SUSPEND_MIN_BOOKINGS = 4; // ...but only once they have a few bookings, so 1-of-1 doesn't auto-suspend
const EARLY_CHECKIN_BEFORE = '12:00'; // checking in before noon adds a half-day charge
const EARLY_CHECKIN_PCT = 0.5;
function isEarlyCheckIn(t) { return typeof t === 'string' && /^\d{1,2}:\d{2}$/.test(t) && t < EARLY_CHECKIN_BEFORE; }
function earlyCheckInFee(item, checkInTime, perGuest) { return (!perGuest && isEarlyCheckIn(checkInTime)) ? Math.round((item.price || 0) * EARLY_CHECKIN_PCT) : 0; }
function hoursUntilStart(b) {
  if (!b.checkIn) return Infinity; // no scheduled date yet (e.g. "Date TBD") -> treat as not last-minute
  return (new Date(b.checkIn).getTime() - Date.now()) / 3600000;
}
const GUEST_GRACE_HRS = 24;        // free full refund within 24h of booking
function hoursSinceBooked(b) { return b.createdAt ? (Date.now() - new Date(b.createdAt).getTime()) / 3600000 : Infinity; }
function guestRefund(b) {
  // 24h grace right after booking -> always a full refund
  if (hoursSinceBooked(b) <= GUEST_GRACE_HRS) return { fee: 0, refund: b.total || 0, late: false, grace: true };
  const hrs = hoursUntilStart(b);
  if (hrs < GUEST_FEE_WINDOW_HRS) { const fee = Math.round((b.total || 0) * GUEST_CANCEL_FEE_PCT); return { fee, refund: (b.total || 0) - fee, late: true, grace: false }; }
  return { fee: 0, refund: b.total || 0, late: false, grace: false };
}

/* -------------------- http helpers -------------------- */
function corsOrigin(req) {
  const o = req.headers.origin;
  if (!o) return null;
  if (ALLOWED.length === 0) return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : null;
  return ALLOWED.includes(o) ? o : null;
}
function applyHeaders(req, res) {
  const o = corsOrigin(req);
  if (o) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
async function applyVerificationResult(v, result) {
  v.status = result; v.completedAt = Date.now();
  await db.saveVerification(v.id, v);
  if (result === 'approved') {
    if (v.subjectType === 'host' && v.subjectId) await db.markHostVerified(v.subjectId);
    else if (v.contact) await db.markContactVerified(v.contact);
  }
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}
function isEmail(c) { return /@/.test(c || ''); }

async function authContact(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const s = await db.getSession(hashToken(token));
  if (!s) return null;
  if (s.expires && Date.now() > s.expires) { await db.deleteSession(hashToken(token)); return null; }
  return s.contact;
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
function isAdminContact(contact) {
  if (!contact) return false;
  // Dev convenience: if no allowlist configured and not in production, any logged-in user is admin.
  if (ADMIN_EMAILS.length === 0) return !PROD;
  return ADMIN_EMAILS.includes(String(contact).toLowerCase());
}
// Resolves the caller and enforces admin. Returns contact, or null after writing 401/403.
async function requireAdmin(req, res) {
  const contact = await authContact(req);
  if (!contact) { json(res, 401, { error: 'Sign in required' }); return null; }
  if (!isAdminContact(contact)) { json(res, 403, { error: 'Admin access only' }); return null; }
  return contact;
}

// ---- contact privacy (Airbnb-style) ----
// Hosts and guests never see each other's email/phone. They see a display handle
// and communicate through per-booking messaging. Operators (admin) see full detail.
function maskGuest(contact) {
  if (!contact) return 'Guest';
  if (isEmail(contact)) { const local = contact.split('@')[0].replace(/[^a-zA-Z]/g, ''); return local ? local.charAt(0).toUpperCase() + local.slice(1, 8).toLowerCase() : 'Guest'; }
  const digits = String(contact).replace(/\D/g, ''); return 'Guest ••' + digits.slice(-4);
}
function hostForContact(contact) { return contact ? db.hostByContact(contact) : null; }
// Keep communication on-platform: strip emails, links, and phone-like digit runs.
function scrubContact(s) {
  let out = String(s);
  let hit = false;
  const mark = (re, repl) => { out = out.replace(re, (m) => { hit = true; return repl; }); };
  mark(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, '[contact removed]');
  mark(/\b(?:https?:\/\/|www\.)\S+/gi, '[link removed]');
  out = out.replace(/\+?\d[\d\s().\-]{6,}\d/g, (m) => { if (m.replace(/\D/g, '').length >= 7) { hit = true; return '[number removed]'; } return m; });
  return { text: out, redacted: hit };
}
// role: 'guest' | 'host' | 'admin'. Strips the other party's contact details.
function publicBookingFor(b, role) {
  const c = JSON.parse(JSON.stringify(b));
  if (role === 'admin') return c;
  if (c.host) c.host = { id: c.host.id, name: c.host.name };  // hide host email/phone/evc
  c.guestDisplay = maskGuest(c.guestContact);
  if (role === 'host') delete c.guestContact;                 // hide guest's raw contact from host
  return c;
}

/* -------------------- server -------------------- */
const server = http.createServer(async (req, res) => {
  applyHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const ip = clientIp(req);

  try {
    if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, time: new Date().toISOString() });
    if (req.method === 'GET' && p === '/payments-status') return json(res, 200, {
      paymentsOn: PAYMENTS_ON,
      hasStripeKey: !!STRIPE_SECRET_KEY,
      stripeKeyPrefix: STRIPE_SECRET_KEY ? STRIPE_SECRET_KEY.slice(0, 8) : null,
      hasWebhookSecret: !!STRIPE_WEBHOOK_SECRET,
      appUrl: APP_URL,
    });

    if (req.method === 'GET' && p === '/config') {
      // Non-secret: which integrations are live. Lets you confirm keys took effect.
      return json(res, 200, {
        store: process.env.DATABASE_URL ? 'postgres' : 'json',
        email: !!process.env.RESEND_API_KEY,
        sms: !!(process.env.TWILIO_ACCOUNT_SID || process.env.AT_API_KEY),
        storage: storage.mode(),
        identity: identity.mode(),
        env: PROD ? 'production' : 'dev',
        corsLocked: ALLOWED.length > 0,
      });
    }

    if (req.method === 'GET' && p === '/fx') return json(res, 200, await getRates());      if (req.method === 'POST' && p === '/events') {
      const rl = limit('evt:' + ip, 120, 60 * 1000);
      if (!rl.ok) return json(res, 429, { error: 'rate limited' });
      const { type, listingId, query, category } = await readJson(req);
      if (type === 'view' && listingId) await db.addEvent({ type, listingId, ts: Date.now() });
      else if (type === 'search' && query) await db.addEvent({ type, query: String(query).slice(0, 80).trim().toLowerCase(), category: category || 'homes', ts: Date.now() });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/app')) {
      try {
        const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      } catch (e) {
        return json(res, 404, { error: 'App not found. Copy hoy-prototype.html to hoy-backend/public/index.html' });
      }
    }

    // ---- static assets from public/ (manifest, service worker, icons, etc.) ----
    if (req.method === 'GET' && /^\/[A-Za-z0-9._-]+\.(png|jpg|jpeg|webp|svg|ico|json|webmanifest|js|css|txt)$/.test(p)) {
      const TYPES = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
        svg: 'image/svg+xml', ico: 'image/x-icon', json: 'application/json',
        webmanifest: 'application/manifest+json', js: 'text/javascript', css: 'text/css', txt: 'text/plain',
      };
      try {
        const fname = path.basename(p);
        const buf = fs.readFileSync(path.join(__dirname, 'public', fname));
        const ext = path.extname(fname).slice(1).toLowerCase();
        const headers = { 'Content-Type': (TYPES[ext] || 'application/octet-stream') + (ext === 'js' || ext === 'css' || ext === 'webmanifest' || ext === 'json' ? '; charset=utf-8' : '') };
        // the service worker must be revalidated; icons/manifest can cache
        headers['Cache-Control'] = (fname === 'sw.js') ? 'no-cache' : 'public, max-age=86400';
        res.writeHead(200, headers);
        return res.end(buf);
      } catch (e) { return json(res, 404, { error: 'Not found' }); }
    }

    if (req.method === 'GET' && p === '/listings') return json(res, 200, await db.listings());
    if (req.method === 'GET' && p === '/experiences') return json(res, 200, await db.experiences());
    if (req.method === 'GET' && p === '/services') return json(res, 200, await db.services());
    if (req.method === 'GET' && p.startsWith('/listings/') && p.endsWith('/insights')) {
      const id = p.split('/')[2];
      const item = await db.getListing(id);
      if (!item) return json(res, 404, { error: 'Not found' });
      const now = Date.now(), wk = 7 * 864e5, since = now - 8 * wk;
      const evs = await db.eventsForListing(id, since);
      const weeks = Array.from({ length: 8 }, (_, i) => {
        const lo = now - (8 - i) * wk, hi = now - (7 - i) * wk;
        return evs.filter((e) => e.ts >= lo && e.ts < hi).length;
      });
      const views = evs.length;
      const bk = (await db.bookingsForListing(id)).filter((b) => new Date(b.createdAt).getTime() >= since);
      const bookings = bk.length;
      const earnings = bk.reduce((s, b) => s + (b.payout || 0), 0);
      const conv = views ? Math.round(bookings / views * 100) : 0;
      // occupancy: booked nights in the last 8 weeks / 56
      const nights = (item.booked || []).reduce((s, [a, b2]) => {
        const lo = Math.max(a, since), hi = Math.min(b2, now);
        return s + (hi > lo ? Math.round((hi - lo) / 864e5) : 0);
      }, 0);
      const occ = Math.min(100, Math.round(nights / 56 * 100));
      return json(res, 200, { weeks, views, bookings, conv, occ, earnings, rate: item.price, rating: item.rating || null, real: true });
    }
    if (req.method === 'GET' && p.startsWith('/listings/')) {
      const item = await db.getListing(p.split('/')[2]);
      if (!item) return json(res, 404, { error: 'Not found' });
      return json(res, 200, { ...item, host: await db.getHost(item.hostId) });
    }

    // ---- photo uploads ----
    if (req.method === 'GET' && p.startsWith('/uploads/')) {
      try {
        const buf = fs.readFileSync(path.join(storage.UPLOAD_DIR, path.basename(p)));
        const ext = path.extname(p).slice(1).toLowerCase();
        res.writeHead(200, { 'Content-Type': 'image/' + (ext === 'jpg' ? 'jpeg' : ext || 'octet-stream') });
        return res.end(buf);
      } catch (e) { return json(res, 404, { error: 'Not found' }); }
    }
    if (req.method === 'POST' && p === '/uploads') {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const rl = limit('upload:' + contact, 30, 60 * 1000);
      if (!rl.ok) { res.setHeader('Retry-After', String(rl.retryAfter)); return json(res, 429, { error: 'Too many uploads' }); }
      const body = await readJson(req);
      if (storage.mode() === 's3') {
        if (!body.contentType) return json(res, 400, { error: 'contentType required' });
        const ext = (body.contentType.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
        const key = 'uploads/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext;
        return json(res, 200, { mode: 's3', ...storage.presign(key, body.contentType) });
      }
      try { return json(res, 201, { mode: 'local', ...storage.saveLocal(body.dataUrl) }); }
      catch (e) { return json(res, 400, { error: String(e.message) }); }
    }

    // ---- ID verification ----
    if (req.method === 'POST' && p === '/verify/start') {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const body = await readJson(req);
      const subjectType = body.subjectType === 'host' ? 'host' : 'guest';
      const subjectId = subjectType === 'host' ? (body.hostId || null) : contact;
      if (subjectType === 'host' && !subjectId) return json(res, 400, { error: 'hostId required for host verification' });
      const id = 'ver_' + randomToken(8);
      let session;
      try { session = await identity.createSession({ verificationId: id, subjectType, reference: id }); }
      catch (e) { return json(res, 502, { error: String(e.message) }); }
      await db.saveVerification(id, { id, subjectType, subjectId, contact, providerId: session.providerId, status: 'pending', createdAt: Date.now() });
      return json(res, 200, { id, url: session.url, status: session.status, dev: identity.mode() === 'dev' });
    }
    if (req.method === 'POST' && p === '/verify/dev-complete') {
      if (PROD) return json(res, 404, { error: 'Not found' });
      const { id, result = 'approved' } = await readJson(req);
      const v = await db.getVerification(id);
      if (!v) return json(res, 404, { error: 'verification not found' });
      await applyVerificationResult(v, result === 'approved' ? 'approved' : 'declined');
      return json(res, 200, { ok: true, id, status: result });
    }
    if (req.method === 'POST' && p === '/webhooks/identity') {
      const raw = await readRaw(req);
      let evt;
      try { evt = identity.verifyWebhook(raw, req.headers['x-signature'] || req.headers['hoy-signature']); }
      catch (e) { return json(res, 400, { error: String(e.message) }); }
      const vid = (evt.metadata && evt.metadata.verificationId) || evt.client_reference_id || evt.id;
      const ok = evt.status === 'verified' || evt.status === 'approved' || evt.type === 'identity.verified';
      const v = await db.getVerification(vid);
      if (v) await applyVerificationResult(v, ok ? 'approved' : 'declined');
      return json(res, 200, { ok: true });
    }
    // ---- card payments: create a Stripe Checkout session for a booking ----
    if (req.method === 'POST' && p.startsWith('/bookings/') && p.endsWith('/checkout')) {
      console.log('[checkout] hit', p, '· paymentsOn:', PAYMENTS_ON);
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const b = await db.getBooking(p.split('/')[2]);
      if (!b) return json(res, 404, { error: 'Not found' });
      if (b.guestContact !== contact) return json(res, 403, { error: 'Not your booking' });
      if (!PAYMENTS_ON) return json(res, 200, { enabled: false, message: 'Card payments are not configured yet. Set STRIPE_SECRET_KEY to turn them on.' });
      try {
        const session = await stripeRequest('checkout/sessions', {
          mode: 'payment',
          'payment_method_types[0]': 'card',
          success_url: APP_URL + '/?paid=' + encodeURIComponent(b.id),
          cancel_url: APP_URL + '/?payment_cancelled=' + encodeURIComponent(b.id),
          client_reference_id: b.id,
          'metadata[bookingId]': b.id,
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': String(b.currency || 'usd').toLowerCase(),
          'line_items[0][price_data][unit_amount]': String(Math.round((b.total || 0) * 100)),
          'line_items[0][price_data][product_data][name]': (b.listingTitle || 'Hoy booking') + ' · ' + (b.when || ''),
        });
        b.paymentStatus = 'pending'; b.checkoutSessionId = session.id; await db.updateBooking(b);
        return json(res, 200, { enabled: true, url: session.url, sessionId: session.id });
      } catch (e) {
        console.error('[checkout] Stripe session failed:', e.message);
        return json(res, 502, { error: 'Payment setup failed: ' + e.message });
      }
    }
    // ---- card payments: Stripe webhook (confirms payment server-side) ----
    if (req.method === 'POST' && p === '/webhooks/stripe') {
      const raw = await readRaw(req);
      if (STRIPE_WEBHOOK_SECRET && !verifyStripeSig(raw, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) {
        return json(res, 400, { error: 'Invalid signature' });
      }
      let evt; try { evt = JSON.parse(raw); } catch (e) { return json(res, 400, { error: 'Bad payload' }); }
      if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') {
        const o = evt.data && evt.data.object ? evt.data.object : {};
        const ref = o.client_reference_id || (o.metadata && o.metadata.bookingId);
        if (ref) {
          const b = await db.getBooking(ref);
          if (b) {
            b.paymentStatus = 'paid'; b.paidAt = Date.now();
            // Send the confirmation now that payment succeeded — once only (Stripe may retry the webhook).
            if (PROVIDERS_ON && !b.notifiedPaid) {
              b.notifiedPaid = true;
              const payload = {
                ref: b.id, title: b.listingTitle, city: b.city, when: b.when, guests: b.guestsLabel,
                total: b.total, payout: b.payout, exp: b.isExperience, currency: b.currency,
                checkIn: b.checkIn, checkOut: b.checkOut,
                host: { name: b.host && b.host.name, evc: b.host && b.host.evc },
              };
              const guestParty = { channel: b.guestChannel || (isEmail(b.guestContact) ? 'email' : 'text'), to: b.guestContact };
              const hostParty = { channel: (b.host && b.host.notify) || 'email', to: (b.host && b.host.notify === 'text' ? b.host.phone : b.host.email) };
              queue.enqueue(() => notify.sendToParty(guestParty, payload, false), { label: 'paid notify guest ' + b.id });
              queue.enqueue(() => notify.sendToParty(hostParty, payload, true), { label: 'paid notify host ' + b.id });
            }
            await db.updateBooking(b);
          }
        }
      }
      return json(res, 200, { received: true });
    }


    if (req.method === 'POST' && p === '/auth/request-code') {
      const { contact } = await readJson(req);
      if (!contact) return json(res, 400, { error: 'contact required' });
      const rl = limit('code:' + ip, 5, 15 * 60 * 1000);       // 5 / 15min per IP
      const rl2 = limit('code:' + contact, 3, 15 * 60 * 1000);  // 3 / 15min per contact
      if (!rl.ok || !rl2.ok) { res.setHeader('Retry-After', String((rl.retryAfter || rl2.retryAfter))); return json(res, 429, { error: 'Too many code requests, try again later' }); }
      const code = sixDigitCode();
      await db.saveOtp(contact, { codeHash: hmac(contact + ':' + code), expires: Date.now() + OTP_TTL_MS, attempts: 0 });
      if (PROVIDERS_ON) {
        queue.enqueue(() => sendCode(contact, code, isEmail(contact) ? 'email' : 'text'), { label: 'login code ' + contact });
      }
      return json(res, 200, { ok: true, ...(DEV_RETURN_OTP ? { devCode: code } : {}) });
    }

    if (req.method === 'POST' && p === '/auth/verify') {
      const { contact, code } = await readJson(req);
      const rl = limit('verify:' + ip, 10, 15 * 60 * 1000);
      if (!rl.ok) { res.setHeader('Retry-After', String(rl.retryAfter)); return json(res, 429, { error: 'Too many attempts' }); }
      const rec = await db.getOtp(contact);
      if (!rec) return json(res, 401, { error: 'no code requested' });
      if (Date.now() > rec.expires) { await db.deleteOtp(contact); return json(res, 401, { error: 'code expired' }); }
      rec.attempts = (rec.attempts || 0) + 1;
      if (rec.attempts > 5) { await db.deleteOtp(contact); return json(res, 401, { error: 'too many attempts' }); }
      if (!safeEqual(hmac(contact + ':' + code), rec.codeHash)) { await db.saveOtp(contact, rec); return json(res, 401, { error: 'wrong code' }); }
      await db.deleteOtp(contact);
      const token = randomToken(24);
      await db.saveSession(hashToken(token), { contact, expires: Date.now() + SESSION_TTL_MS });
      return json(res, 200, { ok: true, token, contact });
    }

    if (req.method === 'POST' && p === '/auth/logout') {
      const h = req.headers['authorization'] || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (token) await db.deleteSession(hashToken(token));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/me/bookings') {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      return json(res, 200, (await db.bookingsForContact(contact)).map((b) => publicBookingFor(b, 'guest')));
    }

    // ---- host: my earnings (full transparency, host's own bookings only) ----
    if (req.method === 'GET' && p === '/host/earnings') {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const host = await hostForContact(contact);
      if (!host) return json(res, 200, { isHost: false, paidOut: 0, inEscrow: 0, lifetime: 0, bookings: [] });
      const now = Date.now();
      const completesTs = (b) => {
        if (!b.checkIn) return now;
        const start = new Date(b.checkIn).getTime();
        if (b.isService || b.isExperience) return start;
        return b.checkOut ? new Date(b.checkOut).getTime() : start;
      };
      const all = (await db.allBookings()).filter((b) => b.host && b.host.id === host.id && b.status !== 'cancelled' && b.status !== 'declined');
      const rows = all.map((b) => ({
        ref: b.id, listing: b.listingTitle, when: b.when, guests: b.guestsLabel,
        category: b.isService ? 'service' : (b.isExperience ? 'experience' : 'home'),
        sub: b.sub || 0, cleaning: b.cleaning || 0, earlyCheckInFee: b.earlyCheckInFee || 0,
        grossBeforeFee: (b.payout || 0) + (b.hostFee || 0),   // what you'd get before Hoy's host fee
        hostFee: b.hostFee || 0, guestServiceFee: b.guestFee || 0, guestPaid: b.total || 0,
        payout: b.payout || 0, currency: b.currency || 'USD',
        status: b.status, paid: b.status === 'released', paidAt: b.releasedAt || null,
        completesTs: completesTs(b), completed: completesTs(b) <= now,
      })).sort((a, b) => b.completesTs - a.completesTs);
      const sum = (arr) => arr.reduce((s, r) => s + r.payout, 0);
      const released = rows.filter((r) => r.status === 'released');
      const held = rows.filter((r) => r.status === 'held');
      return json(res, 200, {
        isHost: true, host: { name: host.name, evc: host.evc }, feeRatePct: 3,
        paidOut: sum(released), inEscrow: sum(held), lifetime: sum(released) + sum(held),
        hostFeesPaid: rows.reduce((s, r) => s + r.hostFee, 0),
        guestServiceFeesCollected: rows.reduce((s, r) => s + r.guestServiceFee, 0),
        bookings: rows,
      });
    }

    // ---- host: incoming requests + accept/decline ----
    if (req.method === 'GET' && p === '/host/bookings') {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const host = await hostForContact(contact);
      if (!host) return json(res, 200, []); // signed-in user isn't a host
      const all = await db.allBookings();
      return json(res, 200, all.filter((b) => b.host && b.host.id === host.id).map((b) => publicBookingFor(b, 'host')));
    }

    if (req.method === 'POST' && p.startsWith('/bookings/') && (p.endsWith('/accept') || p.endsWith('/decline'))) {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const id = p.split('/')[2];
      const b = await db.getBooking(id);
      if (!b) return json(res, 404, { error: 'Not found' });
      const host = await hostForContact(contact);
      const isHost = host && b.host && host.id === b.host.id;
      if (!isHost && !isAdminContact(contact)) return json(res, 403, { error: 'Only the host can respond to this booking' });
      if (b.status !== 'requested') return json(res, 409, { error: 'This booking is not awaiting a response' });
      const accepting = p.endsWith('/accept');
      if (accepting) {
        b.status = 'held'; b.acceptedAt = new Date().toISOString();
      } else {
        b.status = 'declined'; b.declinedAt = new Date().toISOString();
        if (b.checkIn && b.checkOut) await db.removeListingBooked(b.listingId, [startOfDay(b.checkIn), startOfDay(b.checkOut)]); // free the dates
      }
      await db.updateBooking(b);
      if (PROVIDERS_ON) {
        const guestParty = { channel: isEmail(b.guestContact) ? 'email' : 'text', to: b.guestContact };
        queue.enqueue(() => notify.sendToParty(guestParty, { ref: b.id, title: b.listingTitle, when: b.when, status: b.status }, false), { label: (accepting ? 'accept ' : 'decline ') + b.id });
      }
      return json(res, 200, { ok: true, booking: publicBookingFor(b, isHost ? 'host' : 'admin') });
    }

    // ---- guest cancels their own booking (20% fee if within 24h of start) ----
    if (req.method === 'POST' && p.startsWith('/bookings/') && p.endsWith('/cancel')) {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const id = p.split('/')[2];
      const b = await db.getBooking(id);
      if (!b) return json(res, 404, { error: 'Not found' });
      if (b.guestContact !== contact && !isAdminContact(contact)) return json(res, 403, { error: 'Not your booking' });
      if (b.status === 'cancelled') return json(res, 409, { error: 'Already cancelled' });
      const { fee, refund, late, grace } = guestRefund(b);
      b.status = 'cancelled'; b.cancelledBy = 'guest'; b.cancelledAt = new Date().toISOString();
      b.cancelFee = fee; b.refund = refund;
      if (b.checkIn && b.checkOut) await db.removeListingBooked(b.listingId, [startOfDay(b.checkIn), startOfDay(b.checkOut)]);
      await db.updateBooking(b);
      return json(res, 200, { ok: true, fee, refund, lateCancel: late, gracePeriod: !!grace, feePct: GUEST_CANCEL_FEE_PCT });
    }

    // ---- guest modifies a booking (dates / guests / check-in time) ----
    if (req.method === 'POST' && p.startsWith('/bookings/') && p.endsWith('/modify')) {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const id = p.split('/')[2];
      const b = await db.getBooking(id);
      if (!b) return json(res, 404, { error: 'Not found' });
      if (b.guestContact !== contact && !isAdminContact(contact)) return json(res, 403, { error: 'Not your booking' });
      if (b.status === 'cancelled') return json(res, 409, { error: 'Booking is cancelled' });
      const body = await readJson(req);
      const item = await db.getListing(b.listingId);
      if (!item) return json(res, 404, { error: 'Listing not found' });
      const isService = item.kind === 'service' || (await db.services()).some((s) => s.id === b.listingId);
      const isExperience = (await db.experiences()).some((e) => e.id === b.listingId) || item.kind === 'experience';
      const perGuest = isExperience || isService;
      const guests = body.guests != null ? Math.max(1, parseInt(body.guests)) : b.guests;
      const checkInTime = body.checkInTime !== undefined ? body.checkInTime : b.checkInTime;
      let nights = 1, when = b.when, checkIn = b.checkIn, checkOut = b.checkOut, range = null;
      if (!perGuest) {
        checkIn = body.checkIn || b.checkIn; checkOut = body.checkOut || b.checkOut;
        if (!checkIn || !checkOut) return json(res, 400, { error: 'checkIn and checkOut required' });
        nights = nightsBetween(checkIn, checkOut);
        if (nights < 1) return json(res, 400, { error: 'checkOut must be after checkIn' });
        const inTs = startOfDay(checkIn), outTs = startOfDay(checkOut);
        // free old dates before checking availability so an unchanged/extended range doesn't self-collide
        if (b.checkIn && b.checkOut) await db.removeListingBooked(b.listingId, [startOfDay(b.checkIn), startOfDay(b.checkOut)]);
        if (overlaps((await db.getListing(b.listingId)).booked, inTs, outTs)) {
          await db.updateListingBooked(b.listingId, [startOfDay(b.checkIn), startOfDay(b.checkOut)]); // restore
          return json(res, 409, { error: 'Those dates are not available' });
        }
        await db.updateListingBooked(b.listingId, [inTs, outTs]);
        when = `${new Date(checkIn).toDateString()} – ${new Date(checkOut).toDateString()}`;
      } else if (body.checkIn) { checkIn = body.checkIn; when = new Date(checkIn).toDateString(); }
      const pricing = computePricing({ price: item.price, nights, guests, isExperience: perGuest });
      const earlyFee = earlyCheckInFee(item, checkInTime, perGuest);
      if (earlyFee) { pricing.earlyCheckInFee = earlyFee; pricing.total += earlyFee; pricing.payout += earlyFee; }
      Object.assign(b, { guests, checkIn, checkOut, checkInTime, when, ...pricing, modifiedAt: new Date().toISOString() });
      await db.updateBooking(b);
      return json(res, 200, { ok: true, booking: publicBookingFor(b, 'guest') });
    }

    // ---- host cancels a confirmed booking (guest fully refunded; counts against the host) ----
    if (req.method === 'POST' && p.startsWith('/bookings/') && p.endsWith('/host-cancel')) {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const id = p.split('/')[2];
      const b = await db.getBooking(id);
      if (!b) return json(res, 404, { error: 'Not found' });
      const host = await hostForContact(contact);
      const isHost = host && b.host && host.id === b.host.id;
      if (!isHost && !isAdminContact(contact)) return json(res, 403, { error: 'Only the host can cancel this booking' });
      if (b.status === 'cancelled') return json(res, 409, { error: 'Already cancelled' });
      const late = hoursUntilStart(b) < HOST_LATE_WINDOW_HRS;
      b.status = 'cancelled'; b.cancelledBy = 'host'; b.cancelledAt = new Date().toISOString();
      b.lateCancel = late; b.refund = b.total || 0; b.cancelFee = 0; // guest fully refunded
      if (b.checkIn && b.checkOut) await db.removeListingBooked(b.listingId, [startOfDay(b.checkIn), startOfDay(b.checkOut)]);
      await db.updateBooking(b);
      // recompute the host's cancellation rate and suspend if over the threshold
      const hostId = b.host && b.host.id;
      const all = (await db.allBookings()).filter((x) => x.host && x.host.id === hostId);
      const total = all.length;
      const hostCancels = all.filter((x) => x.cancelledBy === 'host').length;
      const lateCancels = all.filter((x) => x.cancelledBy === 'host' && x.lateCancel).length;
      const rate = total ? hostCancels / total : 0;
      let suspended = false;
      if (hostId && total >= HOST_SUSPEND_MIN_BOOKINGS && rate >= HOST_SUSPEND_RATE) { await db.setHostStatus(hostId, 'suspended'); suspended = true; }
      return json(res, 200, { ok: true, refundedGuest: b.refund, lateCancel: late, cancellationRate: Math.round(rate * 100), hostCancels, total, lateCancels, hostSuspended: suspended, threshold: Math.round(HOST_SUSPEND_RATE * 100) });
    }

    // ---- dispute / resolution center ----
    if (req.method === 'POST' && p.startsWith('/bookings/') && p.endsWith('/dispute')) {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const id = p.split('/')[2];
      const b = await db.getBooking(id);
      if (!b) return json(res, 404, { error: 'Not found' });
      const host = await hostForContact(contact);
      const isParty = b.guestContact === contact || (host && b.host && host.id === b.host.id) || isAdminContact(contact);
      if (!isParty) return json(res, 403, { error: 'Not your booking' });
      const body = await readJson(req);
      const d = {
        id: 'DSP-' + randomToken(3).toUpperCase(), bookingId: id, listingTitle: b.listingTitle,
        openedBy: contact, openedRole: (host && b.host && host.id === b.host.id) ? 'host' : 'guest',
        guestContact: b.guestContact, hostId: b.host && b.host.id,
        reason: String(body.reason || 'other'), detail: scrubContact(String(body.detail || '')).text.slice(0, 2000),
        status: 'open', createdAt: new Date().toISOString(),
      };
      await db.addDispute(d);
      return json(res, 201, { ok: true, dispute: d });
    }
    if (req.method === 'GET' && p === '/disputes') {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      return json(res, 200, await db.disputesForContact(contact));
    }
    if (req.method === 'GET' && p === '/admin/disputes') {
      if (!(await requireAdmin(req, res))) return;
      return json(res, 200, await db.allDisputes());
    }
    if (req.method === 'POST' && p.startsWith('/admin/disputes/') && p.endsWith('/resolve')) {
      if (!(await requireAdmin(req, res))) return;
      const id = p.split('/')[3];
      const d = await db.getDispute(id);
      if (!d) return json(res, 404, { error: 'Not found' });
      const body = await readJson(req);
      d.status = 'resolved'; d.resolution = String(body.resolution || '').slice(0, 2000); d.resolvedAt = new Date().toISOString();
      if (body.refund != null) { const b = await db.getBooking(d.bookingId); if (b) { b.refund = Math.round(Number(body.refund)) || 0; await db.updateBooking(b); } }
      await db.updateDispute(d);
      return json(res, 200, { ok: true, dispute: d });
    }

    // ---- reporting / safety line ----
    if (req.method === 'POST' && p === '/reports') {
      const contact = await authContact(req);
      const body = await readJson(req);
      const r = {
        id: 'RPT-' + randomToken(4), reporter: contact || 'anonymous',
        targetType: String(body.targetType || 'other'), targetId: String(body.targetId || ''),
        category: String(body.category || 'other'), urgent: !!body.urgent,
        detail: scrubContact(String(body.detail || '')).text.slice(0, 2000),
        status: 'new', createdAt: new Date().toISOString(),
      };
      await db.addReport(r);
      return json(res, 201, { ok: true, reportId: r.id, urgent: r.urgent });
    }
    if (req.method === 'GET' && p === '/admin/reports') {
      if (!(await requireAdmin(req, res))) return;
      return json(res, 200, await db.allReports());
    }
    if (req.method === 'POST' && p.startsWith('/admin/reports/') && p.endsWith('/resolve')) {
      if (!(await requireAdmin(req, res))) return;
      const id = p.split('/')[3];
      const all = await db.allReports(); const r = all.find((x) => x.id === id);
      if (!r) return json(res, 404, { error: 'Not found' });
      const body = await readJson(req);
      r.status = 'actioned'; r.note = String(body.note || '').slice(0, 1000); r.resolvedAt = new Date().toISOString();
      await db.updateReport(r);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/admin/run-lifecycle') {
      if (!(await requireAdmin(req, res))) return;
      const r = await runLifecyclePass();
      return json(res, 200, { ok: true, ...r });
    }

    // ---- public host performance profile ----
    if (req.method === 'GET' && p.startsWith('/hosts/') && p.endsWith('/profile')) {
      const hid = p.split('/')[2];
      const host = await db.getHost(hid);
      if (!host) return json(res, 404, { error: 'Not found' });
      const all = (await db.allBookings()).filter((x) => x.host && x.host.id === hid);
      const total = all.length;
      const hostCancels = all.filter((x) => x.cancelledBy === 'host').length;
      const decided = all.filter((x) => ['held', 'accepted', 'released', 'declined'].includes(x.status) || x.cancelledBy);
      const accepted = all.filter((x) => ['held', 'accepted', 'released'].includes(x.status)).length;
      const listings = (await db.listings()).filter((l) => l.hostId === hid);
      const hostServices = (await db.services()).filter((s) => s.hostId === hid);
      const ratedAll = listings.concat(hostServices).filter((l) => l.rating);
      const seedAvg = ratedAll.length ? (ratedAll.reduce((s, l) => s + Number(l.rating), 0) / ratedAll.length) : null;
      const reviews = await db.reviewsForHost(hid);
      const reviewAvg = reviews.length ? (reviews.reduce((s, r) => s + (Number(r.rating) || 0), 0) / reviews.length) : null;
      const avgRating = reviewAvg != null ? reviewAvg : seedAvg;
      return json(res, 200, {
        id: host.id, name: host.name, city: host.city, status: host.status,
        verified: host.status === 'active',
        stats: {
          rating: avgRating ? Math.round(avgRating * 100) / 100 : null,
          reviewCount: reviews.length,
          listings: listings.length, services: hostServices.length, totalBookings: total,
          cancellationRate: total ? Math.round((hostCancels / total) * 100) : 0,
          acceptanceRate: decided.length ? Math.round((accepted / decided.length) * 100) : null,
        },
        reviews,
      });
    }

    // ---- guest leaves a review (only after the stay/service is complete) ----
    if (req.method === 'POST' && p.startsWith('/bookings/') && p.endsWith('/review')) {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const b = await db.getBooking(p.split('/')[2]);
      if (!b) return json(res, 404, { error: 'Not found' });
      if (b.guestContact !== contact) return json(res, 403, { error: 'Only the guest can review this booking' });
      if (!['held', 'accepted', 'released'].includes(b.status)) return json(res, 409, { error: 'You can review once the booking is confirmed and complete' });
      const now = Date.now();
      const start = b.checkIn ? new Date(b.checkIn).getTime() : now;
      const end = (b.isService || b.isExperience) ? start : (b.checkOut ? new Date(b.checkOut).getTime() : start);
      if (end > now) return json(res, 409, { error: 'You can leave a review after your stay or service is complete' });
      if (b.reviewed) return json(res, 409, { error: 'You already reviewed this booking' });
      const { rating, text } = await readJson(req);
      const r = Math.max(1, Math.min(5, parseInt(rating, 10) || 5));
      const clean = scrubContact(String(text || '').slice(0, 1000));
      const review = { id: 'rv_' + randomToken(4), hostId: b.host.id, listingId: b.listingId, bookingId: b.id, guest: 'Verified guest', rating: r, text: clean.text, ts: Date.now() };
      await db.addReview(review);
      b.reviewed = true; await db.updateBooking(b);
      return json(res, 200, { ok: true, review });
    }


    if (p.startsWith('/bookings/') && p.endsWith('/messages')) {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const id = p.split('/')[2];
      const b = await db.getBooking(id);
      if (!b) return json(res, 404, { error: 'Not found' });
      const host = await hostForContact(contact);
      const isHost = host && b.host && host.id === b.host.id;
      const isGuest = b.guestContact === contact;
      if (!isHost && !isGuest && !isAdminContact(contact)) return json(res, 403, { error: 'Not your booking' });
      // Messaging opens only once the host has accepted (instant bookings are already 'held').
      const messagingOpen = ['held', 'accepted', 'released'].includes(b.status);
      if (req.method === 'GET') {
        if (b.status === 'requested') return json(res, 200, { messages: [], locked: true, reason: 'awaiting_acceptance' });
        return json(res, 200, { messages: b.messages || [] });
      }
      if (req.method === 'POST') {
        if (!messagingOpen) return json(res, 403, { error: 'Messaging opens once the host accepts the request.', locked: true });
        const { text } = await readJson(req);
        if (!text || !String(text).trim()) return json(res, 400, { error: 'Message text required' });
        const clean = scrubContact(String(text).slice(0, 2000));
        const msg = { from: isHost ? 'host' : 'guest', text: clean.text, ts: Date.now() };
        b.messages = b.messages || []; b.messages.push(msg);
        await db.updateBooking(b);
        return json(res, 200, { ok: true, message: msg, redacted: clean.redacted });
      }
    }

    if (req.method === 'POST' && p === '/bookings') {
      const contact = await authContact(req);
      if (!contact) return json(res, 401, { error: 'Sign in required' });
      const rl = limit('book:' + contact, 20, 60 * 1000);
      if (!rl.ok) { res.setHeader('Retry-After', String(rl.retryAfter)); return json(res, 429, { error: 'Too many bookings, slow down' }); }
      return await createBooking(res, contact, await readJson(req), req);
    }

    // ----------------- ADMIN (operator console) -----------------
    // All require a logged-in session whose contact is in ADMIN_EMAILS
    // (in dev, any logged-in user is admin for convenience).
    if (p === '/admin/stats' && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      const hosts = await db.hosts();
      const bookings = await db.allBookings();
      const held = bookings.filter((b) => b.status === 'held');
      const released = bookings.filter((b) => b.status === 'released');
      const sum = (arr, k) => arr.reduce((s, b) => s + (b[k] || 0), 0);
      return json(res, 200, {
        hosts: { total: hosts.length, active: hosts.filter((h) => h.status === 'active').length, pending: hosts.filter((h) => h.status === 'pending').length, suspended: hosts.filter((h) => h.status === 'suspended').length },
        bookings: { total: bookings.length, held: held.length, released: released.length },
        money: { inEscrow: sum(held, 'payout'), released: sum(released, 'payout'), revenue: bookings.reduce((s, b) => s + (b.guestFee || 0) + (b.hostFee || 0), 0) },
      });
    }

    if (p === '/admin/searches' && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      const evs = await db.searchEvents();
      const counts = {};
      evs.forEach((e) => { const q = (e.query || '').trim(); if (!q) return; counts[q] = (counts[q] || 0) + 1; });
      const top = Object.entries(counts).map(([query, count]) => ({ query, count })).sort((a, b) => b.count - a.count).slice(0, 25);
      return json(res, 200, { total: evs.length, unique: Object.keys(counts).length, top });
    }

    if (p === '/admin/revenue' && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      const bookings = (await db.allBookings()).filter((b) => b.status !== 'cancelled' && b.status !== 'declined');
      const sum = (arr, fn) => arr.reduce((s, b) => s + (fn(b) || 0), 0);
      const held = bookings.filter((b) => b.status === 'held');
      const released = bookings.filter((b) => b.status === 'released');
      const byCat = { homes: 0, experiences: 0, services: 0 };
      bookings.forEach((b) => { const c = b.isService ? 'services' : (b.isExperience ? 'experiences' : 'homes'); byCat[c] += (b.guestFee || 0) + (b.hostFee || 0); });
      return json(res, 200, {
        gmv: sum(bookings, (b) => b.total),                              // total guests paid
        platformRevenue: sum(bookings, (b) => (b.guestFee || 0) + (b.hostFee || 0)), // Hoy's cut
        hostPayouts: sum(bookings, (b) => b.payout),
        inEscrow: sum(held, (b) => b.payout),
        releasedToHosts: sum(released, (b) => b.payout),
        bookings: bookings.length,
        revenueByCategory: byCat,
      });
    }

    // Who needs to get paid: held bookings whose stay/service has completed (Airbnb-style "after").
    if (p.startsWith('/admin/payouts') && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      const now = Date.now();
      const dueTs = (b) => {
        if (!b.checkIn) return now; // date TBD -> treat as due once held
        const start = new Date(b.checkIn).getTime();
        if (b.isService || b.isExperience) return start;          // after the service date
        return (b.checkOut ? new Date(b.checkOut).getTime() : start) ; // homes: after checkout (stay complete)
      };
      const held = (await db.allBookings()).filter((b) => b.status === 'held');
      const rows = held.map((b) => ({
        ref: b.id, host: (b.host && b.host.name) || '—', evc: (b.host && b.host.evc) || '—',
        listing: b.listingTitle, when: b.when, payout: b.payout || 0, currency: b.currency || 'USD',
        category: b.isService ? 'service' : (b.isExperience ? 'experience' : 'home'),
        dueTs: dueTs(b), due: dueTs(b) <= now,
      }));
      const due = rows.filter((r) => r.due).sort((a, b) => a.dueTs - b.dueTs);
      const scheduled = rows.filter((r) => !r.due).sort((a, b) => a.dueTs - b.dueTs);
      if (p === '/admin/payouts.csv') {
        const esc = (v) => '"' + String(v).replace(/"/g, '""') + '"';
        const header = ['Status', 'Booking', 'Host', 'EVC', 'Listing', 'Dates', 'Payout', 'Currency', 'Category', 'Due date'];
        const fmtD = (t) => new Date(t).toISOString().slice(0, 10);
        const lines = [header.join(',')];
        due.forEach((r) => lines.push(['DUE NOW', r.ref, r.host, r.evc, r.listing, r.when, r.payout, r.currency, r.category, fmtD(r.dueTs)].map(esc).join(',')));
        scheduled.forEach((r) => lines.push(['scheduled', r.ref, r.host, r.evc, r.listing, r.when, r.payout, r.currency, r.category, fmtD(r.dueTs)].map(esc).join(',')));
        const csv = lines.join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="hoy-payouts-${fmtD(now)}.csv"` });
        return res.end(csv);
      }
      const total = (arr) => arr.reduce((s, r) => s + r.payout, 0);
      return json(res, 200, { date: new Date(now).toISOString().slice(0, 10), due, scheduled, dueTotal: total(due), scheduledTotal: total(scheduled) });
    }


    if (p.startsWith('/admin/hosts/') && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      const h = await db.getHost(p.split('/')[3]);
      return h ? json(res, 200, h) : json(res, 404, { error: 'Not found' });
    }
    if (p.startsWith('/admin/hosts/') && p.endsWith('/approve') && req.method === 'POST') {
      if (!(await requireAdmin(req, res))) return;
      const h = await db.setHostStatus(p.split('/')[3], 'active');
      return h ? json(res, 200, { ok: true, host: h }) : json(res, 404, { error: 'Not found' });
    }
    if (p.startsWith('/admin/hosts/') && p.endsWith('/suspend') && req.method === 'POST') {
      if (!(await requireAdmin(req, res))) return;
      const h = await db.setHostStatus(p.split('/')[3], 'suspended');
      return h ? json(res, 200, { ok: true, host: h }) : json(res, 404, { error: 'Not found' });
    }

    if (p === '/admin/bookings' && req.method === 'GET') {
      if (!(await requireAdmin(req, res))) return;
      return json(res, 200, await db.allBookings());
    }
    if (p.startsWith('/admin/bookings/') && p.endsWith('/release') && req.method === 'POST') {
      if (!(await requireAdmin(req, res))) return;
      const b = await db.setBookingStatus(p.split('/')[3], 'released');
      if (!b) return json(res, 404, { error: 'Not found' });
      const host = b.host && b.host.id ? await db.getHost(b.host.id) : null;
      if (host && PROVIDERS_ON) queue.enqueue(() => notify.sendToParty({ channel: host.notify || 'email', to: host.notify === 'text' ? host.phone : host.email }, { ref: b.id, title: b.listingTitle, payout: b.payout, currency: b.currency, host: { name: host.name, evc: host.evc } }, true), { label: 'payout ' + b.id });
      return json(res, 200, { ok: true, booking: b });
    }
    if (p.startsWith('/admin/bookings/') && p.endsWith('/hold') && req.method === 'POST') {
      if (!(await requireAdmin(req, res))) return;
      const b = await db.setBookingStatus(p.split('/')[3], 'held');
      return b ? json(res, 200, { ok: true, booking: b }) : json(res, 404, { error: 'Not found' });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    return json(res, 400, { error: String(err.message || err) });
  }
});

/* -------------------- login-code delivery (via notifier rails) -------------------- */
async function sendCode(contact, code, channel) {
  if (channel === 'email' && notify.__sendEmail) {
    const html = `<div style="font-family:Arial,sans-serif;max-width:380px;margin:0 auto;padding:20px;border:1px solid #E2D6C2;border-radius:14px">
      <div style="color:#0E5454;font-size:20px;font-weight:700;margin-bottom:12px">Hoy</div>
      <p style="font-size:14px;color:#3a3027">Your login code is:</p>
      <div style="font-size:30px;font-weight:800;letter-spacing:6px;color:#241C16;margin:8px 0">${code}</div>
      <p style="font-size:12px;color:#8a7d6a">It expires in 10 minutes. If you didn't request it, ignore this message.</p></div>`;
    return notify.__sendEmail(contact, 'Your Hoy login code', html);
  }
  if (channel === 'text' && notify.__sendSMS) return notify.__sendSMS(contact, `Hoy login code: ${code} (valid 10 min)`);
  return null;
}

/* -------------------- booking -------------------- */
async function createBooking(res, contact, body, req) {
  const idemKey = (req && req.headers['idempotency-key']) || body.idempotencyKey || null;
  if (idemKey) {
    const prior = await db.getIdem(idemKey);
    if (prior) { const b = await db.getBooking(prior); return json(res, 200, { ok: true, booking: b, idempotent: true }); }
  }
  const { listingId, checkIn, checkOut, checkInTime = null, guests = 2, guestChannel, currency = 'USD' } = body;
  const item = await db.getListing(listingId);
  if (!item) return json(res, 404, { error: 'Listing not found' });
  const isService = item.kind === 'service' || (await db.services()).some((s) => s.id === listingId);
  const isExperience = (await db.experiences()).some((e) => e.id === listingId) || item.kind === 'experience';
  const perGuest = isExperience || isService; // priced per guest, booked instantly (no nightly stay)

  let nights = 1, when, range = null;
  if (perGuest) {
    when = checkIn ? new Date(checkIn).toDateString() : 'Date TBD';
  } else {
    if (!checkIn || !checkOut) return json(res, 400, { error: 'checkIn and checkOut required' });
    nights = nightsBetween(checkIn, checkOut);
    if (nights < 1) return json(res, 400, { error: 'checkOut must be after checkIn' });
    const inTs = startOfDay(checkIn), outTs = startOfDay(checkOut);
    if (overlaps(item.booked, inTs, outTs)) return json(res, 409, { error: 'Those dates are not available' });
    range = [inTs, outTs];
    when = `${new Date(checkIn).toDateString()} – ${new Date(checkOut).toDateString()}`;
  }

  // Instant book is the host's choice. Per-guest items (experiences/services) default to instant
  // unless the host turned it off; rentals default to request-to-book unless the host turned it on.
  const instant = perGuest ? (item.instantBook !== false) : (item.instantBook === true);
  const pricing = computePricing({ price: item.price, nights, guests, isExperience: perGuest });
  const earlyFee = earlyCheckInFee(item, checkInTime, perGuest);
  if (earlyFee) { pricing.earlyCheckInFee = earlyFee; pricing.total += earlyFee; pricing.payout += earlyFee; }
  const host = (await db.getHost(item.hostId)) || {};
  const ref = 'HOY-' + randomToken(3).toUpperCase();
  const unit = isService ? 'guest' : 'person';
  const guestsLabel = guests + (perGuest ? (guests === 1 ? ' ' + unit : ' ' + unit + 's') : (guests === 1 ? ' guest' : ' guests'));

  const booking = {
    id: ref, listingId, listingTitle: item.title, city: item.city || item.loc, isExperience, isService,
    host: { id: host.id, name: host.name, email: host.email, phone: host.phone, notify: host.notify, evc: host.evc },
    guestContact: contact, guestChannel: guestChannel || null, when, checkIn: checkIn || null, checkOut: checkOut || null, checkInTime: checkInTime || null,
    guests, guestsLabel, currency, ...pricing,
    status: instant ? 'held' : 'requested',
    messages: [], createdAt: new Date().toISOString(),
  };

  await db.addBooking(booking);
  if (range) await db.updateListingBooked(listingId, range); // reserve dates while the request is pending
  if (idemKey) await db.saveIdem(idemKey, booking.id);

  // Queue notifications independently so each retries on its own and a failure
  // never undoes the booking.
  let notifications = 'skipped (no providers configured)';
  if (PROVIDERS_ON) {
    const payload = {
      ref, title: item.title, city: booking.city, when, guests: guestsLabel,
      total: pricing.total, payout: pricing.payout, exp: isExperience, currency,
      checkIn: checkIn || null, checkOut: checkOut || null,
      host: { name: host.name, evc: host.evc },
    };
    const guestParty = { channel: guestChannel || (isEmail(contact) ? 'email' : 'text'), to: contact };
    const hostParty = { channel: host.notify || 'email', to: (host.notify === 'text' ? host.phone : host.email) };
    if (instant) {
      // Instant booking: the guest's confirmation is sent after payment succeeds
      // (see the Stripe webhook). Nothing is emailed at this point.
      notifications = 'deferred to payment';
    } else {
      queue.enqueue(() => notify.sendToParty(guestParty, payload, false), { label: 'notify guest ' + ref });
      queue.enqueue(() => notify.sendToParty(hostParty, payload, true), { label: 'notify host ' + ref });
      notifications = 'queued';
    }
  }

  console.log('[booking] created', ref, '· listing', listingId, '· instant:', instant, '· requested:', !instant);
  return json(res, 201, { ok: true, booking: publicBookingFor(booking, 'guest'), requested: !instant, notifications });
}

/* -------------------- communication lifecycle scheduler -------------------- */
// Real scheduler: scans bookings on an interval and posts automated system messages
// (24h check-in reminder, post-stay review request) into each booking thread once.
function pushSystemMessage(b, text) {
  b.messages = b.messages || [];
  b.messages.push({ from: 'system', text, ts: Date.now() });
}
async function runLifecyclePass() {
  const now = Date.now();
  let reminders = 0, reviews = 0;
  const all = await db.allBookings();
  for (const b of all) {
    if (b.status === 'cancelled') continue;
    const startTs = b.checkIn ? new Date(b.checkIn).getTime() : null;
    const endTs = b.checkOut ? new Date(b.checkOut).getTime() : startTs;
    // check-in reminder: confirmed booking starting within the next 24h
    if (b.status === 'held' && startTs && !b.reminderSent && startTs - now > 0 && startTs - now <= 24 * 3600000) {
      pushSystemMessage(b, `⏰ Reminder: your booking "${b.listingTitle}" starts within 24 hours. ${b.checkInTime ? 'Check-in time: ' + b.checkInTime + '. ' : ''}Message your host here with your arrival time.`);
      b.reminderSent = true; await db.updateBooking(b); reminders++;
    }
    // review request: stay/service finished (only for accepted/confirmed bookings)
    if (!b.reviewRequested && endTs && endTs < now && ['held', 'accepted', 'released'].includes(b.status)) {
      pushSystemMessage(b, `🌟 How was "${b.listingTitle}"? Leave a review to help other guests — and the host can review you too.`);
      b.reviewRequested = true; await db.updateBooking(b); reviews++;
    }
  }
  return { reminders, reviews };
}
const LIFECYCLE_INTERVAL_MS = parseInt(process.env.LIFECYCLE_INTERVAL_MS || '60000', 10);

/* -------------------- start -------------------- */
db.init().then(() => {
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Hoy backend on http://localhost:${PORT}  (${PROD ? 'production' : 'dev'}, store: ${process.env.DATABASE_URL ? 'postgres' : 'json'})`);
  });
  if (LIFECYCLE_INTERVAL_MS > 0) {
    const timer = setInterval(() => { runLifecyclePass().catch(() => {}); }, LIFECYCLE_INTERVAL_MS);
    if (timer.unref) timer.unref(); // don't keep the process alive just for the timer
  }
}).catch((e) => { console.error('Failed to init DB:', e); process.exit(1); });

module.exports = server;
