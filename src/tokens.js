/**
 * tokens.js — Load a store's extracted theme tokens (stores/<id>/theme-tokens.json).
 * Returned to the widget so it can render in the store's own fonts/colours/radius.
 */

const fs = require('fs');
const path = require('path');

const _cache = new Map();

// On-brand defaults if a store hasn't been theme-extracted yet.
const DEFAULTS = {
  fontHeading: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  fontBody: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  textBase: '16px',
  headingWeight: '700',
  bodyWeight: '400',
  colorText: '#111111',
  colorBg: '#ffffff',
  colorAccent: '#111111',
  colorButtonText: '#ffffff',
  radius: '8px',
  googleFontsHref: '',
};

const _logoCache = new Map();

/** Per-store bubble logo SVG markup (stores/<id>/logo.svg), or null to use the widget default. */
function loadLogo(storeId) {
  if (_logoCache.has(storeId)) return _logoCache.get(storeId);
  const p = path.join(__dirname, '..', 'stores', storeId, 'logo.svg');
  let svg = null;
  if (fs.existsSync(p)) {
    try { svg = fs.readFileSync(p, 'utf8'); } catch (_) { svg = null; }
  }
  _logoCache.set(storeId, svg);
  return svg;
}

function loadTokens(storeId) {
  if (_cache.has(storeId)) return _cache.get(storeId);
  const p = path.join(__dirname, '..', 'stores', storeId, 'theme-tokens.json');
  let tokens = { ...DEFAULTS };
  if (fs.existsSync(p)) {
    try {
      tokens = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch (_) {
      /* fall back to defaults on parse error */
    }
  }
  _cache.set(storeId, tokens);
  return tokens;
}

module.exports = { loadTokens, loadLogo, DEFAULTS };
