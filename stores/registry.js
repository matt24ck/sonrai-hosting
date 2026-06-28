/**
 * registry.js — the multi-tenant store registry.
 *
 * Each entry is one Shopify store the concierge serves. ALL per-store settings live here;
 * per-store DATA (catalogue + theme tokens + optional logo.svg) lives in ./<id>/.
 *
 * To onboard a new store:
 *   1. Add an entry below.
 *   2. npm run fetch -- <id>          (writes stores/<id>/catalogue.json)
 *   3. npm run extract-theme -- <id>  (writes stores/<id>/theme-tokens.{json,css})
 *   4. Add ANTHROPIC_API_KEY_<ID> in your host's env (or rely on the shared ANTHROPIC_API_KEY).
 *   5. (Live) add the embed snippet with data-store="<id>" to that store's theme.liquid.
 *
 * Fields:
 *   id, storeName, storeUrl, currency, currencySymbol, allowedOrigins[]  — identity / CORS
 *   brandVoice            — tone for the concierge
 *   examplePrompts[]      — starter chips
 *   businessType          — short description of the business (drives the system prompt)
 *   apparel               — true only for clothing stores; gates size/colour catalogue derivation
 *   optionWord            — UI noun for a product variant ('size' | 'colour' | 'option')
 *   greeting              — opening line in the chat
 *   bundleGuidance        — optional prompt text for suggesting a set / "add all to cart"
 *   apiKeyEnv (optional)  — override the per-store API key env var name
 */

const STORES = {
  enrgy: {
    id: 'enrgy',
    storeName: 'ENRGY Clothing',
    storeUrl: 'https://www.enrgyclothing.com',
    currency: 'EUR',
    currencySymbol: '€',
    allowedOrigins: ['https://www.enrgyclothing.com', 'https://enrgyclothing.com'],
    businessType: 'an Irish gymwear/streetwear brand',
    apparel: true,
    optionWord: 'size',
    brandVoice:
      'young, energetic and street — a confident Irish gymwear/streetwear brand that talks ' +
      'like its customer, hyped about new "drops", never corporate or stiff.',
    examplePrompts: [
      'Build me a full Stealth fit in arctic blue',
      'A gift for a 16-year-old into streetwear, ~€40',
      'Something to train in under €25',
    ],
    greeting: "Hey! I'm the ENRGY stylist — tell me the vibe and I'll build the full fit.",
    bundleGuidance:
      'SHOP-THE-LOOK (your best move): when a shopper likes a piece, proactively build the COMPLETE ' +
      'matching outfit in the SAME colourway — e.g. hoodie + matching pant + tee (+ cap) all in the ' +
      'same colour family — so they can buy the whole fit at once. Match colourways by the product\'s ' +
      'colour (e.g. all "Artic Blue"). Caps are neutral and finish most fits.',
  },

  etaoin: {
    id: 'etaoin',
    storeName: 'Ceramics by Etaoin O’Reilly',
    storeUrl: 'https://ceramicsbyetaoinoreilly.com',
    currency: 'EUR',
    currencySymbol: '€',
    allowedOrigins: ['https://ceramicsbyetaoinoreilly.com', 'https://www.ceramicsbyetaoinoreilly.com'],
    businessType: 'a handmade ceramics studio making small-batch, one-off stoneware pieces',
    apparel: false,
    optionWord: 'option',
    brandVoice:
      'warm, artisanal and calm — celebrates handmade craft and the character of one-off pieces; ' +
      'unhurried and tactile, never salesy.',
    examplePrompts: [
      'A calming gift for a coffee lover',
      'Something handmade under €40',
      'A piece for a minimalist kitchen',
    ],
    greeting: 'Hi! I can help you find the perfect handmade piece — what are you after?',
    bundleGuidance:
      'Where it genuinely suits the shopper, you may suggest a small set of pieces that go together ' +
      '(e.g. a mug and a bowl) so they can buy them as one.',
  },

  frankhederman: {
    id: 'frankhederman',
    storeName: 'Frank Hederman',
    storeUrl: 'https://www.frankhederman.com',
    currency: 'EUR',
    currencySymbol: '€',
    allowedOrigins: ['https://www.frankhederman.com', 'https://frankhederman.com'],
    businessType:
      "Ireland's oldest traditional smokehouse, known for oak-smoked salmon and artisan foods",
    apparel: false,
    optionWord: 'option',
    brandVoice:
      'proud, warm and appetising — a heritage Cork smokehouse; talks about provenance and craft ' +
      'with genuine pride, makes the food sound delicious without overselling.',
    examplePrompts: [
      'A foodie gift under €50',
      'Something special for a smoked-salmon lover',
      'What goes well with the smoked salmon?',
    ],
    greeting: 'Hello! Looking for something from the smokehouse? Tell me the occasion.',
    bundleGuidance:
      'Where it fits the occasion, suggest a small gift set of complementary items (e.g. smoked ' +
      'salmon plus a partner product) they can buy together.',
  },

  lizwalsh: {
    id: 'lizwalsh',
    storeName: 'Liz Walsh',
    storeUrl: 'https://www.lizwalsh.ie',
    currency: 'EUR',
    currencySymbol: '€',
    allowedOrigins: ['https://www.lizwalsh.ie', 'https://lizwalsh.ie'],
    businessType: 'Irish linen homewares — screen-printed planters and sustainable home pieces, made in Ireland',
    apparel: false,
    optionWord: 'colour',
    brandVoice:
      'friendly, design-led and sustainable — proud of being Irish-made; warm and tasteful, ' +
      'highlights craft, colour and eco-credentials.',
    examplePrompts: [
      'A housewarming gift under €30',
      'Something sustainable and Irish-made',
      'A planter for a sunny windowsill',
    ],
    greeting: "Hi! Tell me what you're after and I'll find the right piece for your home.",
    bundleGuidance:
      'Where it suits, suggest a couple of complementary homeware pieces that work well together.',
  },

  chalkandeasel: {
    id: 'chalkandeasel',
    storeName: 'Chalk & Easel',
    storeUrl: 'https://chalkandeasel.ie',
    currency: 'EUR',
    currencySymbol: '€',
    allowedOrigins: ['https://chalkandeasel.ie', 'https://www.chalkandeasel.ie'],
    businessType: 'an eco, plastic-free greeting card and stationery shop, Irish-made',
    apparel: false,
    optionWord: 'option',
    brandVoice:
      'cheerful, playful and eco-conscious — friendly and a little witty; proud of plastic-free, ' +
      'Irish-made credentials.',
    examplePrompts: [
      "A thank-you card that's a bit different",
      'An eco birthday card for a friend',
      'A plastic-free gift under €15',
    ],
    greeting: "Hi! Tell me the occasion and I'll find the perfect card or gift.",
    bundleGuidance:
      'Where it suits, suggest a couple of cards or a card-and-gift pairing they can buy together.',
  },
};

function getStore(id) {
  return STORES[id] || null;
}

function allStores() {
  return Object.values(STORES);
}

/** Env var name holding this store's Anthropic key. */
function apiKeyEnvName(store) {
  if (store.apiKeyEnv) return store.apiKeyEnv;
  const slug = String(store.id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `ANTHROPIC_API_KEY_${slug}`;
}

/** Every origin allowed across all stores (for the CORS allow-list). */
function allAllowedOrigins() {
  const set = new Set();
  for (const s of allStores()) (s.allowedOrigins || []).forEach((o) => set.add(o));
  return [...set];
}

module.exports = { STORES, getStore, allStores, apiKeyEnvName, allAllowedOrigins };
