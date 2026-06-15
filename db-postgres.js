'use strict';
/**
 * db-postgres.js — Postgres adapter (same interface as the JSON store).
 * Activated when DATABASE_URL is set. Requires the `pg` package:
 *     npm install pg
 * Apply schema.sql once, then start the server — it auto-seeds if empty.
 */
let Pool;
try { ({ Pool } = require('pg')); }
catch (e) { throw new Error("DATABASE_URL is set but the 'pg' package isn't installed. Run: npm install pg"); }

const { freshData } = require('./seed');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function q(text, params) { return (await pool.query(text, params)).rows; }

module.exports = {
  async init() {
    // Seed hosts/listings/experiences once if tables are empty.
    const rows = await q('SELECT count(*)::int AS n FROM listings');
    if (rows[0].n === 0) {
      const d = freshData();
      for (const h of d.hosts) {
        await q(
          `INSERT INTO hosts(id,name,city,status,evc,evc_name,email,phone,notify)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [h.id, h.name, h.city, h.status, h.evc, h.evcName, h.email, h.phone, h.notify],
        );
      }
      for (const l of d.listings) {
        await q(
          `INSERT INTO listings(id,host_id,title,city,type,price,rating,kind,booked)
           VALUES($1,$2,$3,$4,$5,$6,$7,'stay','[]') ON CONFLICT (id) DO NOTHING`,
          [l.id, l.hostId, l.title, l.city, l.type, l.price, l.rating],
        );
      }
      for (const e of d.experiences) {
        await q(
          `INSERT INTO listings(id,host_id,title,city,type,price,rating,kind,booked)
           VALUES($1,$2,$3,$4,$5,$6,$7,'experience','[]') ON CONFLICT (id) DO NOTHING`,
          [e.id, e.hostId, e.title, e.loc, e.cat, e.price, e.rating],
        );
      }
    }
  },

  async listings() { return q(`SELECT id,host_id AS "hostId",title,city,type,price,rating,booked FROM listings WHERE kind='stay' ORDER BY id`); },
  async experiences() { return q(`SELECT id,host_id AS "hostId",title,city AS loc,type AS cat,price,rating FROM listings WHERE kind='experience' ORDER BY id`); },
  async services() { return q(`SELECT id,host_id AS "hostId",title,type AS cat,price,rating,kind FROM listings WHERE kind='service' ORDER BY id`); },
  async getListing(id) {
    const r = await q('SELECT id,host_id AS "hostId",title,city,type,price,rating,booked,kind FROM listings WHERE id=$1', [id]);
    return r[0] || null;
  },
  async hosts() { return q('SELECT id,name,city,status,evc,evc_name AS "evcName",email,phone,notify FROM hosts ORDER BY id'); },
  async getHost(id) {
    const r = await q('SELECT id,name,city,status,evc,evc_name AS "evcName",email,phone,notify FROM hosts WHERE id=$1', [id]);
    return r[0] || null;
  },

  async addBooking(b) {
    await q('INSERT INTO bookings(id,data,guest_contact,created_at) VALUES($1,$2,$3,now())', [b.id, b, b.guestContact]);
    return b;
  },
  async bookingsForContact(c) {
    const r = await q('SELECT data FROM bookings WHERE guest_contact=$1 ORDER BY created_at DESC', [c]);
    return r.map((x) => x.data);
  },
  async updateListingBooked(id, range) {
    await q(`UPDATE listings SET booked = booked || $2::jsonb WHERE id=$1`, [id, JSON.stringify([range])]);
  },

  async saveOtp(contact, rec) {
    await q(`INSERT INTO otps(contact,data) VALUES($1,$2)
             ON CONFLICT (contact) DO UPDATE SET data=$2`, [contact, rec]);
  },
  async getOtp(contact) { const r = await q('SELECT data FROM otps WHERE contact=$1', [contact]); return r[0] ? r[0].data : null; },
  async deleteOtp(contact) { await q('DELETE FROM otps WHERE contact=$1', [contact]); },

  async saveSession(tokenHash, rec) { await q('INSERT INTO sessions(token_hash,data) VALUES($1,$2) ON CONFLICT (token_hash) DO UPDATE SET data=$2', [tokenHash, rec]); },
  async getSession(tokenHash) { const r = await q('SELECT data FROM sessions WHERE token_hash=$1', [tokenHash]); return r[0] ? r[0].data : null; },
  async deleteSession(tokenHash) { await q('DELETE FROM sessions WHERE token_hash=$1', [tokenHash]); },

  async saveVerification(id, rec) { await q('INSERT INTO verifications(id,data) VALUES($1,$2) ON CONFLICT (id) DO UPDATE SET data=$2', [id, rec]); },
  async getVerification(id) { const r = await q('SELECT data FROM verifications WHERE id=$1', [id]); return r[0] ? r[0].data : null; },
  async markHostVerified(hostId) { await q('UPDATE hosts SET id_verified=true WHERE id=$1', [hostId]); },
  async markContactVerified(contact) { await q('INSERT INTO verified_contacts(contact) VALUES($1) ON CONFLICT DO NOTHING', [contact]); },
  async isContactVerified(contact) { const r = await q('SELECT 1 FROM verified_contacts WHERE contact=$1', [contact]); return r.length > 0; },

  async addEvent(e) { await q('INSERT INTO events(type,listing_id,ts) VALUES($1,$2,$3)', [e.type, e.listingId, e.ts]); },
  async eventsForListing(id, sinceTs) { const r = await q('SELECT type,listing_id AS "listingId",ts FROM events WHERE listing_id=$1 AND ($2::bigint IS NULL OR ts>=$2)', [id, sinceTs || null]); return r; },
  async bookingsForListing(id) { const r = await q(`SELECT data FROM bookings WHERE data->>'listingId'=$1 ORDER BY created_at DESC`, [id]); return r.map((x) => x.data); },
  async getBooking(id) { const r = await q('SELECT data FROM bookings WHERE id=$1', [id]); return r[0] ? r[0].data : null; },
  async getIdem(key) { const r = await q('SELECT booking_id FROM idempotency WHERE key=$1', [key]); return r[0] ? r[0].booking_id : null; },
  async saveIdem(key, bookingId) { await q('INSERT INTO idempotency(key,booking_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [key, bookingId]); },
  async allBookings() { const r = await q('SELECT data FROM bookings ORDER BY created_at DESC'); return r.map((x) => x.data); },
  async hostByContact(contact) { const r = await q('SELECT * FROM hosts WHERE lower(email)=lower($1) OR phone=$1 LIMIT 1', [contact]); return r[0] ? this.getHost(r[0].id) : null; },
  async updateBooking(b) { await q('UPDATE bookings SET data=$2 WHERE id=$1', [b.id, b]); return b; },
  async removeListingBooked(id, range) {
    const l = await this.getListing(id); if (!l) return;
    const booked = (l.booked || []).filter((r) => !(r[0] === range[0] && r[1] === range[1]));
    await q('UPDATE listings SET booked=$2 WHERE id=$1', [id, JSON.stringify(booked)]);
  },
  async setHostStatus(id, status) { await q('UPDATE hosts SET data = jsonb_set(data, \'{status}\', to_jsonb($2::text)) WHERE id=$1', [id, status]); return this.getHost(id); },
  async setBookingStatus(id, status) {
    const b = await this.getBooking(id); if (!b) return null;
    b.status = status; if (status === 'released') b.releasedAt = new Date().toISOString();
    await q('UPDATE bookings SET data=$2 WHERE id=$1', [id, b]); return b;
  },
};
