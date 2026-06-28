/**
 * extract-theme.js — Pull a store's REAL design tokens so the widget looks native.
 *
 * Preferred: Playwright loads the live site and reads getComputedStyle on representative
 * elements. Fallback: fetch homepage HTML + theme CSS and parse CSS custom properties.
 * Writes stores/<id>/theme-tokens.json (token map, consumed by the widget) and
 * stores/<id>/theme-tokens.css (for the local demo harness).
 *
 * This is a LOCAL onboarding step — the production server never needs Playwright/browsers.
 *
 * Usage: node scripts/extract-theme.js <storeId>   |   npm run extract-theme -- <storeId>
 */

const fs = require('fs');
const path = require('path');
const { getStore } = require('../stores/registry');

// Sensible on-brand defaults (street/athletic dark accent) used to fill any gaps.
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
  radius: '6px',
  googleFontsHref: '',
};

function resolveStore() {
  const id = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!id) {
    console.error('Usage: node scripts/extract-theme.js <storeId>');
    process.exit(1);
  }
  const store = getStore(id);
  if (!store) {
    console.error(`Unknown store "${id}". Add it to stores/registry.js first.`);
    process.exit(1);
  }
  return store;
}

function writeTokens(store, tokens, sourceNote) {
  const t = { ...DEFAULTS, ...tokens };
  const outDir = path.join(__dirname, '..', 'stores', store.id);
  fs.mkdirSync(outDir, { recursive: true });

  // JSON token map (the widget consumes this).
  fs.writeFileSync(
    path.join(outDir, 'theme-tokens.json'),
    JSON.stringify({ source: sourceNote, ...t }, null, 2)
  );

  // CSS variables (the local demo harness can use this directly).
  const css = `/* theme-tokens.css — extracted from ${store.storeUrl}
 * Source: ${sourceNote}
 * Resolved fonts: heading=${t.fontHeading} ; body=${t.fontBody}
 */
:root {
  --font-heading: ${t.fontHeading};
  --font-body: ${t.fontBody};
  --weight-heading: ${t.headingWeight};
  --weight-body: ${t.bodyWeight};
  --text-base: ${t.textBase};
  --color-text: ${t.colorText};
  --color-bg: ${t.colorBg};
  --color-accent: ${t.colorAccent};
  --color-button-text: ${t.colorButtonText};
  --radius: ${t.radius};
}
`;
  fs.writeFileSync(path.join(outDir, 'theme-tokens.css'), css);

  console.log(`\nWrote stores/${store.id}/theme-tokens.{json,css}`);
  console.log(`  source:        ${sourceNote}`);
  console.log(`  heading font:  ${t.fontHeading}`);
  console.log(`  body font:     ${t.fontBody}`);
  console.log(`  accent colour: ${t.colorAccent}`);
  console.log(`  radius:        ${t.radius}`);
  if (t.googleFontsHref) console.log(`  Google Fonts:  ${t.googleFontsHref}`);
}

// ---- Preferred route: Playwright computed styles ----
async function extractWithPlaywright(store) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(store.storeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const tokens = await page.evaluate(() => {
      const cs = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el) : null;
      };
      const pick = (sels) => {
        for (const s of sels) {
          const c = cs(s);
          if (c) return c;
        }
        return getComputedStyle(document.body);
      };
      const body = getComputedStyle(document.body);
      const heading = pick(['h1', 'h2', '.h1', 'header h1']);
      const para = pick(['p', 'main p', 'article p']);

      // A colour is "solid" if it has non-zero alpha and isn't white/near-white.
      const alpha = (c) => { const m = (c || '').match(/rgba?\(([^)]+)\)/); if (!m) return c ? 1 : 0; const p = m[1].split(',').map((x) => x.trim()); return p.length > 3 ? parseFloat(p[3]) : 1; };
      const isWhite = (c) => /^rgba?\(\s*25[0-5]\s*,\s*25[0-5]\s*,\s*25[0-5]/.test(c || '');
      const isSolid = (c) => alpha(c) >= 0.9 && !isWhite(c);

      // Find a real brand/accent colour: first button with a solid background, scanning several.
      const btnSels = ['button[name="add"]', '.product-form__submit', 'button.btn', '.btn--primary', '.button--primary', '.button', 'button', 'a.btn', 'a.button'];
      let accent = null, btnText = null, radius = null;
      for (const sel of btnSels) {
        for (const el of document.querySelectorAll(sel)) {
          const c = getComputedStyle(el);
          if (radius == null) radius = c.borderRadius;
          if (isSolid(c.backgroundColor)) { accent = c.backgroundColor; btnText = c.color; radius = c.borderRadius; break; }
        }
        if (accent) break;
      }
      // Fallbacks if no solid button exists (transparent/ghost themes): use the darkest brand
      // colour we have (the body text) as the accent, with the page background as contrasting text.
      const colorText = body.color;
      const colorBg = body.backgroundColor;
      if (!accent) { accent = isSolid(colorText) ? colorText : 'rgb(17,17,17)'; btnText = isWhite(colorBg) || alpha(colorBg) < 0.9 ? 'rgb(255,255,255)' : colorBg; }
      if (!btnText) btnText = 'rgb(255,255,255)';

      return {
        fontHeading: heading.fontFamily,
        fontBody: body.fontFamily || para.fontFamily,
        headingWeight: heading.fontWeight,
        bodyWeight: body.fontWeight,
        textBase: body.fontSize,
        colorText,
        colorBg,
        colorAccent: accent,
        colorButtonText: btnText,
        radius: radius || '8px',
      };
    });

    const googleHref = await page.evaluate(() => {
      const link = [...document.querySelectorAll('link[href]')].find((l) =>
        /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(l.href)
      );
      return link ? link.href : '';
    });
    if (googleHref) tokens.googleFontsHref = googleHref;

    return tokens;
  } finally {
    await browser.close();
  }
}

// ---- Fallback route: parse homepage HTML + theme CSS for custom properties ----
async function extractWithCssParse(store) {
  const res = await fetch(store.storeUrl, { headers: { 'User-Agent': 'shopify-concierge/1.0' } });
  const html = await res.text();

  let css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join('\n');
  const links = [...html.matchAll(/<link[^>]+href="([^"]+\.css[^"]*)"[^>]*>/gi)].map((m) => m[1]);
  for (const href of links.slice(0, 4)) {
    try {
      const abs = href.startsWith('http') ? href : new URL(href, store.storeUrl).href;
      const cssRes = await fetch(abs, { headers: { 'User-Agent': 'shopify-concierge/1.0' } });
      css += '\n' + (await cssRes.text());
    } catch (_) {
      /* ignore individual sheet failures */
    }
  }

  const varOf = (names) => {
    for (const n of names) {
      const m = css.match(new RegExp(`--${n}\\s*:\\s*([^;}]+)`, 'i'));
      if (m) return m[1].trim();
    }
    return null;
  };

  const tokens = {};
  const fh = varOf(['font-heading-family', 'heading-font-family', 'font-heading']);
  const fb = varOf(['font-body-family', 'body-font-family', 'font-body']);
  if (fh) tokens.fontHeading = fh;
  if (fb) tokens.fontBody = fb;
  const accent = varOf(['color-button', 'color-accent', 'colorAccent', 'color-primary']);
  if (accent) tokens.colorAccent = accent.startsWith('#') || accent.startsWith('rgb') ? accent : `rgb(${accent})`;
  const g = html.match(/<link[^>]+href="([^"]*fonts\.googleapis\.com[^"]*)"[^>]*>/i);
  if (g) tokens.googleFontsHref = g[1];

  return tokens;
}

async function main() {
  const store = resolveStore();
  console.log(`Extracting theme tokens for "${store.id}" from ${store.storeUrl} ...`);
  try {
    writeTokens(store, await extractWithPlaywright(store), 'Playwright computed styles (live page)');
  } catch (err) {
    console.warn(`\nPlaywright route unavailable (${err.message.split('\n')[0]}).`);
    console.warn('Falling back to CSS parsing...');
    try {
      writeTokens(store, await extractWithCssParse(store), 'CSS parse (homepage + theme stylesheet) — fallback');
    } catch (err2) {
      console.warn(`CSS parse also failed (${err2.message}). Writing on-brand defaults.`);
      writeTokens(store, {}, 'built-in defaults (extraction unavailable)');
    }
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
