#!/usr/bin/env node
// Read-only historical DIP sampler. Unlike dip-history-backtest.mjs, its source is the
// public Gamma API rather than the application's resolved archive. It is deliberately a
// separate tool: Gamma rows are sampled into a local cache and are never written to the
// application database just to make a research result look larger.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { backtestDipMarket, fetchMarketHistory, needsSimulation } from "./dip-history-backtest.mjs";
import { MARKET_SHAPE_IDS, marketShape } from "./paper-trading-bot.mjs";

const GAMMA_HOST = (process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com").replace(/\/$/, "");
const TAG = String(process.env.DIP_GAMMA_TAG || "tennis").trim().toLowerCase();
const TARGET_PER_SHAPE = clampInt(process.env.DIP_GAMMA_MARKETS_PER_SHAPE, 100, 1, 2000);
const MAX_EVENT_PAGES = clampInt(process.env.DIP_GAMMA_MAX_EVENT_PAGES, 12, 1, 200);
const CONCURRENCY = clampInt(process.env.DIP_GAMMA_CONCURRENCY, 3, 1, 6);
const CACHE_PATH = resolve(process.env.DIP_GAMMA_CACHE_PATH || `data/.cache/dip-gamma-${TAG}-cache.json`);
const REPORT_PATH = resolve(process.env.DIP_GAMMA_REPORT_PATH || `data/.cache/dip-gamma-${TAG}-report.json`);
const OPENING_FLOORS = [0.65, 0.7];
const BUY_BAND = [0.45, 0.56];

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoBeforeNow(value, now = Date.now()) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed <= now ? new Date(parsed).toISOString() : null;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fetchJson(url, label, retries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "trading-dip-gamma-backtest/1.0" },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object") throw new Error(`${label}: HTTP ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < retries) await new Promise((resume) => setTimeout(resume, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`${label}: request failed`);
}

export function gammaList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tagSlugs(event = {}) {
  return gammaList(event.tags).map((tag) => String(tag?.slug || tag?.label || tag || "").trim().toLowerCase()).filter(Boolean);
}

function gammaFeeRate(market = {}) {
  const schedule = market.feeSchedule && typeof market.feeSchedule === "object" ? market.feeSchedule : {};
  return Math.max(0, number(schedule.rate, number(market.firstFeeRate, 0)) || 0);
}

function marketIdentity(event = {}, market = {}) {
  return String(market.conditionId || market.id || market.slug || `${event.slug || event.id}:unknown`).trim();
}

// `startDate` is when Gamma created the market on many sports events, not kickoff. Game
// start is supplied separately, and choosing the wrong field would count pre-match moves as
// an under-way dip. Fall back only when the explicit field is unavailable.
function eventStart(event = {}, market = {}) {
  return market.gameStartTime || event.startTime || market.startTime || event.eventDate || null;
}

export function gammaRowsForEvent(event = {}, now = Date.now()) {
  const rows = [];
  for (const market of gammaList(event.markets)) {
    if (!market || typeof market !== "object") continue;
    const outcomes = gammaList(market.outcomes);
    const finalPrices = gammaList(market.outcomePrices).map((value) => number(value));
    const tokenIds = gammaList(market.clobTokenIds).map((value) => String(value || "").trim());
    const resolvedAt = isoBeforeNow(market.closedTime || event.closedTime || market.endDate, now);
    if (outcomes.length !== 2 || finalPrices.length !== 2 || tokenIds.length !== 2 || !resolvedAt) continue;
    if (!finalPrices.every((price) => price != null && (price <= 0.005 || price >= 0.995))) continue;
    const base = {
      eventKey: String(event.slug || event.id || market.slug || market.id || "").trim(),
      marketKey: marketIdentity(event, market),
      shape: marketShape(market),
      question: String(market.question || event.title || ""),
      slug: String(market.slug || ""),
      eventSlug: String(event.slug || ""),
      tags: tagSlugs(event),
      marketCreatedAt: market.createdAt || event.startDate || null,
      eventStartTime: eventStart(event, market),
      resolvedAt,
      feesEnabled: market.feesEnabled !== false,
      firstFeeRate: gammaFeeRate(market),
    };
    if (!base.marketCreatedAt || !base.eventStartTime) continue;
    for (let index = 0; index < 2; index += 1) {
      if (!/^\d{8,100}$/.test(tokenIds[index])) continue;
      rows.push({
        ...base,
        tokenId: tokenIds[index],
        outcome: String(outcomes[index] || ""),
        finalOutcomePrice: finalPrices[index],
      });
    }
  }
  return rows;
}

// A tennis fixture exposes many correlated props (sets, games, handicaps). One hundred
// such rows from ten fixtures are not a hundred observations. Keep one deterministic
// market per (event, shape), while retaining its two complementary outcome tokens.
export function selectGammaMarketSamples(rows = [], target = TARGET_PER_SHAPE, selected = new Map()) {
  const pageMarkets = new Map();
  for (const row of rows) {
    if (!row?.shape || !row?.eventKey || !row?.marketKey) continue;
    const key = `${row.shape}\u0000${row.eventKey}\u0000${row.marketKey}`;
    const pair = pageMarkets.get(key) || [];
    pair.push(row);
    pageMarkets.set(key, pair);
  }
  for (const pair of [...pageMarkets.values()].sort((left, right) => String(left[0]?.marketKey || "").localeCompare(String(right[0]?.marketKey || "")))) {
    const first = pair[0];
    const bucket = selected.get(first.shape) || new Map();
    if (bucket.has(first.eventKey) || bucket.size >= target) {
      selected.set(first.shape, bucket);
      continue;
    }
    bucket.set(first.eventKey, pair);
    selected.set(first.shape, bucket);
  }
  return selected;
}

export function selectCandidateSide(results = [], openingFloor = 0.65, openingCeiling = 0.999) {
  return results
    .filter((row) => row?.status === "complete" && row.verifiedOpening && row.openingInBand)
    .filter((row) => number(row.openingPrice) != null && row.openingPrice + 1e-9 >= openingFloor && row.openingPrice - 1e-9 <= openingCeiling)
    .sort((left, right) => number(right.openingPrice, -1) - number(left.openingPrice, -1))[0] || null;
}

function entryInBand(row, [floor, ceiling] = BUY_BAND) {
  const levels = Object.values(row?.entries || {}).filter(Boolean);
  return levels
    .filter((entry) => number(entry.entryPrice) != null && entry.entryPrice + 1e-9 >= floor && entry.entryPrice - 1e-9 <= ceiling)
    .sort((left, right) => Date.parse(left.enteredAt || 0) - Date.parse(right.enteredAt || 0))[0] || null;
}

function stats(entries = []) {
  const wins = entries.filter((entry) => entry.outcome === "WIN").length;
  const pnl = entries.reduce((total, entry) => total + (number(entry.pnlUsdc, 0) || 0), 0);
  const invested = entries.reduce((total, entry) => total + 5 + (number(entry.feeUsdc, 0) || 0), 0);
  return {
    trades: entries.length,
    wins,
    losses: entries.length - wins,
    accuracyPct: entries.length ? (wins / entries.length) * 100 : null,
    pnlUsdc: pnl,
    investedUsdc: invested,
    roiPct: invested > 0 ? (pnl / invested) * 100 : null,
  };
}

export function shapeSummary(marketRows = [], cacheMarkets = {}, { openingFloor = 0.65, buyBand = BUY_BAND, target = TARGET_PER_SHAPE } = {}) {
  const byShape = new Map();
  for (const row of marketRows) {
    const current = byShape.get(row.shape) || [];
    current.push(row);
    byShape.set(row.shape, current);
  }
  return MARKET_SHAPE_IDS.map((shape) => {
    const source = byShape.get(shape) || [];
    const groups = new Map();
    for (const row of source) {
      const current = groups.get(row.marketKey) || [];
      current.push(cacheMarkets[row.tokenId]);
      groups.set(row.marketKey, current);
    }
    const historyWithVerifiedOpeningMarkets = [...groups.values()]
      .filter((rows) => rows.some((row) => row?.status === "complete" && row.verifiedOpening)).length;
    // This is intentionally stricter than the preceding count: only the side that opened
    // in the requested 65+/70+ favourite band can represent a DIP candidate.
    const selected = [...groups.values()].map((rows) => selectCandidateSide(rows, openingFloor)).filter(Boolean);
    const entries = selected.map((row) => entryInBand(row, buyBand)).filter(Boolean);
    const coverage = {
      sourceMarkets: groups.size,
      sourceEvents: new Set(source.map((row) => row.eventKey).filter(Boolean)).size,
      sourceOutcomes: source.length,
      completedMarkets: [...groups.values()].filter((rows) => rows.some((row) => row?.status === "complete")).length,
      historyWithVerifiedOpeningMarkets,
      openingBandMarkets: selected.length,
      eligibleEntries: entries.length,
      minimumEligibleEntriesMet: entries.length >= target,
    };
    return {
      shape,
      ...coverage,
      ...stats(entries),
      recommendation: coverage.minimumEligibleEntriesMet
        ? "enough executed historical entries for a recommendation"
        : `not enough: ${entries.length}/${target} simulated entries in this exact rule`,
    };
  });
}

async function fetchTagId() {
  const tag = await fetchJson(`${GAMMA_HOST}/tags/slug/${encodeURIComponent(TAG)}`, `Gamma tag ${TAG}`);
  const id = String(tag?.id || "").trim();
  if (!id) throw new Error(`Gamma did not return an id for tag ${TAG}`);
  return id;
}

async function sourceRowsFromGamma(tagId) {
  const selected = new Map();
  let afterCursor = null;
  let pagesRead = 0;
  for (; pagesRead < MAX_EVENT_PAGES; pagesRead += 1) {
    const url = new URL(`${GAMMA_HOST}/events/keyset`);
    for (const [key, value] of Object.entries({
      closed: "true", tag_id: tagId, limit: "100", order: "endDate", ascending: "false",
      end_date_max: new Date().toISOString(), ...(afterCursor ? { after_cursor: afterCursor } : {}),
    })) url.searchParams.set(key, value);
    const page = await fetchJson(url, `Gamma ${TAG} page ${pagesRead + 1}`);
    const rows = (Array.isArray(page.events) ? page.events : []).flatMap((event) => gammaRowsForEvent(event));
    selectGammaMarketSamples(rows.filter((row) => MARKET_SHAPE_IDS.includes(row.shape)), TARGET_PER_SHAPE, selected);
    const enough = [...selected.values()].filter((bucket) => bucket.size >= TARGET_PER_SHAPE).length;
    if (!page.next_cursor || enough === selected.size || !String(page.next_cursor).trim()) break;
    afterCursor = page.next_cursor;
  }
  const rows = [...selected.values()].flatMap((bucket) => [...bucket.values()].flat());
  return { rows, pagesRead: pagesRead + 1, sampledEventsByShape: Object.fromEntries([...selected.entries()].map(([shape, bucket]) => [shape, bucket.size])) };
}

async function runPool(rows, handler) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      await handler(row);
    }
  }));
}

async function main() {
  const tagId = await fetchTagId();
  const source = await sourceRowsFromGamma(tagId);
  if (!source.rows.length) throw new Error(`Gamma returned no settled binary ${TAG} markets with timestamps`);
  const previous = await readJson(CACHE_PATH, { markets: {} });
  const cache = { version: 1, tag: TAG, source: "gamma", updatedAt: new Date().toISOString(), markets: previous?.markets || {} };
  const pending = source.rows.filter((row) => needsSimulation(row, cache.markets[row.tokenId]));
  let processed = 0;
  await runPool(pending, async (row) => {
    try {
      cache.markets[row.tokenId] = backtestDipMarket(row, await fetchMarketHistory(row));
    } catch (error) {
      cache.markets[row.tokenId] = { tokenId: row.tokenId, status: "error", reason: String(error?.message || error).slice(0, 240) };
    }
    processed += 1;
    if (processed % 25 === 0 || processed === pending.length) console.log(`Processed ${processed}/${pending.length}`);
  });
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: "Polymarket Gamma + CLOB public APIs",
    tag: TAG,
    tagId,
    rule: { openingFloors: OPENING_FLOORS.map((value) => value * 100), buyBand: BUY_BAND.map((value) => value * 100), stakeUsdc: 5, targetEligibleEntriesPerShape: TARGET_PER_SHAPE },
    coverage: { pagesRead: source.pagesRead, sampledEventsByShape: source.sampledEventsByShape, sourceOutcomes: source.rows.length, processedThisRun: processed, cachedOutcomes: Object.keys(cache.markets).length },
    shapes: OPENING_FLOORS.map((openingFloor) => ({ openingFloorPct: openingFloor * 100, rows: shapeSummary(source.rows, cache.markets, { openingFloor, target: TARGET_PER_SHAPE }) })),
    caveats: [
      "A signal uses the first CLOB price inside 45-56% after the recorded match start; a move before the start is excluded.",
      "The sample has no historical order-book depth, so it cannot prove a $5 FOK fill. It is evidence for a paper test, not a live-trading recommendation.",
      "Rows without a CLOB quote within 90 minutes of Gamma's market-creation time are not treated as verified openings.",
    ],
  };
  await writeJson(CACHE_PATH, cache);
  await writeJson(REPORT_PATH, report);
  console.log(`Gamma ${TAG}: ${source.rows.length} outcome rows sampled from ${source.pagesRead} page(s); ${processed} processed.`);
  for (const band of report.shapes) {
    console.log(`Opening ${band.openingFloorPct}%+:`);
    for (const row of band.rows.filter((item) => item.sourceMarkets)) {
      console.log(`  ${row.shape}: sources ${row.sourceMarkets}, verified history ${row.historyWithVerifiedOpeningMarkets}, opening band ${row.openingBandMarkets}, entries ${row.eligibleEntries}, ${row.recommendation}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
