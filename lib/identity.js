'use strict';
/**
 * lib/identity.js — host/guest ID verification.
 *
 * Real flow (provider mode): create a verification session with a vendor
 * (Stripe Identity, Persona, Onfido, Veriff), send the user to the returned
 * URL, and the vendor calls your /webhooks/identity when they finish. We
 * verify the webhook signature, then mark the subject verified.
 *
 * Dev mode (no IDENTITY_API_KEY): returns a mock session URL so the prototype
 * flow works, and you complete it via POST /verify/dev-complete.
 *
 * Set:
 *   IDENTITY_API_KEY        vendor secret key
 *   IDENTITY_API_URL        vendor "create session" endpoint
 *   IDENTITY_WEBHOOK_SECRET shared secret to verify webhook signatures
 *
 * The createSession() body below is a generic shape — adjust field names to
 * your chosen vendor's API (the call site doesn't change).
 */
const crypto = require('crypto');

function mode() { return process.env.IDENTITY_API_KEY ? 'provider' : 'dev'; }

async function createSession({ verificationId, subjectType, reference }) {
  if (mode() === 'dev') {
    return { providerId: 'dev_' + verificationId, url: `/verify/mock?id=${verificationId}`, status: 'pending', dev: true };
  }
  // --- provider mode (adjust to your vendor) ---
  const res = await fetch(process.env.IDENTITY_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.IDENTITY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: subjectType === 'host' ? 'identity_document' : 'identity_document',
      client_reference_id: reference,           // we pass our verificationId
      metadata: { verificationId, subjectType },
      return_url: (process.env.APP_URL || 'https://hoy.app') + '/verify/done',
    }),
  });
  if (!res.ok) throw new Error(`Identity provider ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Map the vendor's response to our shape:
  return { providerId: data.id, url: data.url || data.client_secret, status: data.status || 'pending' };
}

/** Verify an incoming webhook. Returns the parsed event or throws. */
function verifyWebhook(rawBody, signatureHeader) {
  const secret = process.env.IDENTITY_WEBHOOK_SECRET;
  if (!secret) throw new Error('IDENTITY_WEBHOOK_SECRET not set');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = String(signatureHeader || '').replace(/^sha256=/, '');
  const a = Buffer.from(expected), b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Bad webhook signature');
  return JSON.parse(rawBody);
}

module.exports = { mode, createSession, verifyWebhook };
