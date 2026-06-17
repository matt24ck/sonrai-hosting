/**
 * fetcher.js — Shared Shopify catalogue fetch (used by both the CLI script and the runtime
 * auto-refresh). Paginates the public products.json (no API key, 250/page) until exhausted.
 */

const PER_PAGE = 250;
const MAX_PAGES = 50; // safety cap (50 * 250 = 12,500 products)

async function fetchPage(storeUrl, page) {
  const url = `${storeUrl}/products.json?limit=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'shopify-concierge/1.0 (catalogue ingestion)' },
  });
  if (!res.ok) throw new Error(`Fetch failed for ${url}: HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.products) ? data.products : [];
}

/** Fetch every product for a store. `onPage` is an optional progress callback (page, count). */
async function fetchAllProducts(storeUrl, onPage) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const products = await fetchPage(storeUrl, page);
    if (onPage) onPage(page, products.length);
    if (products.length === 0) break;
    all.push(...products);
    if (products.length < PER_PAGE) break;
  }
  return all;
}

/** Build the cached payload shape we persist to stores/<id>/catalogue.json. */
function buildPayload(store, products, now) {
  return {
    fetchedAt: now || new Date().toISOString(),
    storeUrl: store.storeUrl,
    currency: store.currency,
    count: products.length,
    products,
  };
}

module.exports = { fetchAllProducts, buildPayload, PER_PAGE };
