/**
 * recommender.js — The zero-hallucination core (tenant-aware).
 *
 * The model NEVER writes product names or prices. It is given a compact index (id + minimal
 * fields) and must call the `recommend_products` tool, returning product_ids + reasons only.
 * We validate every id against the real catalogue (silently dropping unknowns) and let APP CODE
 * attach the real name/price/image/url/variants. Prices always come from the catalogue.
 *
 * Each store uses its OWN Anthropic API key (per-store usage monitoring) — resolved from env.
 */

const config = require('../config');
const catalogue = require('./catalogue');
const { getStore, apiKeyEnvName } = require('../stores/registry');

const API_URL = 'https://api.anthropic.com/v1/messages';

const RECOMMEND_TOOL = {
  name: 'recommend_products',
  description:
    'Return your conversational reply plus the products you recommend, selected by id from the ' +
    'supplied product list. Use this for EVERY turn, even when you recommend nothing (send an ' +
    'empty recommendations array and put your question/decline in reply).',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'A short, warm, on-brand message to the shopper. Never state prices or assume a size here.',
      },
      recommendations: {
        type: 'array',
        description: '0–6 products. Empty when clarifying or declining.',
        items: {
          type: 'object',
          properties: {
            product_id: { type: 'number', description: 'MUST be an id from the supplied product list. Never invent one.' },
            reason: { type: 'string', description: 'One short sentence on why this suits the shopper.' },
          },
          required: ['product_id', 'reason'],
        },
      },
    },
    required: ['reply', 'recommendations'],
  },
};

function buildSystemPrompt(store) {
  const sym = store.currencySymbol;
  const businessType = store.businessType || 'a Shopify store';
  const lines = [
    `You are the shopping concierge for ${store.storeName}, ${businessType}.`,
    `Help the shopper find the right product from ONLY the products provided in this conversation.`,
    ``,
    `HARD RULES (never break these):`,
    `- Only ever recommend products from the supplied list. NEVER invent, assume, or imply a`,
    `  product exists. If it's not in the list, you do not have it.`,
    `- Recommend products by returning their ids via the recommend_products tool, each with a`,
    `  short, specific reason tied to what the shopper told you.`,
    `- NEVER state a price yourself — the app renders real prices from the catalogue. You may`,
    `  reference budget in words ("comfortably under budget") but never quote a number.`,
    `- If the shopper gives a budget, respect it: only recommend items within it.`,
    `- If nothing fits (e.g. something ${store.storeName} doesn't stock), say so warmly and`,
    `  honestly, offer the nearest real thing if there is one, and DON'T force a poor match or`,
    `  pretend to stock it. Send an empty recommendations array when declining or clarifying.`,
    `- When the request is vague ("something nice, you pick"), ask ONE good follow-up question`,
    `  before recommending — but if they then say "you choose", just pick well.`,
    ``,
    `OPTIONS / VARIANTS:`,
    `- Some products have options (size, weight, colour, variant). The shopper picks the option in`,
    `  the interface — NEVER assume one, and never claim you've added a specific size/option.`,
    `- Don't invent details (measurements, weights, ingredients) that aren't given for the item.`,
  ];
  if (store.bundleGuidance) lines.push('', store.bundleGuidance);
  lines.push(
    ``,
    `TONE: ${store.brandVoice} Talk like ${store.storeName}'s best in-store salesperson, not a`,
    `corporate chatbot. Keep replies short and genuine. Currency is ${store.currency} (${sym}).`
  );
  return lines.join('\n');
}

function renderProductList(items) {
  return items
    .map((p) => {
      const tags = (p.tags || []).slice(0, 6).join(', ');
      const colour = p.colour ? ` | colour: ${p.colour}` : '';
      return (
        `- id: ${p.id} | ${p.title} | category: ${p.category}${colour} | price: ${p.priceDisplay} ` +
        `| tags: ${tags}\n    ${p.description}`
      );
    })
    .join('\n');
}

function buildMessages(history, productListText) {
  const messages = history.map((m) => ({ role: m.role, content: String(m.content) }));
  const lastUserIdx = [...messages].reverse().findIndex((m) => m.role === 'user');
  if (lastUserIdx === -1) return messages;
  const idx = messages.length - 1 - lastUserIdx;
  messages[idx] = {
    role: 'user',
    content:
      `${messages[idx].content}\n\n` +
      `--- PRODUCTS YOU MAY CHOOSE FROM (recommend only these ids) ---\n` +
      `${productListText}\n` +
      `--- END PRODUCTS ---`,
  };
  return messages;
}

/** Resolve a store's Anthropic key: ANTHROPIC_API_KEY_<ID> (or apiKeyEnv) -> ANTHROPIC_API_KEY. */
function resolveApiKey(store) {
  const name = apiKeyEnvName(store);
  const specific = process.env[name];
  if (specific) return { key: specific, source: name };
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY (fallback)' };
  throw new Error(`No API key for store "${store.id}". Set ${name} (or ANTHROPIC_API_KEY as a fallback).`);
}

async function callAnthropic(store, { system, messages }) {
  const { key } = resolveApiKey(store);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': config.ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: config.MODEL,
      max_tokens: config.MAX_TOKENS,
      system,
      messages,
      tools: [RECOMMEND_TOOL],
      tool_choice: { type: 'tool', name: RECOMMEND_TOOL.name },
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractToolInput(apiResponse) {
  const block = (apiResponse.content || []).find((b) => b.type === 'tool_use' && b.name === RECOMMEND_TOOL.name);
  if (!block) throw new Error('Model did not return the recommend_products tool call.');
  return block.input || {};
}

/**
 * Main entry. `recommend(history, storeId)` -> { reply, recommendations, meta }.
 * Each recommendation is a real catalogue product (unknown ids dropped), including its
 * `variants`/`hasSizes` so the widget can render a size selector (no assumed size).
 */
async function recommend(history, storeId) {
  const store = getStore(storeId);
  if (!store) throw new Error(`Unknown store "${storeId}".`);

  const productMap = catalogue.buildProductMap(storeId);
  const fullIndex = catalogue.buildCompactIndex(storeId);

  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const lastUserText = lastUser ? lastUser.content : '';

  // Enforce budget in CODE (never rely on the model): keep only within-budget items so an
  // over-budget product can't be shown as if it fits. If nothing is within budget, keep the full
  // set so the concierge can honestly offer the nearest thing. Applies to ALL catalogue sizes.
  let candidates = fullIndex;
  const budget = catalogue.parseBudget(lastUserText);
  if (budget != null) {
    const within = fullIndex.filter((p) => p.price == null || p.price <= budget);
    if (within.length) candidates = within;
  }

  // For large catalogues, additionally narrow to keyword/category candidates.
  let usedPrefilter = false;
  if (candidates.length > config.PREFILTER_THRESHOLD) {
    candidates = catalogue.prefilter(lastUserText, candidates);
    usedPrefilter = true;
  }

  const apiResponse = await callAnthropic(store, {
    system: buildSystemPrompt(store),
    messages: buildMessages(history, renderProductList(candidates)),
  });
  const toolInput = extractToolInput(apiResponse);

  const reply = typeof toolInput.reply === 'string' ? toolInput.reply : '';
  const rawRecs = Array.isArray(toolInput.recommendations) ? toolInput.recommendations : [];

  // DEFENSIVE VALIDATION: keep only ids that exist in the real catalogue. Dedupe. Drop
  // anything the model hallucinated. Names/prices/variants come from the catalogue map.
  const seen = new Set();
  const recommendations = [];
  const droppedIds = [];
  for (const rec of rawRecs) {
    const k = String(rec.product_id);
    if (seen.has(k)) continue;
    const product = productMap.get(k);
    if (!product) {
      droppedIds.push(rec.product_id);
      continue;
    }
    seen.add(k);
    recommendations.push({ ...product, reason: String(rec.reason || '') });
  }

  return {
    reply,
    recommendations,
    meta: { usedPrefilter, candidateCount: candidates.length, catalogueSize: fullIndex.length, droppedIds },
  };
}

module.exports = { recommend, buildSystemPrompt, resolveApiKey, RECOMMEND_TOOL, renderProductList, buildMessages };
