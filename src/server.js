/**
 * server.js — Multi-tenant Express backend.
 *
 * Holds every store's catalogue, runs the recommender, validates ids and returns rendered
 * recommendations. Serves the embeddable widget (embed.js) and a local demo harness.
 *
 * Per-store Anthropic API keys live in the host's env (ANTHROPIC_API_KEY_<ID>) and are NEVER
 * exposed to the browser. CORS restricts API calls to each store's configured origins.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('../config');
const { recommend } = require('./recommender');
const { getStore, allAllowedOrigins } = require('../stores/registry');
const { loadTokens, loadLogo } = require('./tokens');
const { startScheduler, refreshStore, allStatus } = require('./refresh');

const app = express();
app.use(express.json({ limit: '256kb' }));

// ---- CORS: allow each store's configured origins + localhost dev origins ----
const ALLOWED = new Set([...allAllowedOrigins(), ...config.DEV_ORIGINS]);
const corsOptions = {
  origin(origin, cb) {
    // Allow same-origin / curl / server-to-server (no Origin header).
    if (!origin) return cb(null, true);
    return cb(null, ALLOWED.has(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
};
app.use('/api', cors(corsOptions));

// embed.js must be loadable from any store page; serve the public dir (static <script> needs no CORS).
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- List available stores (for the local demo picker; non-secret) ----
app.get('/api/stores', (req, res) => {
  res.json(require('../stores/registry').allStores().map((s) => ({ id: s.id, storeName: s.storeName })));
});

// ---- Public, non-secret per-store config (branding, prompts, theme tokens) ----
app.get('/api/config', (req, res) => {
  const store = getStore(req.query.store);
  if (!store) return res.status(404).json({ error: `Unknown store "${req.query.store}".` });
  res.json({
    store: store.id,
    storeName: store.storeName,
    storeUrl: store.storeUrl,
    currency: store.currency,
    currencySymbol: store.currencySymbol,
    examplePrompts: store.examplePrompts,
    tokens: loadTokens(store.id),
    logoSvg: loadLogo(store.id),
  });
});

/**
 * POST /api/chat
 * Body: { store: string, messages: [{ role, content }, ...] }  (full history)
 * Returns: { reply, recommendations: [enriched product + reason], meta }
 */
app.post('/api/chat', async (req, res) => {
  try {
    const storeId = req.body && req.body.store;
    const store = getStore(storeId);
    if (!store) return res.status(404).json({ error: `Unknown store "${storeId}".` });

    const history = Array.isArray(req.body.messages) ? req.body.messages : [];
    const clean = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    if (clean.length === 0 || clean[clean.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'Expected a non-empty history ending with a user message.' });
    }

    res.json(await recommend(clean, storeId));
  } catch (err) {
    console.error('chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/refresh — force an immediate catalogue refresh (e.g. from a Shopify products webhook
 * or a manual trigger). Protected by the REFRESH_TOKEN env var; disabled if that's unset.
 * Body/query: optional { store } to refresh one store, otherwise all.
 */
app.post('/api/refresh', async (req, res) => {
  if (!config.REFRESH_TOKEN) return res.status(404).json({ error: 'refresh endpoint disabled (no REFRESH_TOKEN set)' });
  const token = req.get('x-refresh-token') || (req.body && req.body.token);
  if (token !== config.REFRESH_TOKEN) return res.status(401).json({ error: 'invalid token' });

  const storeId = (req.body && req.body.store) || req.query.store;
  try {
    if (storeId) {
      const count = await refreshStore(storeId);
      return res.json({ ok: true, store: storeId, count });
    }
    // Refresh all (don't block the response too long: kick it off and report current status).
    require('./refresh').refreshAll();
    return res.json({ ok: true, refreshing: 'all', status: allStatus() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true, catalogues: allStatus() }));

const server = app.listen(config.PORT, () => {
  console.log(`\nShopify concierge running at http://localhost:${config.PORT}`);
  console.log(`Model: ${config.MODEL}  |  Stores: ${[...ALLOWED].length} allowed origins`);
  console.log(`Local demo: http://localhost:${config.PORT}/demo.html\n`);
  startScheduler(); // boot + interval catalogue auto-refresh
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.PORT} is already in use. Stop the other process or set PORT=3001.\n`);
  } else {
    console.error('\nServer error:', err.message);
  }
  process.exit(1);
});
