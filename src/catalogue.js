/**
 * catalogue.js — Tenant-aware catalogue loading + enrichment.
 *
 * For each store it turns stores/<id>/catalogue.json into:
 *   1. an enriched product map (id -> real name/price/image/url/variants) used by APP CODE to
 *      render cards. Prices/names shown to the user ALWAYS come from here, never the model.
 *   2. a compact index (one small object per product) — the only product data the MODEL sees.
 *   3. a code-side pre-filter for large catalogues.
 *
 * SIZING: we expose every product's variants ({ id, label, available }) and a `hasSizes` flag.
 * We deliberately DO NOT pick a default size for sized garments — the shopper must choose. Only
 * genuine one-size products (a single variant, e.g. caps) carry a direct `variantId`.
 *
 * NOTE for this brand: `product_type` is empty for Hoodies/Pants, so we derive `category` from
 * the title; `colour` is the text after " - " in the title (for same-colourway outfits).
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const _rawCache = new Map(); // storeId -> raw catalogue
const _mapCache = new Map(); // storeId -> Map(id -> enriched)

function cataloguePath(storeId) {
  return path.join(__dirname, '..', 'stores', storeId, 'catalogue.json');
}

function loadRaw(storeId) {
  if (_rawCache.has(storeId)) return _rawCache.get(storeId);
  const p = cataloguePath(storeId);
  if (!fs.existsSync(p)) {
    throw new Error(`Catalogue not found for store "${storeId}". Run: npm run fetch -- ${storeId}`);
  }
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  _rawCache.set(storeId, data);
  return data;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveCategory(product) {
  const t = (product.title || '').toLowerCase();
  if (t.includes('hoodie')) return 'Hoodie';
  if (t.includes('pant') || t.includes('jogger') || t.includes('legging')) return 'Pant';
  if (t.includes('short')) return 'Shorts';
  if (t.includes('cap') || t.includes('hat') || t.includes('beanie')) return 'Cap';
  if (t.includes('tee') || t.includes('t-shirt') || t.includes('top')) return 'Tee';
  return product.product_type || 'Other';
}

function deriveColour(product) {
  const parts = (product.title || '').split(' - ');
  return parts.length > 1 ? parts[parts.length - 1].trim() : null;
}

function priceInfo(product) {
  const prices = (product.variants || [])
    .map((v) => parseFloat(v.price))
    .filter((n) => !Number.isNaN(n));
  if (prices.length === 0) return { min: null, max: null };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

function isInStock(product) {
  return (product.variants || []).some((v) => v.available);
}

function formatPrice(min, max, symbol) {
  if (min == null) return '';
  const fmt = (n) => `${symbol}${n.toFixed(2)}`;
  return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}

/**
 * A variant label is the size (e.g. "XS"). Shopify uses "Default Title" / "One Size" for
 * products without real variants — those are treated as one-size (no size choice needed).
 */
function variantLabel(v) {
  return v.title || v.option1 || '';
}

function isOneSize(product) {
  const variants = product.variants || [];
  if (variants.length <= 1) return true;
  // Defensive: if every variant label is a non-size placeholder, treat as one-size.
  const labels = variants.map((v) => variantLabel(v).toLowerCase());
  return labels.every((l) => l === 'default title' || l === 'one size' || l === '');
}

function enrich(product, store) {
  const { min, max } = priceInfo(product);
  const image = (product.images || [])[0];
  const inStock = isInStock(product);
  const oneSize = isOneSize(product);

  const variants = (product.variants || []).map((v) => ({
    id: v.id,
    label: variantLabel(v),
    available: !!v.available,
  }));

  // One-size products keep a direct variantId (the single available variant).
  // Sized products carry NO default — the shopper must choose a size before adding to cart.
  const directVariant = oneSize ? variants.find((v) => v.available) || variants[0] || null : null;

  return {
    id: product.id,
    title: product.title,
    category: deriveCategory(product),
    colour: deriveColour(product),
    productType: product.product_type || '',
    tags: product.tags || [],
    priceMin: min,
    priceMax: max,
    priceDisplay: formatPrice(min, max, store.currencySymbol),
    image: image ? image.src : null,
    url: `${store.storeUrl}/products/${product.handle}`,
    available: inStock,
    hasSizes: !oneSize,
    variants, // [{ id, label, available }]
    variantId: directVariant ? directVariant.id : null, // ONLY for one-size items
    description: stripHtml(product.body_html).slice(0, config.DESCRIPTION_CHARS),
  };
}

function buildProductMap(storeId) {
  if (_mapCache.has(storeId)) return _mapCache.get(storeId);
  const store = require('../stores/registry').getStore(storeId);
  const map = new Map();
  for (const p of loadRaw(storeId).products) {
    map.set(String(p.id), enrich(p, store));
  }
  _mapCache.set(storeId, map);
  return map;
}

/**
 * Compact index — the ONLY product data the model sees. Out-of-stock products are excluded so
 * the concierge never builds a fit around something unbuyable. Sizes are intentionally NOT in
 * the model's view (sizing is a UI concern; the model must not assume a size).
 */
function buildCompactIndex(storeId, { includeOutOfStock = false } = {}) {
  const map = buildProductMap(storeId);
  const items = [];
  for (const e of map.values()) {
    if (!includeOutOfStock && !e.available) continue;
    items.push({
      id: e.id,
      title: e.title,
      category: e.category,
      colour: e.colour,
      tags: e.tags,
      price: e.priceMin,
      priceDisplay: e.priceDisplay,
      description: e.description,
    });
  }
  return items;
}

function parseBudget(message) {
  if (!message) return null;
  const text = message.toLowerCase().replace(/,/g, '');
  const range = text.match(/(?:€|eur)?\s*(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(?:€|eur)?\s*(\d+(?:\.\d+)?)/);
  if (range) return parseFloat(range[2]);
  const ceiling = text.match(/(?:under|below|less than|max|maximum|up to|cheaper than)\s*(?:€|eur)?\s*(\d+(?:\.\d+)?)/);
  if (ceiling) return parseFloat(ceiling[1]);
  const around = text.match(/(?:~|around|about|approx(?:imately)?|circa)\s*(?:€|eur)?\s*(\d+(?:\.\d+)?)/);
  if (around) return parseFloat(around[1]) * 1.15;
  return null;
}

/** Code-side pre-filter for LARGE catalogues (no-op when index <= threshold). */
function prefilter(message, index, target = config.PREFILTER_TARGET) {
  let candidates = index;
  const budget = parseBudget(message);
  if (budget != null) {
    const within = candidates.filter((p) => p.price == null || p.price <= budget);
    if (within.length > 0) candidates = within;
  }
  if (candidates.length <= target) return candidates;

  const words = (message || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const scored = candidates.map((p) => {
    const hay = `${p.title} ${p.category} ${p.colour || ''} ${(p.tags || []).join(' ')} ${p.description}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 1;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, target).map((s) => s.p);
}

/**
 * Hot-swap a store's catalogue in memory (used by the auto-refresh). Rebuilds the enriched map
 * fully, THEN swaps the cached references — so concurrent reads always see a complete catalogue,
 * never a half-built one. Returns the new product count.
 */
function applyRaw(storeId, payload) {
  const store = require('../stores/registry').getStore(storeId);
  const map = new Map();
  for (const p of payload.products) map.set(String(p.id), enrich(p, store));
  _rawCache.set(storeId, payload); // reference swaps are atomic in single-threaded JS
  _mapCache.set(storeId, map);
  return map.size;
}

/** Metadata about the currently-loaded catalogue (for status/health). */
function getMeta(storeId) {
  let raw = null;
  if (_rawCache.has(storeId)) raw = _rawCache.get(storeId);
  else if (fs.existsSync(cataloguePath(storeId))) raw = loadRaw(storeId);
  return raw ? { fetchedAt: raw.fetchedAt || null, count: raw.count || (raw.products || []).length } : null;
}

module.exports = {
  loadRaw,
  stripHtml,
  enrich,
  buildProductMap,
  buildCompactIndex,
  parseBudget,
  prefilter,
  formatPrice,
  applyRaw,
  getMeta,
};
