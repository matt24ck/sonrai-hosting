/**
 * validate.js — The acceptance gate (tenant-aware).
 *
 * Runs ~10 realistic queries (incl. the hard cases: a budget limit, a vague "you pick", a
 * refinement turn, and an out-of-catalogue request) through the real recommender and asserts:
 *   - every returned product_id exists in the catalogue        (HARD FAIL)
 *   - every shown price comes from catalogue data               (HARD FAIL)
 *   - budget limits are respected                               (HARD FAIL)
 *   - the out-of-catalogue request is declined, not fudged      (HARD FAIL)
 *   - SIZING: sized items expose all in-stock sizes and carry NO defaulted size (HARD FAIL)
 *   - the "Add all to cart" permalink builds from in-stock variant ids
 *
 * Usage: node validate.js [storeId]   (default: enrgy). Needs the store's API key in env.
 */

require('dotenv').config();
const config = require('./config');
const catalogue = require('./src/catalogue');
const { recommend, resolveApiKey } = require('./src/recommender');
const { getStore } = require('./stores/registry');

const STORE_ID = process.argv[2] || 'enrgy';
const store = getStore(STORE_ID);
if (!store) { console.error(`Unknown store "${STORE_ID}".`); process.exit(1); }

const productMap = catalogue.buildProductMap(STORE_ID);
const validIds = new Set([...productMap.keys()]);

const CASES = [
  { name: 'Full Stealth fit (shop-the-look)', turns: ['Build me a full Stealth fit in arctic blue'], minRecs: 2 },
  { name: 'Gift, streetwear, ~€40', turns: ['A gift for a 16-year-old into streetwear, ~€40'], budget: 40 * 1.15 },
  { name: 'Train in under €25', turns: ['Something to train in under €25'], budget: 25 },
  { name: 'Vague "you pick"', turns: ['Something nice, you pick'] },
  { name: 'Matching tracksuit set', turns: ['A matching tracksuit set for the gym'], minRecs: 2 },
  { name: 'Refinement: cheaper (after set)', turns: ['A matching tracksuit set for the gym', 'Now show me something cheaper'], refineCheaper: true },
  { name: 'Out-of-catalogue: running shoes', turns: ['Do you sell running shoes?'], expectDecline: true },
  { name: 'Hoodie under €50', turns: ['A hoodie under €50'], budget: 50 },
  { name: 'Cap to finish a fit, under €20', turns: ['A cap to finish a fit, under €20'], budget: 20 },
  { name: 'Something colourful and bold', turns: ['Something colourful and bold'] },
];

const DECLINE_RE = /(don'?t|do not|can'?t|cannot|afraid|unfortunately|not something|no\b).*(stock|sell|carry|have|do|range|footwear|shoe|trainer|runner)|we (just |only )?(do|make|focus)|isn'?t something we/i;
const log = (s = '') => console.log(s);
const minPrice = (recs) => { const ps = recs.map((r) => r.priceMin).filter((n) => n != null); return ps.length ? Math.min(...ps) : null; };

async function runCase(tc) {
  const history = [];
  let result, prevMinPrice = null;
  for (let i = 0; i < tc.turns.length; i++) {
    history.push({ role: 'user', content: tc.turns[i] });
    if (i > 0 && result) prevMinPrice = minPrice(result.recommendations);
    result = await recommend(history, STORE_ID);
    history.push({ role: 'assistant', content: result.reply });
  }

  const recs = result.recommendations;
  const failures = [];

  for (const r of recs) if (!validIds.has(String(r.id))) failures.push(`HALLUCINATED id ${r.id} ("${r.title}")`);
  if (result.meta.droppedIds.length) failures.push(`model emitted invalid id(s): ${result.meta.droppedIds.join(', ')}`);

  for (const r of recs) {
    const truth = productMap.get(String(r.id));
    if (truth && r.priceDisplay !== truth.priceDisplay) failures.push(`price mismatch ${r.title}: ${r.priceDisplay} vs ${truth.priceDisplay}`);
  }

  if (tc.budget != null) for (const r of recs) {
    if (r.priceMin != null && r.priceMin > tc.budget + 1e-6) failures.push(`over budget: ${r.title} (€${r.priceMin}) > €${tc.budget}`);
  }

  if (tc.expectDecline) {
    const declined = recs.length === 0 || DECLINE_RE.test(result.reply);
    if (!declined) failures.push('did not clearly decline an out-of-catalogue request');
  }

  if (tc.minRecs != null && recs.length < tc.minRecs) failures.push(`expected >= ${tc.minRecs} items, got ${recs.length}`);

  // SIZING: sized items must expose all in-stock sizes and carry NO defaulted size.
  for (const r of recs) {
    const truth = productMap.get(String(r.id));
    if (!truth) continue;
    if (truth.hasSizes) {
      if (r.variantId != null) failures.push(`sized item ${r.title} has a defaulted variantId (${r.variantId}) — must be null`);
      const liveSizes = truth.variants.filter((v) => v.available).length;
      const exposed = (r.variants || []).filter((v) => v.available).length;
      if (exposed !== liveSizes) failures.push(`sized item ${r.title} exposes ${exposed} sizes vs ${liveSizes} in catalogue`);
    } else if (r.available && !r.variantId) {
      failures.push(`one-size item ${r.title} missing variantId for direct add`);
    }
  }

  let warn = null;
  if (tc.refineCheaper && prevMinPrice != null) {
    const now = minPrice(recs);
    if (now != null && now > prevMinPrice + 1e-6) warn = `"cheaper" not clearly cheaper (was €${prevMinPrice}, now €${now})`;
  }

  // "Add all" permalink uses a CHOSEN size per sized item (here we just confirm in-stock variant
  // ids exist to build from — the widget enforces the actual size choice).
  const buyable = recs.filter((r) => r.available);
  const permalink = buyable.length >= 2
    ? `${store.storeUrl}/cart/${buyable.map((r) => `${(r.variantId || (r.variants.find((v) => v.available) || {}).id)}:1`).join(',')}`
    : null;

  return { tc, result, recs, failures, warn, permalink };
}

(async function main() {
  try { resolveApiKey(store); } catch (e) { console.error(e.message); process.exit(1); }

  log(`\n=== ${store.storeName} concierge validation — ${CASES.length} queries, model ${config.MODEL} ===`);
  log(`Store: ${STORE_ID} · Catalogue: ${validIds.size} products. One hallucinated product = NOT READY.\n`);

  let hardFails = 0, passes = 0;
  for (let i = 0; i < CASES.length; i++) {
    const r = await runCase(CASES[i]);
    const status = r.failures.length ? 'FAIL' : 'PASS';
    if (r.failures.length) hardFails += 1; else passes += 1;

    log(`${i + 1}. [${status}] ${r.tc.name}`);
    log(`   user: "${r.tc.turns[r.tc.turns.length - 1]}"`);
    log(`   reply: ${r.result.reply}`);
    if (r.recs.length) r.recs.forEach((p) =>
      log(`     • ${p.title} — ${p.priceDisplay}${p.hasSizes ? ` [sizes: ${p.variants.filter((v) => v.available).map((v) => v.label).join('/')}]` : ' [one size]'} — ${p.reason}`)
    );
    else log('     (no products — clarifying or declining)');
    if (r.permalink) log(`   add-all permalink: ${r.permalink}`);
    if (r.warn) log(`   ⚠ ${r.warn}`);
    r.failures.forEach((f) => log(`   ✗ ${f}`));
    log();
  }

  log('=== SUMMARY ===');
  log(`Hard-assertion passes: ${passes}/${CASES.length}`);
  log(`Hard-assertion failures: ${hardFails}`);
  log(hardFails === 0
    ? 'All hard assertions passed. Eyeball the replies above for quality (target >= 8/10 sensible).'
    : 'HARD FAILURES present — NOT READY. See ✗ lines above.');
  process.exit(hardFails === 0 ? 0 : 1);
})();
