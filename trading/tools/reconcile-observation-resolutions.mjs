/*
 * Proves old observation settlements against Gamma without relying on an end date or an
 * event-level slug. A fixture can have many sibling props, so only the row's own market slug
 * (or its exact CLOB token) may be used to obtain the final 0/1 outcome.
 */
const storageUrl = String(process.env.TRADING_STORAGE_ADMIN_URL || "").trim();
const triggerKey = String(process.env.TRADING_TRIGGER_KEY || "").trim();
const batchLimit = Math.max(25, Math.min(1000, Number(process.env.RESOLUTION_BATCH_LIMIT || 250)) || 250);
const maxBatches = Math.max(1, Math.min(100, Number(process.env.RESOLUTION_BATCHES || 1)) || 1);
const olderThanDays = Math.max(1, Math.min(365, Number(process.env.RESOLUTION_OLDER_THAN_DAYS || 7)) || 7);
const concurrency = Math.max(1, Math.min(16, Number(process.env.RESOLUTION_CONCURRENCY || 8)) || 8);

if (!storageUrl || !triggerKey) {
  throw new Error("TRADING_STORAGE_ADMIN_URL and TRADING_TRIGGER_KEY are required.");
}

const nowIso = () => new Date().toISOString();
const bool = (value) => value === true || value === 1 || String(value || "").toLowerCase() === "true";

async function jsonFetch(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* response details below */ }
    if (!response.ok) {
      throw new Error(`${response.status} ${typeof payload?.error === "string" ? payload.error : text.slice(0, 180)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function storage(operation, body = {}) {
  const payload = await jsonFetch(storageUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Trading-Trigger-Key": triggerKey,
    },
    body: JSON.stringify({ operation, ...body }),
  }, 90_000);
  if (!payload?.ok) throw new Error(payload?.error || `Storage ${operation} failed.`);
  return payload;
}

function exactMarket(rows, candidate) {
  const slug = String(candidate.marketSlug || "").trim().toLowerCase();
  const token = String(candidate.tokenId || "").trim();
  return (Array.isArray(rows) ? rows : []).find((market) => {
    const marketSlug = String(market?.slug || "").trim().toLowerCase();
    if (slug && marketSlug === slug) return true;
    const tokens = parseList(market?.clobTokenIds);
    return !slug && token && tokens.includes(token);
  }) || null;
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* comma fallback */ }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function selectedOutcomeIndex(market, candidate) {
  const tokens = parseList(market?.clobTokenIds);
  const token = String(candidate.tokenId || "").trim();
  const tokenIndex = token ? tokens.findIndex((item) => item === token) : -1;
  if (tokenIndex >= 0) return tokenIndex;
  const outcome = String(candidate.outcome || "").trim().toLowerCase();
  const outcomes = parseList(market?.outcomes);
  const matching = outcomes.reduce((matches, item, index) => (
    String(item).trim().toLowerCase() === outcome ? [...matches, index] : matches
  ), []);
  return matching.length === 1 ? matching[0] : -1;
}

async function gammaMarket(candidate) {
  const slug = String(candidate.marketSlug || "").trim();
  const token = String(candidate.tokenId || "").trim();
  const query = new URL("https://gamma-api.polymarket.com/markets");
  if (slug) query.searchParams.set("slug", slug);
  else query.searchParams.set("clob_token_ids", token);
  query.searchParams.set("closed", "true");
  const rows = await jsonFetch(query.toString(), {}, 15_000);
  return exactMarket(rows, candidate);
}

async function patchFor(candidate) {
  const checkedAt = nowIso();
  try {
    const market = await gammaMarket(candidate);
    if (!market || !bool(market.closed)) {
      return { observationKey: candidate.observationKey, checkedAt };
    }
    const index = selectedOutcomeIndex(market, candidate);
    const prices = parseList(market.outcomePrices).map(Number);
    const price = index >= 0 ? prices[index] : Number.NaN;
    if (!Number.isFinite(price) || !(price <= 0.001 || price >= 0.999)) {
      return { observationKey: candidate.observationKey, checkedAt };
    }
    const outcomes = parseList(market.outcomes);
    const tokens = parseList(market.clobTokenIds);
    const yesIndex = outcomes.findIndex((item) => String(item).trim().toLowerCase() === "yes");
    const noIndex = outcomes.findIndex((item) => String(item).trim().toLowerCase() === "no");
    return {
      observationKey: candidate.observationKey,
      checkedAt,
      marketClosed: true,
      finalOutcomePrice: Number(price.toFixed(6)),
      firstSideFinalOutcomePrice: Number(price.toFixed(6)),
      settledTokenId: tokens[index] || candidate.tokenId || null,
      outcomeCount: outcomes.length || tokens.length || null,
      binaryYesTokenId: yesIndex >= 0 ? tokens[yesIndex] || null : null,
      binaryNoTokenId: noIndex >= 0 ? tokens[noIndex] || null : null,
      // Gamma does not consistently expose an actual close timestamp. Its updatedAt is only
      // accepted as a fallback for a newly proven terminal market, never refreshed later.
      resolvedAt: market.closedTime || market.updatedAt || market.updated_at || checkedAt,
    };
  } catch (error) {
    console.warn(`Could not verify ${candidate.marketSlug || candidate.tokenId}: ${error.message}`);
    return { observationKey: candidate.observationKey, checkedAt, verifierError: "fetch_failed" };
  }
}

async function mapConcurrent(items, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]);
    }
  }));
  return output;
}

const totals = { examined: 0, applied: 0, pending: 0, missing: 0, invalid: 0 };
for (let batch = 0; batch < maxBatches; batch += 1) {
  const queue = await storage("resolution-candidates", { limit: batchLimit, olderThanDays });
  const candidates = queue?.queue?.candidates || [];
  if (!candidates.length) break;
  const patches = await mapConcurrent(candidates, patchFor);
  const applied = await storage("apply-remote-resolutions", { patches });
  const result = applied.result || {};
  totals.examined += candidates.length;
  for (const key of ["applied", "pending", "missing", "invalid"]) totals[key] += Number(result[key] || 0);
  console.log(JSON.stringify({ batch: batch + 1, candidates: candidates.length, result }));
  if (candidates.length < batchLimit) break;
}
console.log(JSON.stringify({ ok: true, ...totals }));
