# Deploying the Hoy backend

The backend is a zero-dependency Node service (Postgres is the only optional dependency, used only when `DATABASE_URL` is set). It serves both the API and the app (`public/index.html`).

Pick **one** host below. Render is the easiest because the blueprint provisions the database too.

---

## Before you deploy (any host)

1. Set a strong, **stable** `AUTH_SECRET` (changing it later logs everyone out).
2. Set `ALLOWED_ORIGIN` to your real app URL(s), comma-separated. In production the server refuses cross-origin requests from anywhere else.
3. Decide your data store:
   - **JSON file** (default): fine for a demo, but most cloud hosts have *ephemeral* disks — data is wiped on every redeploy. Do **not** use this for real users.
   - **Postgres** (recommended for anything real): set `DATABASE_URL`, then apply the schema once: `psql "$DATABASE_URL" -f schema.sql`. Optionally seed demo data with `DATABASE_URL=... node seed.js` (only on a fresh/empty database).
4. Add provider keys as you turn each integration on (see `.env.example`): `RESEND_*` (email), `TWILIO_*` or a Somali SMS gateway, `S3_*` (photo storage), `IDENTITY_*` (ID verification). Anything left unset stays in safe dev-fallback mode.
5. After deploy, hit `GET /config` — it reports which integrations are live (no secrets leaked) so you can confirm your keys took effect.

---

## Option 1 — Render (blueprint, includes Postgres)

1. Push this folder to a Git repo.
2. Render dashboard → **New → Blueprint** → select the repo. It reads `render.yaml` and creates the web service **and** a free Postgres.
3. Fill the secret env vars marked `sync: false` (ALLOWED_ORIGIN, provider keys). `AUTH_SECRET` is generated for you; `DATABASE_URL` is wired automatically.
4. After first deploy, apply the schema once from your machine or Render's shell: `psql "$DATABASE_URL" -f schema.sql`.
5. Add a custom domain in Render (TLS is automatic) and set `ALLOWED_ORIGIN` to it.

## Option 2 — Railway

1. New project → Deploy from repo. Add a Postgres plugin; Railway injects `DATABASE_URL`.
2. Set env vars (`AUTH_SECRET`, `ALLOWED_ORIGIN`, provider keys).
3. Apply schema: `psql "$DATABASE_URL" -f schema.sql`.

## Option 3 — Fly.io (Docker)

1. `fly launch` (it detects the `Dockerfile`). Add Postgres with `fly postgres create` and attach it (`fly postgres attach`), which sets `DATABASE_URL`.
2. `fly secrets set AUTH_SECRET=... ALLOWED_ORIGIN=... RESEND_API_KEY=...` etc.
3. Apply schema via `fly postgres connect` or a one-off machine.

## Option 4 — Plain VPS (Ubuntu)

1. Install Node 18+ and Postgres. `git clone`, then `npm install` (pulls `pg`).
2. Create the DB and run `psql "$DATABASE_URL" -f schema.sql`.
3. Put env vars in a `.env`-style file or systemd unit. Run under a process manager (pm2 or a systemd service).
4. Put **Nginx + Let's Encrypt** in front for HTTPS, proxying to the Node port. Set `ALLOWED_ORIGIN` to your HTTPS domain.

---

## Switching from JSON to Postgres

The code picks the store automatically: if `DATABASE_URL` is present it uses Postgres, otherwise the JSON file. So switching is just:
1. Provision Postgres and get its `DATABASE_URL`.
2. `psql "$DATABASE_URL" -f schema.sql`
3. Set `DATABASE_URL` in the host's env and redeploy.

(There's no automatic migration of existing JSON data — treat the JSON store as demo-only.)

---

## Quick post-deploy checklist

- [ ] `GET /health` returns ok
- [ ] `GET /config` shows the store and which integrations are on
- [ ] App loads at `/` (served from `public/index.html`)
- [ ] A test login → booking works end to end
- [ ] `ALLOWED_ORIGIN` matches your real domain (no localhost in prod)
- [ ] `AUTH_SECRET` is set and won't change
- [ ] Database backups are turned on (your host's setting)
