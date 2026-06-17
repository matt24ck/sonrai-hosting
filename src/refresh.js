/**
 * refresh.js — Automatic catalogue refresh.
 *
 * The server boots from the committed stores/<id>/catalogue.json (instant start), then keeps it
 * current by re-fetching each store's public products.json on a schedule and hot-swapping the
 * in-memory catalogue. New products, price changes and sold-out items appear with no redeploy and
 * nothing for the store owner to do.
 *
 * Failure-safe: a failed or empty fetch is logged and the existing good catalogue is kept — we
 * never wipe a working catalogue with a bad response.
 *
 * Cadence is set by config.CATALOGUE_REFRESH_MINUTES (env CATALOGUE_REFRESH_MINUTES; 0 disables).
 * For instant updates you can also POST /api/refresh (see server.js) from a Shopify
 * products webhook.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const catalogue = require('./catalogue');
const { fetchAllProducts, buildPayload } = require('./fetcher');
const { allStores, getStore } = require('../stores/registry');

const _status = new Map(); // storeId -> { lastRefreshed, lastResult, count }

function statusFor(storeId) {
  const meta = catalogue.getMeta(storeId);
  return {
    store: storeId,
    count: meta ? meta.count : null,
    fetchedAt: meta ? meta.fetchedAt : null,
    ...(_status.get(storeId) || {}),
  };
}
function allStatus() {
  return allStores().map((s) => statusFor(s.id));
}

/** Re-fetch one store and hot-swap it in. Throws on failure (caller decides how to handle). */
async function refreshStore(storeId, { persist = true } = {}) {
  const store = getStore(storeId);
  if (!store) throw new Error(`Unknown store "${storeId}".`);

  const products = await fetchAllProducts(store.storeUrl);
  if (!products.length) throw new Error('fetch returned 0 products — keeping existing catalogue');

  const payload = buildPayload(store, products);
  const count = catalogue.applyRaw(storeId, payload);

  // Best-effort disk write (warm cache for this process; not persisted across redeploys — that's
  // fine, we re-fetch on boot). Never fatal.
  if (persist) {
    try {
      const dir = path.join(__dirname, '..', 'stores', storeId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'catalogue.json'), JSON.stringify(payload, null, 2));
    } catch (e) {
      console.warn(`[refresh] ${storeId}: disk write skipped (${e.message})`);
    }
  }

  _status.set(storeId, { lastRefreshed: payload.fetchedAt, lastResult: 'ok', count });
  return count;
}

/** Refresh every registered store, in series (polite). Errors are caught per-store and logged. */
async function refreshAll() {
  for (const store of allStores()) {
    try {
      const count = await refreshStore(store.id);
      console.log(`[refresh] ${store.id}: ${count} products`);
    } catch (err) {
      _status.set(store.id, { ...(_status.get(store.id) || {}), lastResult: `error: ${err.message}`, lastError: err.message });
      console.warn(`[refresh] ${store.id}: ${err.message}`);
    }
  }
}

/** Kick off background refresh on boot + on an interval. Returns the timer (or null if disabled). */
function startScheduler() {
  const minutes = Number(config.CATALOGUE_REFRESH_MINUTES) || 0;
  if (minutes <= 0) {
    console.log('[refresh] auto-refresh disabled (CATALOGUE_REFRESH_MINUTES=0)');
    return null;
  }
  // Refresh shortly after boot (non-blocking — server already serves committed data).
  setTimeout(() => { refreshAll().catch((e) => console.warn('[refresh] boot refresh failed:', e.message)); }, 3000);

  const timer = setInterval(() => {
    refreshAll().catch((e) => console.warn('[refresh] scheduled refresh failed:', e.message));
  }, minutes * 60 * 1000);
  timer.unref && timer.unref(); // don't keep the process alive just for the timer
  console.log(`[refresh] auto-refresh every ${minutes} min`);
  return timer;
}

module.exports = { refreshStore, refreshAll, startScheduler, allStatus, statusFor };
