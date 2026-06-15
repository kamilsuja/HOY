/**
 * hoy-notify.js — Hoy booking notification handler
 * ------------------------------------------------------------
 * Sends a booking confirmation to BOTH the guest and the host, each on
 * their chosen channel (email via Resend, or SMS via Twilio). This mirrors
 * the logic in the Hoy prototype — it just moves it server-side, where the
 * API keys can live safely.
 *
 * Runtime: Node 18+ (uses the built-in global `fetch`, `Buffer`,
 * `URLSearchParams`). No npm install required.
 *
 * Works as-is as a Vercel / Netlify / generic Node serverless function
 * (default export `handler`). You can also import { sendBookingNotifications }
 * into any backend (Express, Fastify, a queue worker, etc.).
 *
 * Required environment variables (NEVER hard-code keys, never ship them to
 * the browser):
 *   RESEND_API_KEY      re_xxx from https://resend.com
 *   RESEND_FROM         e.g. "Hoy <bookings@yourdomain.so>" (verified domain)
 *   TWILIO_ACCOUNT_SID  ACxxx from https://twilio.com
 *   TWILIO_AUTH_TOKEN   xxxx
 *   TWILIO_FROM         your Twilio sender number, e.g. +15551234567
 *   APP_URL             optional, defaults to https://hoy.app (used in links)
 *
 * NOTE on Somalia SMS: Twilio is the global default and works to verify the
 * end-to-end flow, but for Somali (+252) numbers you'll likely want a regional
 * gateway (Hormuud, or an aggregator like Africa's Talking) for deliverability
 * and cost. To switch, replace only the `sendSMS()` function below — everything
 * else stays the same. A stub is included at the bottom.
 */

'use strict';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM    = process.env.RESEND_FROM || 'Hoy <bookings@example.so>';
const TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM    = process.env.TWILIO_FROM;
const APP_URL        = process.env.APP_URL || 'https://hoy.app';

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

// Display money the way the prototype does. Keep all math in USD; convert
// only for display. SOS rate is illustrative — wire it to a live rate later.
const SOS_PER_USD = 570;
function money(amount, currency = 'USD') {
  const a = Math.round(Number(amount) || 0);
  if (currency === 'SOS') return 'Sh ' + Math.round(a * SOS_PER_USD).toLocaleString('en-US');
  return '$' + a.toLocaleString('en-US');
}

// Escape anything that lands inside HTML (titles, names, cities, etc.)
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/* ------------------------------------------------------------------ *
 * Message templates (ported from the prototype)
 * ------------------------------------------------------------------ */

function emailRow(label, value) {
  return `<tr>
    <td style="padding:6px 0;color:#8a7d6a;font-size:13px">${esc(label)}</td>
    <td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px;color:#241C16">${esc(value)}</td>
  </tr>`;
}

/**
 * @param {object} b booking
 * @param {boolean} forHost true => host notification, false => guest receipt
 */
function bookingEmailHTML(b, forHost) {
  const cur = b.currency || 'USD';
  const kind = b.exp ? 'experience' : 'stay';
  const title = forHost ? 'You have a new booking 🎉' : 'Your booking is confirmed ✓';
  const intro = forHost
    ? `<b>${esc((b.host && b.host.name ? b.host.name : 'there').split(' ')[0])}</b>, great news — <b>${esc(b.title)}</b> just got booked.`
    : `Thanks for booking with Hoy. Here are your details for <b>${esc(b.title)}</b>.`;
  const moneyRow = forHost
    ? emailRow('Your payout (after fee)', money(b.payout, cur))
    : emailRow('Total paid', money(b.total, cur));
  const note = forHost
    ? `<p style="font-size:13px;color:#0E5454;background:#EEF5F2;padding:12px 14px;border-radius:10px;margin:16px 0 0">🔒 Hoy is holding the guest's payment. Your payout is released to your EVC Plus account after the ${kind} is complete.</p>`
    : `<p style="font-size:13px;color:#0E5454;background:#EEF5F2;padding:12px 14px;border-radius:10px;margin:16px 0 0">🔒 Your payment is held securely by Hoy and only released to your host after your ${kind}, so you're protected.</p>`;
  const cta = forHost
    ? `<a href="${esc(APP_URL)}/dashboard" style="display:inline-block;margin-top:18px;background:#C25A38;color:#fff;text-decoration:none;padding:11px 20px;border-radius:30px;font-weight:700;font-size:14px">Open host dashboard</a>`
    : `<a href="${esc(APP_URL)}/trips" style="display:inline-block;margin-top:18px;background:#C25A38;color:#fff;text-decoration:none;padding:11px 20px;border-radius:30px;font-weight:700;font-size:14px">View my trip</a>`;

  return `<!doctype html><html><body style="margin:0;background:#FAF4E9;padding:24px 12px">
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:440px;margin:0 auto;border:1px solid #E2D6C2;border-radius:14px;overflow:hidden;background:#fff">
    <div style="background:#0E5454;color:#fff;padding:18px 22px;font-size:20px;font-weight:700">Hoy</div>
    <div style="padding:22px">
      <h2 style="margin:0 0 10px;font-size:19px;color:#241C16">${title}</h2>
      <p style="font-size:14px;color:#3a3027;line-height:1.5;margin:0 0 16px">${intro}</p>
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #E2D6C2">
        ${emailRow(b.exp ? 'Experience' : 'Stay', b.title)}
        ${b.exp ? '' : emailRow('Location', b.city)}
        ${emailRow('Dates', b.when)}
        ${emailRow('Guests', b.guests)}
        ${emailRow('Confirmation', b.ref)}
        ${moneyRow}
      </table>
      ${note}
      ${cta}
      <p style="font-size:11px;color:#8a7d6a;margin:18px 0 0">Sent by Hoy · Questions? Reply to this email or visit Help &amp; safety in the app.</p>
    </div>
  </div></body></html>`;
}

function guestSMS(b) {
  const kind = b.exp ? 'experience' : 'stay';
  const loc = b.exp ? '' : ' · ' + b.city;
  return `Hoy: You're booked! ${b.title}${loc}, ${b.when}. Total ${money(b.total, b.currency)}, held safely until your ${kind}. Ref ${b.ref}. Manage: ${APP_URL}/trips`;
}

function hostSMS(b) {
  const kind = b.exp ? 'experience' : 'stay';
  const evc = (b.host && b.host.evc) ? ` (${b.host.evc})` : '';
  return `Hoy: New booking! ${b.title}, ${b.when}, ${b.guests}. Your payout ${money(b.payout, b.currency)} goes to your EVC${evc} after the ${kind}. Ref ${b.ref}.`;
}

/* ------------------------------------------------------------------ *
 * Channel senders
 * ------------------------------------------------------------------ */

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json(); // { id: '...' }
}

// Default SMS via Twilio. To use a Somali gateway instead, replace the body
// of this function only (see sendSMS_AfricasTalking stub at the bottom).
async function sendSMS(to, body) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    throw new Error('Twilio env vars (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM) are not set');
  }
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const form = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
  return res.json(); // { sid: '...' }
}

/* ------------------------------------------------------------------ *
 * Core: notify one party, then both
 * ------------------------------------------------------------------ */

async function notifyParty(party, booking, forHost) {
  const subject = forHost
    ? `New booking: ${booking.title} (${booking.ref})`
    : `Your Hoy booking is confirmed — ${booking.ref}`;

  if (party.channel === 'email') {
    const r = await sendEmail(party.to, subject, bookingEmailHTML(booking, forHost));
    return { channel: 'email', to: party.to, id: r.id };
  }
  // default to text
  const r = await sendSMS(party.to, forHost ? hostSMS(booking) : guestSMS(booking));
  return { channel: 'text', to: party.to, sid: r.sid };
}

/**
 * Send confirmations to guest + host. Call this right after a booking is
 * confirmed (or, better, from a queue so a provider hiccup never blocks the
 * booking itself).
 *
 * booking = {
 *   ref, title, city, when, guests, total, payout,
 *   exp: false,            // true for an experience
 *   currency: 'USD',       // or 'SOS'
 *   guest: { channel: 'email'|'text', to: 'you@x.com' | '+2526...' },
 *   host:  { channel: 'email'|'text', to: 'host@x.com' | '+2526...',
 *            name: 'Faisal A.', evc: '61 •••• 14' }
 * }
 */
async function sendBookingNotifications(booking) {
  validateBooking(booking);
  const results = {};
  // Settle both even if one fails, so a host SMS outage doesn't hide the guest receipt.
  const [guest, host] = await Promise.allSettled([
    notifyParty(booking.guest, booking, false),
    notifyParty(booking.host, booking, true),
  ]);
  results.guest = guest.status === 'fulfilled' ? guest.value : { error: String(guest.reason) };
  results.host  = host.status  === 'fulfilled' ? host.value  : { error: String(host.reason) };
  return results;
}

function validateBooking(b) {
  if (!b || typeof b !== 'object') throw new Error('Missing booking payload');
  for (const f of ['ref', 'title', 'when', 'guests', 'total', 'payout']) {
    if (b[f] === undefined || b[f] === null) throw new Error(`Missing field: ${f}`);
  }
  for (const who of ['guest', 'host']) {
    const p = b[who];
    if (!p || !p.to) throw new Error(`Missing ${who}.to`);
    if (p.channel !== 'email' && p.channel !== 'text') throw new Error(`${who}.channel must be 'email' or 'text'`);
  }
}

/* ------------------------------------------------------------------ *
 * HTTP handler (Vercel / Netlify / generic Node serverless)
 *   POST /api/notify  with the booking JSON above.
 * For Express, see README — you can also just call sendBookingNotifications().
 * ------------------------------------------------------------------ */

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }
  try {
    const body = (req.body && typeof req.body === 'object')
      ? req.body
      : JSON.parse(await readRawBody(req));
    const sent = await sendBookingNotifications(body);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, sent }));
  } catch (err) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data || '{}'));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ *
 * OPTIONAL: Somali SMS gateway via Africa's Talking (example stub).
 * Swap sendSMS's body for this if you go regional. Set:
 *   AT_API_KEY, AT_USERNAME, AT_FROM (your registered sender ID)
 * ------------------------------------------------------------------ */
// eslint-disable-next-line no-unused-vars
async function sendSMS_AfricasTalking(to, body) {
  const key = process.env.AT_API_KEY, user = process.env.AT_USERNAME, from = process.env.AT_FROM;
  if (!key || !user) throw new Error('Africa\'s Talking env vars not set');
  const form = new URLSearchParams({ username: user, to, message: body });
  if (from) form.set('from', from);
  const res = await fetch('https://api.africastalking.com/version1/messaging', {
    method: 'POST',
    headers: { apiKey: key, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form,
  });
  if (!res.ok) throw new Error(`AfricasTalking ${res.status}: ${await res.text()}`);
  return res.json();
}

/* ------------------------------------------------------------------ *
 * Exports — ESM and CommonJS friendly
 * ------------------------------------------------------------------ */
module.exports = handler;
module.exports.default = handler;
module.exports.handler = handler;
module.exports.sendBookingNotifications = sendBookingNotifications;
module.exports.bookingEmailHTML = bookingEmailHTML;
module.exports.guestSMS = guestSMS;
module.exports.hostSMS = hostSMS;
// low-level senders, reused by the backend for OTP login codes
module.exports.__sendEmail = sendEmail;
module.exports.__sendSMS = sendSMS;
module.exports.sendToParty = notifyParty;
