/**
 * embed.js — The embeddable ENRGY-style shopping concierge widget.
 *
 * Install on a Shopify store by adding to theme.liquid (before </body>):
 *   <script defer src="https://YOUR-APP.up.railway.app/embed.js" data-store="enrgy"></script>
 *
 * - Reads its store id from the <script data-store> attribute and derives the backend base URL
 *   from its own src, so the same file serves every tenant.
 * - Renders inside a Shadow DOM (style-isolated from the theme) using the store's extracted
 *   design tokens, so it looks native.
 * - Zero hallucination: products/prices come from the backend (which renders from the real
 *   catalogue); the model only ever selects ids.
 * - Sizing: sized garments require an explicit size choice — the widget NEVER defaults a size.
 * - Cart, dual mode:
 *     • On a Shopify storefront (window.Shopify present) -> same-origin AJAX /cart/add.js, no nav.
 *     • Elsewhere (local demo) -> Shopify cart permalink opened in a new tab.
 */
(function () {
  'use strict';

  // ---- Locate own <script>, read config ----
  const self =
    document.currentScript ||
    (function () {
      const s = document.querySelectorAll('script[src*="embed.js"]');
      return s[s.length - 1];
    })();
  const STORE = (self && self.getAttribute('data-store')) || 'enrgy';
  const BASE = self ? new URL(self.src).origin : '';
  const ON_SHOPIFY = typeof window.Shopify !== 'undefined';

  if (window.__conciergeLoaded) return;
  window.__conciergeLoaded = true;

  const state = { cfg: null, history: [], open: false, cartCount: 0 };

  // ---- Boot ----
  fetch(`${BASE}/api/config?store=${encodeURIComponent(STORE)}`)
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg.error) throw new Error(cfg.error);
      state.cfg = cfg;
      mount(cfg);
    })
    .catch((err) => console.error('[concierge] failed to load config:', err.message));

  // ---- DOM helpers ----
  function h(tag, attrs, kids) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach((c) => el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return el;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let root; // shadow root

  function mount(cfg) {
    injectFonts(cfg.tokens);
    const host = h('div', { id: 'enrgy-concierge' });
    document.body.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(styleEl(cfg.tokens));
    root.appendChild(bubbleEl());
    root.appendChild(panelEl(cfg));
  }

  // The store's fonts may be Shopify-hosted (won't load off-store) — load the same families from
  // Google Fonts so the widget renders them everywhere. Fonts are document-global, so a <link> in
  // the page head applies inside our Shadow DOM too. Unknown families just fail quietly to fallback.
  function injectFonts(t) {
    if (document.querySelector('link[data-concierge-fonts]')) return;
    const families = [...new Set([t.fontHeading, t.fontBody]
      .map((f) => (f || '').split(',')[0].replace(/['"]/g, '').trim())
      .filter((f) => f && !/^(sans-serif|serif|monospace|system-ui|-apple-system|inherit|initial|ui-sans-serif)$/i.test(f)))];
    if (!families.length) return;
    const href =
      'https://fonts.googleapis.com/css2?' +
      families.map((f) => `family=${f.replace(/\s+/g, '+')}:wght@400;500;600;700`).join('&') +
      '&display=swap';
    const add = (rel, h2, cross) => {
      const l = document.createElement('link');
      l.rel = rel; l.href = h2; if (cross) l.crossOrigin = 'anonymous';
      document.head.appendChild(l);
      return l;
    };
    add('preconnect', 'https://fonts.googleapis.com');
    add('preconnect', 'https://fonts.gstatic.com', true);
    add('stylesheet', href).setAttribute('data-concierge-fonts', '');
  }

  function styleEl(t) {
    const s = h('style');
    s.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ${t.fontBody}; }
      .bubble {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
        width: 60px; height: 60px; border-radius: 999px; cursor: pointer;
        background: ${t.colorAccent}; color: ${t.colorButtonText};
        border: none; display: flex; align-items: center; justify-content: center;
        box-shadow: 0 6px 24px rgba(0,0,0,.22); font-size: 26px;
      }
      .bubble .brandmark { width: 38px; height: 38px; display: block; overflow: visible; }
      .mark-e { fill: ${t.colorButtonText}; }
      .mark-ai-bg { fill: ${t.colorButtonText}; }
      .mark-ai-text { fill: ${t.colorAccent}; font-family: ${t.fontHeading}, sans-serif; }
      .panel {
        position: fixed; right: 20px; bottom: 92px; z-index: 2147483000;
        width: 440px; max-width: calc(100vw - 32px); height: 680px; max-height: calc(100vh - 110px);
        background: ${t.colorBg}; color: ${t.colorText};
        border-radius: ${rad(t.radius)}; box-shadow: 0 12px 48px rgba(0,0,0,.28);
        display: none; flex-direction: column; overflow: hidden;
      }
      .panel.open { display: flex; }
      .head {
        background: ${t.colorAccent}; color: ${t.colorButtonText};
        padding: 16px 18px; display: flex; align-items: center; justify-content: space-between;
      }
      .head .t { font-family: ${t.fontHeading}; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; font-size: 17px; }
      .head .x { cursor: pointer; background: none; border: none; color: inherit; font-size: 22px; line-height: 1; }
      .head .cart { font-size: 13px; opacity: .85; }
      .body { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 14px; }
      .msg { max-width: 90%; line-height: 1.5; font-size: 15.5px; }
      .msg.user { align-self: flex-end; background: ${t.colorAccent}; color: ${t.colorButtonText}; padding: 10px 13px; border-radius: ${rad(t.radius)}; }
      .msg.bot .bubbletext { background: #f4f4f4; color: #111; padding: 11px 13px; border-radius: ${rad(t.radius)}; }
      .msg.bot.thinking .bubbletext { opacity: .6; font-style: italic; }
      .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
      .card { border: 1px solid #e6e6e6; border-radius: ${rad(t.radius)}; overflow: hidden; display: flex; flex-direction: column; background: #fff; color: #111; }
      .card .img { aspect-ratio: 1/1; background: #f2f2f2; }
      .card .img img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .card .b { padding: 11px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
      .card .nm { font-family: ${t.fontHeading}; font-weight: 600; font-size: 14px; line-height: 1.25; }
      .card .pr { font-weight: 600; font-size: 14px; }
      .card .rs { font-size: 12.5px; opacity: .75; line-height: 1.4; flex: 1; }
      .sizes { display: flex; flex-wrap: wrap; gap: 5px; }
      .sz { font-size: 12px; min-width: 32px; text-align: center; padding: 6px 8px; border: 1px solid ${t.colorAccent}; border-radius: ${rad(t.radius)}; cursor: pointer; background: #fff; color: ${t.colorAccent}; }
      .sz[aria-pressed="true"] { background: ${t.colorAccent}; color: ${t.colorButtonText}; }
      .sz.disabled { opacity: .3; pointer-events: none; text-decoration: line-through; }
      .btn { font-family: ${t.fontHeading}; font-weight: 700; letter-spacing: .03em; border-radius: ${rad(t.radius)}; border: 1px solid ${t.colorAccent}; padding: 10px 12px; font-size: 12.5px; cursor: pointer; text-align: center; text-decoration: none; }
      .btn.solid { background: ${t.colorAccent}; color: ${t.colorButtonText}; }
      .btn.ghost { background: transparent; color: ${t.colorAccent}; }
      .btn[disabled] { opacity: .4; cursor: not-allowed; }
      .acts { display: flex; gap: 6px; margin-top: 4px; }
      .acts .btn { flex: 1; }
      .bundle { margin-top: 12px; border-top: 1px dashed #ddd; padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
      .bundle .lbl { font-size: 12.5px; opacity: .7; }
      .bundle .fitsizes { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
      .note { font-size: 12.5px; color: #b00; }
      .chips { padding: 0 18px 14px; display: flex; flex-wrap: wrap; gap: 8px; }
      .chip { font-size: 13px; border: 1px solid ${t.colorAccent}; color: ${t.colorAccent}; background: transparent; border-radius: ${rad(t.radius)}; padding: 8px 12px; cursor: pointer; }
      .composer { display: flex; gap: 8px; padding: 14px 16px; border-top: 1px solid #eee; }
      .composer input { flex: 1; font-size: 15px; padding: 12px 14px; border: 1px solid #cfcfcf; border-radius: ${rad(t.radius)}; outline: none; }
      .composer input:focus { border-color: ${t.colorAccent}; }
      .composer .send { background: ${t.colorAccent}; color: ${t.colorButtonText}; border: none; border-radius: ${rad(t.radius)}; padding: 0 18px; font-size: 14px; font-family: ${t.fontHeading}; font-weight: 700; cursor: pointer; }
    `;
    return s;
  }
  // Cap the widget radius so a 0px-radius store still gets a soft panel, but respect rounded themes.
  function rad(r) { const n = parseFloat(r); return Number.isFinite(n) && n > 0 ? r : '10px'; }

  let bodyEl, inputEl, sendEl, cartEl, panel;

  // Default icon if a store has no logo.svg (a simple chat-spark glyph).
  const DEFAULT_ICON =
    '<svg class="brandmark" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path class="mark-e" d="M4 4h16v11H8l-4 4z"/></svg>';

  function bubbleEl() {
    const icon = (state.cfg && state.cfg.logoSvg) || DEFAULT_ICON;
    return h('button', { class: 'bubble', title: 'Chat with the stylist', onclick: toggle, html: icon });
  }

  function panelEl(cfg) {
    cartEl = h('span', { class: 'cart' });
    bodyEl = h('div', { class: 'body' });
    inputEl = h('input', { type: 'text', placeholder: 'Describe the vibe or the fit…', 'aria-label': 'Message the stylist' });
    sendEl = h('button', { class: 'send', onclick: submit }, ['Send']);
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    const chips = h('div', { class: 'chips' }, (cfg.examplePrompts || []).map((p) =>
      h('button', { class: 'chip', onclick: () => { inputEl.value = p; submit(); } }, [p])
    ));

    // Greeting
    bodyEl.appendChild(botBubble(`Hey! I'm the ${cfg.storeName} stylist. Tell me the vibe and I'll build the full fit.`));

    panel = h('div', { class: 'panel' }, [
      h('div', { class: 'head' }, [
        h('div', {}, [h('div', { class: 't' }, [cfg.storeName]), cartEl]),
        h('button', { class: 'x', title: 'Close', onclick: toggle, html: '&times;' }),
      ]),
      bodyEl,
      chips,
      h('div', { class: 'composer' }, [inputEl, sendEl]),
    ]);
    return panel;
  }

  function toggle() { state.open = !state.open; panel.classList.toggle('open', state.open); if (state.open) inputEl.focus(); }

  function botBubble(text) {
    return h('div', { class: 'msg bot' }, [h('div', { class: 'bubbletext' }, [text || ''])]);
  }
  function scrollDown() { bodyEl.scrollTop = bodyEl.scrollHeight; }

  async function submit() {
    const text = (inputEl.value || '').trim();
    if (!text) return;
    inputEl.value = '';
    sendEl.disabled = true;

    bodyEl.appendChild(h('div', { class: 'msg user' }, [text]));
    state.history.push({ role: 'user', content: text });
    const thinking = h('div', { class: 'msg bot thinking' }, [h('div', { class: 'bubbletext' }, ['styling your fit…'])]);
    bodyEl.appendChild(thinking);
    scrollDown();

    try {
      const res = await fetch(`${BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ store: STORE, messages: state.history }),
      });
      const data = await res.json();
      thinking.remove();
      if (!res.ok) {
        bodyEl.appendChild(botBubble(`Sorry — something went wrong (${data.error || res.status}).`));
      } else {
        renderBotResponse(data);
        state.history.push({ role: 'assistant', content: data.reply || '' });
      }
    } catch (err) {
      thinking.remove();
      bodyEl.appendChild(botBubble(`Sorry — couldn't reach the stylist (${err.message}).`));
    } finally {
      sendEl.disabled = false;
      inputEl.focus();
      scrollDown();
    }
  }

  function renderBotResponse(data) {
    const wrap = botBubble(data.reply);
    const recs = data.recommendations || [];
    if (recs.length) {
      const cards = h('div', { class: 'cards' });
      recs.forEach((p) => cards.appendChild(productCard(p)));
      wrap.appendChild(cards);

      const buyable = recs.filter((p) => p.available);
      if (buyable.length >= 2) wrap.appendChild(bundleBar(buyable));
    }
    bodyEl.appendChild(wrap);
    scrollDown();
  }

  // Each card tracks its chosen variant in card._chosen (null until the shopper picks a size).
  function productCard(p) {
    const card = h('div', { class: 'card' });
    card._product = p;
    card._chosen = p.hasSizes ? null : p.variantId; // one-size items are ready immediately

    const img = h('div', { class: 'img' }, p.image ? [h('img', { src: p.image, alt: esc(p.title), loading: 'lazy' })] : []);

    const addBtn = h('button', { class: 'btn solid' }, ['Add']);
    addBtn.disabled = p.hasSizes; // sized items: disabled until a size is chosen
    addBtn.addEventListener('click', () => { if (card._chosen) addToCart([{ variantId: card._chosen, product: p }], addBtn); });

    const b = h('div', { class: 'b' }, [
      h('div', { class: 'nm' }, [p.title]),
      h('div', { class: 'pr' }, [p.priceDisplay + (p.available ? '' : ' · sold out')]),
    ]);

    if (p.hasSizes) {
      const sizes = h('div', { class: 'sizes' });
      p.variants.forEach((v) => {
        const chip = h('button', { class: 'sz' + (v.available ? '' : ' disabled'), 'aria-pressed': 'false' }, [v.label]);
        if (v.available) chip.addEventListener('click', () => {
          card._chosen = v.id;
          sizes.querySelectorAll('.sz').forEach((c) => c.setAttribute('aria-pressed', 'false'));
          chip.setAttribute('aria-pressed', 'true');
          addBtn.disabled = false;
          card.dispatchEvent(new CustomEvent('sizechange', { bubbles: true }));
        });
        sizes.appendChild(chip);
      });
      b.appendChild(sizes);
    }

    if (p.reason) b.appendChild(h('div', { class: 'rs' }, [p.reason]));
    const view = h('a', { class: 'btn ghost', href: p.url, target: '_blank', rel: 'noopener' }, ['View']);
    const acts = h('div', { class: 'acts' }, [view]);
    if (p.available) acts.appendChild(addBtn);
    b.appendChild(acts);

    card.appendChild(img);
    card.appendChild(b);
    return card;
  }

  // "Add all to cart" for a fit. Requires a size on every sized item (never assumes one).
  function bundleBar(buyable) {
    const bar = h('div', { class: 'bundle' });
    const total = buyable.reduce((s, p) => s + (p.priceMin || 0), 0);
    const sym = (state.cfg && state.cfg.currencySymbol) || '';

    // Optional convenience: set one size across all sized items in this fit (where available).
    const sized = buyable.filter((p) => p.hasSizes);
    let fitSizes = null;
    if (sized.length) {
      const labels = [...new Set(sized.flatMap((p) => p.variants.filter((v) => v.available).map((v) => v.label)))];
      fitSizes = h('div', { class: 'fitsizes' }, [h('span', { class: 'lbl' }, ['Set my size:'])]);
      labels.forEach((label) => {
        const chip = h('button', { class: 'sz' }, [label]);
        chip.addEventListener('click', () => applyFitSize(label));
        fitSizes.appendChild(chip);
      });
      bar.appendChild(fitSizes);
    }

    const note = h('div', { class: 'note' });
    note.style.display = 'none';
    const addAll = h('button', { class: 'btn solid' }, [`Add all ${buyable.length} to cart · ${sym}${total.toFixed(2)}`]);

    addAll.addEventListener('click', () => {
      const cards = currentCardsFor(buyable);
      const missing = cards.filter((c) => !c._chosen);
      if (missing.length) {
        note.textContent = `Pick a size for: ${missing.map((c) => c._product.title).join(', ')}`;
        note.style.display = 'block';
        return;
      }
      note.style.display = 'none';
      addToCart(cards.map((c) => ({ variantId: c._chosen, product: c._product })), addAll);
    });

    bar._buyable = buyable;
    bar.appendChild(addAll);
    bar.appendChild(note);
    return bar;
  }

  // Find the rendered cards (in the latest message) for a set of products.
  function currentCardsFor(products) {
    const ids = new Set(products.map((p) => p.id));
    return [...bodyEl.querySelectorAll('.card')].filter((c) => c._product && ids.has(c._product.id) && c._product.available);
  }
  function applyFitSize(label) {
    bodyEl.querySelectorAll('.card').forEach((card) => {
      if (!card._product || !card._product.hasSizes) return;
      const v = card._product.variants.find((x) => x.label === label && x.available);
      if (!v) return;
      card._chosen = v.id;
      card.querySelectorAll('.sz').forEach((c) => c.setAttribute('aria-pressed', c.textContent === label ? 'true' : 'false'));
      const addBtn = card.querySelector('.acts .btn.solid');
      if (addBtn) addBtn.disabled = false;
    });
  }

  // ---- Cart: AJAX on a real storefront, permalink fallback elsewhere ----
  async function addToCart(items, btn) {
    const variantIds = items.map((i) => i.variantId).filter(Boolean);
    if (!variantIds.length) return;

    if (ON_SHOPIFY) {
      const original = btn.textContent;
      btn.disabled = true; btn.textContent = 'Adding…';
      try {
        const root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
        const res = await fetch(`${root}cart/add.js`.replace('//cart', '/cart'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: variantIds.map((id) => ({ id, quantity: 1 })) }),
        });
        if (res.status === 422) {
          const e = await res.json().catch(() => ({}));
          bodyEl.appendChild(botBubble(`Ah — ${e.description || 'that just sold out'}. Want me to swap it?`));
          btn.textContent = original; btn.disabled = false; scrollDown();
          return;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        await refreshCart(root);
        btn.textContent = 'Added ✓';
        notifyTheme();
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1600);
      } catch (err) {
        bodyEl.appendChild(botBubble(`Couldn't add to cart (${err.message}).`));
        btn.textContent = original; btn.disabled = false; scrollDown();
      }
    } else {
      // Local demo / non-Shopify page: open the store's cart permalink in a new tab.
      const url = `${state.cfg.storeUrl}/cart/${variantIds.map((id) => id + ':1').join(',')}`;
      window.open(url, '_blank', 'noopener');
    }
  }

  async function refreshCart(root) {
    try {
      const cart = await (await fetch(`${root}cart.js`.replace('//cart', '/cart'))).json();
      state.cartCount = cart.item_count || 0;
      if (cartEl) cartEl.textContent = state.cartCount ? `🛒 ${state.cartCount} in cart` : '';
    } catch (_) { /* indicator is best-effort */ }
  }

  // Nudge the theme to refresh its native cart drawer/icon.
  function notifyTheme() {
    try {
      document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
      document.dispatchEvent(new CustomEvent('cart:build'));
      if (window.Shopify && window.Shopify.PubSub) window.Shopify.PubSub.publish('cart:updated', {});
    } catch (_) { /* themes vary; best-effort */ }
  }
})();
