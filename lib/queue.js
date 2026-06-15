'use strict';
/**
 * lib/queue.js — tiny in-process job queue with retries + exponential backoff.
 * Good enough to keep a transient email/SMS failure from being lost. For
 * durability across restarts / multiple workers, swap this for BullMQ + Redis
 * or a hosted queue (SQS) — same enqueue() shape.
 */
const jobs = [];
let running = false;

function enqueue(task, { attempts = 3, backoffMs = 1500, label = 'job' } = {}) {
  jobs.push({ task, attempts, backoffMs, label, tries: 0 });
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (jobs.length) {
    const j = jobs.shift();
    try {
      await j.task();
    } catch (e) {
      j.tries += 1;
      if (j.tries < j.attempts) {
        const delay = j.backoffMs * Math.pow(2, j.tries - 1);
        // eslint-disable-next-line no-console
        console.warn(`[queue] ${j.label} failed (try ${j.tries}/${j.attempts}): ${e.message}; retrying in ${delay}ms`);
        setTimeout(() => { jobs.push(j); pump(); }, delay);
      } else {
        // eslint-disable-next-line no-console
        console.error(`[queue] ${j.label} gave up after ${j.attempts} tries: ${e.message}`);
      }
    }
  }
  running = false;
}

module.exports = { enqueue };
