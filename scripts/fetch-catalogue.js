/**
 * fetch-catalogue.js — Ingest a store's real Shopify catalogue with no API key (CLI).
 *
 * Caches to stores/<id>/catalogue.json. Use this for onboarding a store; at runtime the server
 * auto-refreshes on a schedule (see src/refresh.js), so you don't need to re-run this routinely.
 *
 * Usage:
 *   node scripts/fetch-catalogue.js <storeId>            # fetch if missing
 *   node scripts/fetch-catalogue.js <storeId> --refresh  # always re-fetch
 *   npm run fetch -- <storeId>
 */

const fs = require('fs');
const path = require('path');
const { getStore } = require('../stores/registry');
const { fetchAllProducts, buildPayload } = require('../src/fetcher');

function resolveStore() {
  const id = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!id) {
    console.error('Usage: node scripts/fetch-catalogue.js <storeId> [--refresh]');
    process.exit(1);
  }
  const store = getStore(id);
  if (!store) {
    console.error(`Unknown store "${id}". Add it to stores/registry.js first.`);
    process.exit(1);
  }
  return store;
}

async function main() {
  const store = resolveStore();
  const refresh = process.argv.includes('--refresh');
  const outDir = path.join(__dirname, '..', 'stores', store.id);
  const outPath = path.join(outDir, 'catalogue.json');

  if (fs.existsSync(outPath) && !refresh) {
    const existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    console.log(`stores/${store.id}/catalogue.json already exists (${existing.count} products). Use --refresh.`);
    return;
  }

  console.log(`Fetching catalogue for "${store.id}" from ${store.storeUrl} ...`);
  const products = await fetchAllProducts(store.storeUrl, (page, n) => console.log(`  page ${page}: ${n} products`));
  if (products.length === 0) {
    throw new Error(
      `No products fetched. Is this a standard Shopify storefront? ` +
        `Check ${store.storeUrl}/products.json?limit=2 in a browser.`
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(buildPayload(store, products), null, 2));
  console.log(`\nWrote ${products.length} products to stores/${store.id}/catalogue.json`);

  const types = [...new Set(products.map((x) => x.product_type).filter(Boolean))];
  console.log(`Distinct product_type values (${types.length}): ${types.join(', ') || '(none set)'}`);
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
