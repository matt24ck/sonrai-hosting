# Shopify AI Shopping Concierge — embeddable, multi-tenant widget

A floating **chat widget** that embeds on a Shopify store and acts as an AI stylist. Its best
move is **shop-the-look**: when a shopper likes a piece it builds the complete matching fit in the
same colourway and adds the whole set to the cart in one tap. Built first for **ENRGY Clothing**
and architected **multi-tenant** so adding more stores is a registry entry + a snippet.

## Two rules that define the build

**1. Zero hallucination.** Every product shown is a real, currently-listed product with the
correct name, price, image and link. Enforced structurally: the model only ever selects product
`id`s via a forced tool call; the backend renders name/price/image/url from the real catalogue;
unknown ids are silently dropped; prices never come from the model. See
[src/recommender.js](src/recommender.js).

**2. No assumed sizes.** Sized garments (tees, hoodies, pants, shorts) require the shopper to pick
a size in the widget — the code never defaults to one. Only genuine one-size items (caps) add
directly. See `enrich()` in [src/catalogue.js](src/catalogue.js) and the size selector in
[public/embed.js](public/embed.js).

## How it's wired

```
Browser (store page)                         Your server (Railway)              Anthropic
─────────────────────                        ─────────────────────              ─────────
embed.js in Shadow DOM   ── /api/config ──▶   Express, per-store registry
  (reads data-store,     ── /api/chat ───▶    recommender → forced tool call ──▶ Messages API
   derives backend URL)  ◀── real products    (validates ids, renders catalogue)  (per-store key)
  cart: /cart/add.js  ──▶ the STORE's origin (same-origin AJAX; no server involved)
```

- The widget runs **same-origin** on the store, so "Add to cart" / "Add all" call Shopify's
  **AJAX cart** (`/cart/add.js`) in-page — no navigation, conversation preserved. Off a storefront
  (local demo) it falls back to a Shopify **cart permalink** in a new tab. Same file, both modes.
- The **chat backend** is cross-origin (your Railway host); **CORS** restricts it to each store's
  configured origins. The Anthropic key stays server-side.

## Multi-tenant model

| Thing | Where |
|------|-------|
| Per-store settings (name, url, voice, prompts, allowed origins) | [stores/registry.js](stores/registry.js) |
| Per-store data (catalogue + theme tokens) | `stores/<id>/catalogue.json`, `stores/<id>/theme-tokens.json` |
| Global settings (model, prefilter, port) | [config.js](config.js) |
| Per-store Anthropic API key | env var `ANTHROPIC_API_KEY_<ID>` (see below) |

### Per-store API keys (per-store usage monitoring)
Each store uses its own Anthropic key so spend is tracked separately (put each in its own Anthropic
**Workspace** to set independent limits). Resolution order in [src/recommender.js](src/recommender.js):
`registry apiKeyEnv` → `ANTHROPIC_API_KEY_<ID>` → `ANTHROPIC_API_KEY` (fallback). Store id `enrgy`
→ env var **`ANTHROPIC_API_KEY_ENRGY`**.

## Local development

```bash
npm install
npx playwright install chromium  # one-time: browser used by theme extraction (skip only if you'll
                                 # rely on the CSS-parse fallback in scripts/extract-theme.js)
cp .env.example .env             # set ANTHROPIC_API_KEY_ENRGY= (or ANTHROPIC_API_KEY= as fallback)

npm run fetch -- enrgy           # ingest catalogue   -> stores/enrgy/catalogue.json   (cached)
npm run extract-theme -- enrgy   # extract theme      -> stores/enrgy/theme-tokens.{json,css}
npm run dev                      # http://localhost:3000/demo.html  (pretend storefront + widget)
npm run validate -- enrgy        # acceptance gate (needs the store's key)
```

`demo.html` is a stand-in storefront: the bubble loads, recommends real products, and uses the
**permalink** cart path (no `window.Shopify` locally). On the live store it auto-switches to AJAX.

**Choosing which client to test:** use the **store dropdown** on the demo page, or pass
`?store=<id>` in the URL (e.g. `http://localhost:3000/demo.html?store=acme`). The dropdown is
populated automatically from [stores/registry.js](stores/registry.js), so every onboarded client
appears there. From the CLI, target a client with `npm run validate -- <id>`.

> **10-second Shopify check** before onboarding any store: open
> `https://<store>/products.json?limit=2` — if you get product JSON, it'll work.

## Deploy to Railway

1. If this isn't a git repo yet: `git init && git add . && git commit -m "init"`, create an empty
   GitHub repo, and push. (`.env` is gitignored; the committed `stores/<id>/` data ships — correct.)
2. Create a Railway service from the GitHub repo. Nixpacks auto-detects Node and runs `npm start`;
   [railway.json](railway.json) sets the health check + restart policy. Railway provides `PORT`.
3. In the service **Variables**, add:
   - one key per store: `ANTHROPIC_API_KEY_ENRGY=…` (Railway redeploys on change);
   - **`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`** — important: the server never launches a browser at
     runtime (theme extraction is local-only and its output is committed), so this stops the build
     from downloading ~150 MB of Chromium for nothing. Without it, builds are slow and bloated.
4. **Pick a stable URL before any client installs the snippet.** Generate a Railway domain, or
   add a custom domain (e.g. `widget.yourco.com`). This URL is baked into every store's
   `theme.liquid`, so a domain you control lets you change hosts later without asking clients to
   re-paste anything.
5. Verify: `https://<domain>/healthz`, `https://<domain>/api/config?store=enrgy`,
   `https://<domain>/demo.html`.

## Catalogue auto-refresh

The server boots from the committed `stores/<id>/catalogue.json` (instant start) and then keeps it
current automatically — it re-fetches each store's public `products.json` on a schedule and
**hot-swaps the in-memory catalogue**. New products, price changes and sold-out items appear with
no redeploy and nothing for the store owner to do. See [src/refresh.js](src/refresh.js).

- **Cadence:** `CATALOGUE_REFRESH_MINUTES` (default `180`; set `0` to disable).
- **Failure-safe:** a failed or empty fetch is logged and the existing good catalogue is kept —
  a bad response never wipes a working catalogue.
- **Instant updates (optional):** set `REFRESH_TOKEN` and POST to `/api/refresh` to force a refresh
  immediately — e.g. wire a Shopify **`products/create|update`** webhook to it:
  ```
  curl -X POST https://<host>/api/refresh \
    -H "x-refresh-token: $REFRESH_TOKEN" -H "content-type: application/json" \
    -d '{"store":"enrgy"}'          # omit "store" to refresh all
  ```
- **Status:** `GET /healthz` returns each store's product `count` and last `fetchedAt`.

> Runtime refreshes also write `catalogue.json` to disk as a warm cache, but Railway's filesystem
> is ephemeral — that's fine, since the server re-fetches on every boot and on the interval.

**Scaling note:** `refreshAll()` in [src/refresh.js](src/refresh.js) refreshes stores **in series**
(one at a time). That's intentional and fine up to ~25 stores (a full cycle is well under a minute
of background, ~0-CPU network waiting). Past ~25 stores, parallelize it with a small concurrency
cap (~8 at a time) so a cycle finishes in seconds — a self-contained ~15-line change to that one
function; the per-store `try/catch` and atomic hot-swap stay as-is. CPU/cost are unaffected either
way (same total work, just overlapped).

## Install on a store (theme snippet)

In Shopify admin → **Online Store → Themes → Edit code → `layout/theme.liquid`**, add before
`</body>`:

```html
<script defer src="https://your-app.up.railway.app/embed.js" data-store="enrgy"></script>
```

Test on a **duplicated/preview theme** first. `data-store` selects the tenant; the widget derives
the backend URL from its own `src`.

## Onboarding another store (the per-client runbook)

Using a hypothetical client `acme` (~10–15 min, mostly one-time local setup):

1. **Shopify check:** open `https://<store-domain>/products.json?limit=2` — product JSON = good.
2. **Registry entry** in [stores/registry.js](stores/registry.js) — copy the `enrgy` block and edit.
   See the comment block at the top of that file for the full field list: `id`, `storeName`,
   `storeUrl`, `currency`, `currencySymbol`, `mode`, `brandVoice`, `examplePrompts`,
   `allowedOrigins`. Two things matter:
   - the **id** drives the env-var name (`acme` → `ANTHROPIC_API_KEY_ACME`) — keep it lowercase/simple;
   - **`allowedOrigins`** must list the store's real domains (e.g. `https://www.acme.com` and the
     apex) — this gates both the chat API (CORS) and the in-page AJAX cart.
3. **Pull data:** `npm run fetch -- acme` then `npm run extract-theme -- acme`. Commit `stores/acme/`.
4. *(Optional)* add `stores/acme/logo.svg` for the bubble icon — see **Authoring a client's bubble
   logo** below. Without it, a default icon shows.
5. **Sanity-check:** `npm run validate -- acme`. Besides the zero-hallucination/budget/sizing
   gates, eyeball that categories and colours look right — the derivation in
   [src/catalogue.js](src/catalogue.js) is tuned to ENRGY's `"Name - Colour"` naming and
   garment keywords; a brand that names products very differently may need a small tweak there
   (the validate output is how you'll spot it).
6. **Ship:** `git push` (Railway auto-redeploys), then add `ANTHROPIC_API_KEY_ACME` in Railway Variables.
7. **Owner installs** (one line, once): paste the snippet with `data-store="acme"` into their
   `theme.liquid`. From then on your changes flow to them automatically.

## Authoring a client's bubble logo (optional, manual per client)

The launcher bubble shows a per-store SVG from `stores/<id>/logo.svg`; without one a default icon
shows. The widget renders it **white on the store's dark accent bubble**, so author a *monochrome*
mark that inverts cleanly. Use [stores/enrgy/logo.svg](stores/enrgy/logo.svg) as the worked example.
How it was made (repeat per client):

1. Grab the store's real logo (Shopify exposes it — the header `<a href="/"> img`, or a
   `/cdn/shop/files/...` URL).
2. Trace it to SVG paths. **If the trace comes out as a filled block with the letterform knocked
   out** (the letter is transparent), invert the figure-ground so the **letter itself is the solid
   shape** — e.g. drop the outer rectangle and keep the inner subpaths. Otherwise it renders as a
   white *block* on the bubble instead of a white *mark*.
3. Tighten the `viewBox` to the artwork so it isn't tiny/off-centre in the round bubble.
4. Give shapes **class hooks and no baked colours**: `.mark-e` for the mark, and for the badge
   `.mark-ai-bg` (pill) + `.mark-ai-text`. The widget tints them from the store's tokens (white
   mark + white pill + accent "AI"), so one file works for any brand's colours.
5. Add the "AI" pill spaced above the mark's top-right; frame the whole thing roughly square.

Tip: drop the file in `stores/<id>/` and check it live via the demo dropdown before committing.
Multicolour logos won't invert to clean white — use a monochrome treatment for those.

## Resolved fonts (ENRGY)

The live store uses **Montserrat** (headings) + **Poppins** (body) via Shopify's font CDN. The
widget renders them by family name inside its Shadow DOM (Shopify stores already serve the fonts on
their own pages, so they resolve natively). Accent is near-black `rgb(18,18,18)`. Tokens live in
`stores/enrgy/theme-tokens.json`; re-run `extract-theme` to refresh.

## Acceptance bar (`npm run validate -- <id>`)

10 queries incl. a budget limit, a vague "you pick", a refinement turn, and an out-of-catalogue
request. Hard-fails on: any hallucinated id, any price not from the catalogue, any over-budget
item, a fudged out-of-catalogue answer, or **any sized item carrying a defaulted size**. One
hallucinated product = not ready.

## Scope

Built: the embeddable widget, same-origin AJAX cart (+ permalink fallback), multi-tenant backend,
theme-token extraction, **automatic catalogue refresh**, and validation. **Not** built: a full
Shopify App/theme-extension (snippet install chosen), accounts/analytics/multi-language, or
anything that writes to the store beyond the shopper's own cart. Theme tokens are still refreshed
manually (re-run `extract-theme`) since extraction needs a headless browser.
