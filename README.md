# Hoy backend (MVP)

A real, runnable backend for Hoy: **OTP login, listings, and availability-checked bookings** with escrow + fee math, that **notifies the guest and host** on confirmation (email via Resend / SMS via Twilio — the same notifier from before, included here as `notify.js`).

Zero dependencies — it runs on plain Node 18+ with a JSON file as the store. That keeps it instantly runnable while you decide on a real database. Everything talks to `db.js`, so swapping in Postgres later changes **one file**.

## One app: backend + frontend together

The backend also **serves the prototype** at `/`. Put `hoy-prototype.html` at `public/index.html` (already done here), run the server, and open **http://localhost:3000** — the app now talks to the real API on the same origin: real login codes, real bookings saved server-side, real availability checks. A small "● Connected to backend" badge appears bottom-left so you can see it's live.

Opened any other way (double-clicking the HTML, or the hosted artifact), the app falls back to its in-browser simulation, so the standalone demo always works. You can also point a hosted frontend at a remote API with `?api=https://your-api.com`.

## Run it

```bash
cd hoy-backend
cp .env.example .env      # fill in keys when you want real email/SMS
node server.js            # http://localhost:3000
```

In development (`NODE_ENV` not "production"), `/auth/request-code` returns the code as `devCode` so you can test without a real inbox or phone. Set `NODE_ENV=production` to turn that off.

## The full flow (copy/paste)

```bash
# 1. browse
curl localhost:3000/listings

# 2. request a login code (dev returns devCode)
curl -X POST localhost:3000/auth/request-code \
  -H 'Content-Type: application/json' -d '{"contact":"you@example.com"}'

# 3. verify -> token
curl -X POST localhost:3000/auth/verify \
  -H 'Content-Type: application/json' \
  -d '{"contact":"you@example.com","code":"PASTE_DEVCODE"}'

# 4. book (Bearer token from step 3) -> creates booking + fires notifications
curl -X POST localhost:3000/bookings \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer PASTE_TOKEN' \
  -d '{"listingId":"L1","checkIn":"2026-08-10","checkOut":"2026-08-13","guests":2,"guestChannel":"email"}'

# 5. your trips
curl localhost:3000/me/bookings -H 'Authorization: Bearer PASTE_TOKEN'
```

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | – | liveness |
| GET | `/listings` | – | all stays |
| GET | `/experiences` | – | all experiences |
| GET | `/listings/:id` | – | one item + its host |
| POST | `/auth/request-code` | – | `{contact}` → sends 6-digit code |
| POST | `/auth/verify` | – | `{contact, code}` → `{token}` |
| GET | `/me/bookings` | Bearer | your trips |
| POST | `/bookings` | Bearer | books + notifies both parties |
| POST | `/uploads` | Bearer | photo upload (local file in dev; presigned S3/R2 URL in prod) |
| GET | `/uploads/:file` | – | serves a dev-mode uploaded file |
| POST | `/verify/start` | Bearer | begins ID verification → `{id, url}` |
| POST | `/verify/dev-complete` | – (dev only) | simulates the vendor result `{id, result}` |
| POST | `/webhooks/identity` | signed | vendor callback → marks subject verified |
| GET | `/me` | Bearer | `{contact, idVerified}` |

## Integrations (photo upload + ID verification)

Both follow the same pattern as email/SMS: a real provider when keys are set, a working dev fallback when they aren't.

**Photo upload** (`lib/storage.js`). With no keys, `POST /uploads {dataUrl}` (base64) writes the file under `public/uploads/` and returns a local URL — the prototype's photo pickers can use this today. Set `S3_*` and the same endpoint returns a **presigned PUT URL** (zero-dependency AWS SigV4) so the browser uploads straight to S3/Cloudflare R2/Backblaze/MinIO and the bytes never touch this server.

**ID verification** (`lib/identity.js`). With no keys, `POST /verify/start` returns a mock URL and you finish it with `POST /verify/dev-complete {id,result}`; the subject (guest contact or host) is then marked verified, visible at `GET /me`. Set `IDENTITY_*` to use a real vendor (Stripe Identity / Persona / Onfido / Veriff): `/verify/start` creates a real session, the user completes it on the vendor, and the vendor calls `POST /webhooks/identity` — we verify the HMAC signature before trusting it. Adjust the request/response field mapping in `createSession()` to your chosen vendor; nothing else changes.

## What a booking does

1. Checks the listing exists and the dates don't overlap an existing booking (returns **409** if taken).
2. Prices it with the same rules as the app: **12%** guest service fee, **$15** cleaning (stays only), **3%** host fee deducted from payout.
3. Saves the booking with status **`held`** — Hoy holds the funds (escrow) until after the stay.
4. Locks those dates on the listing.
5. Calls `sendBookingNotifications(...)` to message the guest and host, each on their saved channel. **Notification failures are non-fatal** — the booking still succeeds and the error is reported back, so a provider outage never loses a booking.

## Connecting the prototype to this

In the prototype, `confirmBooking()` builds everything in the browser. To go live, replace the in-memory logic with calls to this API: `request-code` / `verify` for the login modal (use the real `token`), `GET /listings` to render cards, and `POST /bookings` on "Confirm booking." The booking response already contains the same fields the confirmation screen shows. Set the API base URL and send the `Authorization: Bearer` header on authed calls.

## Hardening (in this version)

- **Async data layer.** Routes call `db.js` (async). Default is the zero-dep JSON store; set `DATABASE_URL` to use **Postgres** via `db-postgres.js` — run `schema.sql` once and `npm install pg`. Nothing else changes.
- **Auth at rest.** Login codes are stored as an **HMAC** (keyed by `AUTH_SECRET`), session tokens are stored **SHA-256 hashed**, and both carry **expiry** (codes 10 min, sessions 30 days). A leaked DB can't be replayed.
- **Rate limiting.** `/auth/request-code` (5/15min per IP, 3/15min per contact), `/auth/verify` (10/15min per IP), `/bookings` (20/min per user). Returns `429` + `Retry-After`.
- **Retry queue.** Notifications go through an in-process queue with exponential backoff (3 tries) — a provider hiccup retries instead of being lost, and never blocks the booking.
- **CORS locked down.** Allowed origins come from `ALLOWED_ORIGIN`; with none set, only `localhost` is allowed (dev). Plus `nosniff` / `X-Frame-Options` / `Referrer-Policy` headers.

Set `AUTH_SECRET` and `ALLOWED_ORIGIN` before deploying — see `.env.example`.

## Before production (remaining)

This is now a hardened MVP. Still ahead before real users at scale:

- **Postgres in place of the JSON file** (the adapter is written — point `DATABASE_URL` at a real database; the JSON file is single-process and not safe under real concurrency).
- **Durable queue + multi-instance rate limiting:** the queue and limiter are in-process. For multiple servers, move them to Redis / a hosted queue (BullMQ, SQS) — same interfaces.
- **Idempotency keys** on `POST /bookings` so a double-tap can't double-book.
- **Transport & ops:** run behind HTTPS/TLS, add logging/monitoring, and a job to purge expired OTP/session rows.
- **The big one — payments:** this manages bookings and the escrow *status*, but not real money. Charging cards, holding funds, and EVC Plus payouts is the payments rail — it needs a processor and a money-transmitter/licensing review with a fintech lawyer.

## Admin / operator endpoints

Admin access is granted by **verified email allowlist**: set `ADMIN_EMAILS` (comma-separated) and only those signed-in accounts can use the endpoints below. In dev (no `ADMIN_EMAILS` set, `NODE_ENV` not production) any logged-in user is treated as admin for convenience. `GET /me` returns `isAdmin` so the app can show or hide the operator console.

All require an admin session (`Authorization: Bearer <token>`); non-admins get `403`, signed-out callers `401`.

- `GET  /admin/stats` — host counts, booking counts, money in escrow / released / platform revenue
- `GET  /admin/hosts` — all hosts
- `GET  /admin/hosts/:id` — one host
- `POST /admin/hosts/:id/approve` — set host active
- `POST /admin/hosts/:id/suspend` — suspend host
- `GET  /admin/bookings` — all bookings (escrow view)
- `POST /admin/bookings/:id/release` — release escrow payout (queues a host payout notification when providers are configured)
- `POST /admin/bookings/:id/hold` — hold payout
