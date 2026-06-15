'use strict';
/**
 * lib/ratelimit.js — simple in-memory sliding-window limiter.
 * Fine for a single process. For multiple instances, back this with Redis
 * (same interface). Returns { ok } or { ok:false, retryAfter } (seconds).
 */
const buckets = new Map();

function limit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    const retryAfter = Math.ceil((windowMs - (now - arr[0])) / 1000);
    buckets.set(key, arr);
    return { ok: false, retryAfter };
  }
  arr.push(now);
  buckets.set(key, arr);
  return { ok: true };
}

// periodic cleanup so the map doesn't grow forever
const timer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    const f = v.filter((t) => now - t < 3600000);
    if (f.length) buckets.set(k, f); else buckets.delete(k);
  }
}, 600000);
if (timer.unref) timer.unref();

module.exports = { limit };
