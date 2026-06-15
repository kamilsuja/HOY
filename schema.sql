-- schema.sql — apply once:  psql "$DATABASE_URL" -f schema.sql
-- Then start the server; it auto-seeds hosts/listings/experiences if empty.

CREATE TABLE IF NOT EXISTS hosts (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  city      text,
  status    text DEFAULT 'active',
  evc       text,
  evc_name  text,
  email     text,
  phone     text,
  notify    text DEFAULT 'email'      -- 'email' | 'text'
);

CREATE TABLE IF NOT EXISTS listings (
  id      text PRIMARY KEY,
  host_id text REFERENCES hosts(id),
  title   text NOT NULL,
  city    text,
  type    text,
  price   integer NOT NULL,
  rating  numeric,
  kind    text NOT NULL DEFAULT 'stay',  -- 'stay' | 'experience'
  booked  jsonb NOT NULL DEFAULT '[]'    -- array of [inTs,outTs]
);

CREATE TABLE IF NOT EXISTS bookings (
  id            text PRIMARY KEY,
  data          jsonb NOT NULL,          -- full booking record
  guest_contact text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_guest_idx ON bookings(guest_contact);

-- Auth: store only hashed values + expiry. A periodic job can purge expired rows.
CREATE TABLE IF NOT EXISTS otps (
  contact text PRIMARY KEY,
  data    jsonb NOT NULL                 -- { codeHash, expires, attempts }
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  data       jsonb NOT NULL              -- { contact, expires }
);

-- ID verification
ALTER TABLE hosts ADD COLUMN IF NOT EXISTS id_verified boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS verifications (
  id   text PRIMARY KEY,
  data jsonb NOT NULL                    -- { subjectType, subjectId, providerId, status }
);

CREATE TABLE IF NOT EXISTS verified_contacts (
  contact text PRIMARY KEY
);

-- Analytics events + booking idempotency
CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  type       text NOT NULL,             -- 'view', etc.
  listing_id text NOT NULL,
  ts         bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS events_listing_idx ON events(listing_id, ts);

CREATE TABLE IF NOT EXISTS idempotency (
  key        text PRIMARY KEY,
  booking_id text NOT NULL
);
