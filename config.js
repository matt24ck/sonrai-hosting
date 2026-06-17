/**
 * config.js — GLOBAL runtime settings shared across all tenants.
 *
 * Per-STORE settings (name, url, voice, prompts, allowed origins) live in stores/registry.js.
 * Per-store DATA (catalogue, theme tokens) lives in stores/<id>/.
 */

module.exports = {
  // ---- Model (shared) ----
  // Good balance of quality, speed and cost for a live demo.
  // Cheaper/faster fallback worth A/B-ing: 'claude-haiku-4-5-20251001'.
  MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_VERSION: '2023-06-01',
  MAX_TOKENS: 1024,

  // ---- Catalogue handling (shared) ----
  // If a store's compact index has <= this many products, pass the whole index to the model.
  // If larger, code pre-filters down to candidates first.
  PREFILTER_THRESHOLD: 120,
  PREFILTER_TARGET: 70,
  DESCRIPTION_CHARS: 200,

  // ---- Catalogue auto-refresh ----
  // Re-fetch each store's products.json this often (minutes). 0 disables. Env-overridable.
  CATALOGUE_REFRESH_MINUTES: process.env.CATALOGUE_REFRESH_MINUTES || 180,
  // Optional shared secret to protect POST /api/refresh (e.g. for a Shopify products webhook).
  // If unset, the manual refresh endpoint is disabled.
  REFRESH_TOKEN: process.env.REFRESH_TOKEN || '',

  // ---- Server ----
  PORT: process.env.PORT || 3000,

  // Origins always allowed for local development (in addition to each store's allowedOrigins).
  DEV_ORIGINS: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ],
};
