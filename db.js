'use strict';
/**
 * db.js — data layer behind a single ASYNC interface.
 *
 * Default: zero-dependency JSON file (great for dev/MVP).
 * If DATABASE_URL is set, it loads the Postgres adapter (./db-postgres) which
 * implements the exact same interface. Route code never changes.
 *
 * Interface (all async):
 *   init()
 *   listings() experiences() getListing(id) hosts() getHost(id)
 *   addBooking(b) bookingsForContact(contact) updateListingBooked(id, range)
 *   saveOtp(contact, rec) getOtp(contact) deleteOtp(contact)
 *   saveSession(tokenHash, rec) getSession(tokenHash) deleteSession(tokenHash)
 */

const fs = require('fs');
const path = require('path');
const { freshData } = require('./seed');

function makeJsonStore() {
  const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
  let data = null;
  function load() {
    if (data) return data;
    try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { data = freshData(); save(); }
    data.otps = data.otps || {};
    data.sessions = data.sessions || {};
    data.bookings = data.bookings || [];
    data.verifications = data.verifications || {};
    data.verifiedContacts = data.verifiedContacts || {};
    data.events = data.events || [];
    data.idem = data.idem || {};
    data.services = data.services || [];
    data.disputes = data.disputes || [];
    data.reports = data.reports || [];
    data.reviews = data.reviews || [];
    return data;
  }
  function save() { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }

  return {
    async init() { load(); },
    async listings() { return load().listings; },
    async experiences() { return load().experiences; },
    async services() { return load().services || []; },
    async getListing(id) {
      const d = load();
      return d.listings.find((l) => l.id === id) || d.experiences.find((e) => e.id === id) || (d.services || []).find((s) => s.id === id) || null;
    },
    async hosts() { return load().hosts; },
    async getHost(id) { return load().hosts.find((h) => h.id === id) || null; },
    async addBooking(b) { load().bookings.unshift(b); save(); return b; },
    async bookingsForContact(c) { return load().bookings.filter((b) => b.guestContact === c); },
    async updateListingBooked(id, range) {
      const l = load().listings.find((x) => x.id === id);
      if (l) { l.booked = l.booked || []; l.booked.push(range); save(); }
    },
    async saveOtp(contact, rec) { load().otps[contact] = rec; save(); },
    async getOtp(contact) { return load().otps[contact] || null; },
    async deleteOtp(contact) { delete load().otps[contact]; save(); },
    async saveSession(tokenHash, rec) { load().sessions[tokenHash] = rec; save(); },
    async getSession(tokenHash) { return load().sessions[tokenHash] || null; },
    async deleteSession(tokenHash) { delete load().sessions[tokenHash]; save(); },
    async saveVerification(id, rec) { load().verifications[id] = rec; save(); },
    async getVerification(id) { return load().verifications[id] || null; },
    async markHostVerified(hostId) { const h = load().hosts.find((x) => x.id === hostId); if (h) { h.idVerified = true; save(); } },
    async markContactVerified(contact) { load().verifiedContacts[contact] = true; save(); },
    async isContactVerified(contact) { return !!load().verifiedContacts[contact]; },
    async addEvent(e) { load().events.push(e); save(); },
    async eventsForListing(id, sinceTs) { return load().events.filter((e) => e.listingId === id && (!sinceTs || e.ts >= sinceTs)); },
    async searchEvents(sinceTs) { return load().events.filter((e) => e.type === 'search' && (!sinceTs || e.ts >= sinceTs)); },
    async bookingsForListing(id) { return load().bookings.filter((b) => b.listingId === id); },
    async getBooking(id) { return load().bookings.find((b) => b.id === id) || null; },
    async getIdem(key) { return load().idem[key] || null; },
    async saveIdem(key, bookingId) { load().idem[key] = bookingId; save(); },
    async allBookings() { return load().bookings; },
    async hostByContact(contact) { const c = String(contact).toLowerCase(); return load().hosts.find((h) => (h.email && h.email.toLowerCase() === c) || (h.phone && h.phone === contact)) || null; },
    async updateBooking(b) { const d = load(); const i = d.bookings.findIndex((x) => x.id === b.id); if (i >= 0) { d.bookings[i] = b; save(); } return b; },
    async removeListingBooked(id, range) { const l = load().listings.find((x) => x.id === id); if (l && l.booked) { l.booked = l.booked.filter((r) => !(r[0] === range[0] && r[1] === range[1])); save(); } },
    async setHostStatus(id, status) { const h = load().hosts.find((x) => x.id === id); if (h) { h.status = status; save(); } return h || null; },
    // disputes
    async addDispute(d) { load().disputes.unshift(d); save(); return d; },
    async getDispute(id) { return load().disputes.find((x) => x.id === id) || null; },
    async allDisputes() { return load().disputes; },
    async updateDispute(d) { const all = load().disputes; const i = all.findIndex((x) => x.id === d.id); if (i >= 0) { all[i] = d; save(); } return d; },
    async disputesForContact(c) { return load().disputes.filter((x) => x.openedBy === c || x.guestContact === c); },
    // reports (safety / abuse)
    async addReport(r) { load().reports.unshift(r); save(); return r; },
    async allReports() { return load().reports; },
    async updateReport(r) { const all = load().reports; const i = all.findIndex((x) => x.id === r.id); if (i >= 0) { all[i] = r; save(); } return r; },
    // reviews
    async addReview(r) { load().reviews.unshift(r); save(); return r; },
    async reviewsForHost(hostId) { return load().reviews.filter((x) => x.hostId === hostId); },
    async reviewsForListing(listingId) { return load().reviews.filter((x) => x.listingId === listingId); },
    async setBookingStatus(id, status) { const b = load().bookings.find((x) => x.id === id); if (b) { b.status = status; if (status === 'released') b.releasedAt = new Date().toISOString(); save(); } return b || null; },
  };
}

const impl = process.env.DATABASE_URL ? require('./db-postgres') : makeJsonStore();
module.exports = impl;
