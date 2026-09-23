#!/usr/bin/env node
// Historical DIP-entry backtest. Read-only against Polymarket and the application:
// it writes only its resumable local cache and the compact report published by its workflow.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const APP_HOST = (process.env.DIP_BACKTEST_APP_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/$/, "");
const CLOB_HOST = (process.env.POLYMARKET_CLOB_API || "https://clob.polymarket.com").replace(/\/$/, "");
const TAG = String(process.env.DIP_BACKTEST_TAG || "esports").trim().toLowerCase();
const MAX_MARKETS = clampInt(process.env.DIP_BACKTEST_MAX_MARKETS, 600, 25, 1500);
const CONCURRENCY = clampInt(process.env.DIP_BACKTEST_CONCURRENCY, 4, 1, 8);
const STAKE_USDC = 5;
const OPENING_MIN = 0.7;
const OPENING_MAX = 0.99;
const OPENING_WINDOW_SECONDS = 90 * 60;
const ENTRY_LEVELS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
// Version the result rule, not only the file. Cache rows are keyed by their source
// fingerprint, so this makes a corrected interpretation reprocess old rows instead of
// quietly continuing to show the conclusion of the earlier rule.
const OPENING_RULE_VERSION = 2;

if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(TAG)) {
  throw new Error("DIP_BACKTEST_TAG must be a lowercase Polymarket tag");
}

const cachePath = resolve(process.env.DIP_BACKTEST_CACHE_PATH || `data/dip-backtest-${TAG}-cache.json`);
const reportPath = resolve(process.env.DIP_BACKTEST_REPORT_PATH || `data/dip-backtest-${TAG}-report.json`);

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function number(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function iso(seconds) {
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function round(value, places = 6) {
  const numeric = number(value);
  if (numeric == null) return null;
  const scale = 10 ** places;
  return Math.round(numeric * scale) / scale;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
        headers: { "accept": "application/json", "user-agent": "trading-dip-history-backtest/1.0" },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object") {
        throw new Error(`${label}: HTTP ${response.status}`);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < retries) await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`${label}: request failed`);
}

function sourceToken(row) {
  const direct = String(row?.tokenId || row?.firstTokenId || row?.clobTokenId || "").trim();
  if (/^\d{8,100}$/.test(direct)) return direct;
  const first = Array.isArray(row?.clobTokenIds) ? String(row.clobTokenIds[0] || "").trim() : "";
  return /^\d{8,100}$/.test(first) ? first : "";
}

function sourceFingerprint(row) {
  return JSON.stringify([
    OPENING_RULE_VERSION,
    sourceToken(row), row?.finalOutcomePrice, row?.resolvedAt, row?.resolvedDetectedAt,
    row?.marketCreatedAt, row?.createdAt, row?.eventStartTime, row?.scheduledEventDate,
    row?.firstFeeRate, row?.feeRate, row?.feesEnabled,
  ]);
}

function normalizedHistory(payload) {
  const history = Array.isArray(payload?.history) ? payload.history : [];
  return history
    .map((point) => ({ t: number(point?.t), p: number(point?.p) }))
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p) && point.p > 0 && point.p < 1)
    .sort((left, right) => left.t - right.t);
}

function feeForEntry(row, entry) {
  const rate = number(row?.firstFeeRate ?? row?.feeRate, 0) || 0;
  if (rate <= 0 || row?.feesEnabled === false) return 0;
  // shares * rate * price * (1-price), where shares = stake / price.
  return STAKE_USDC * rate * (1 - entry);
}

export function backtestDipMarket(row, history) {
  const tokenId = sourceToken(row);
  const finalPrice = number(row?.finalOutcomePrice);
  const eventStartAt = timestamp(row?.eventStartTime ?? row?.scheduledEventDate);
  const createdAt = timestamp(row?.marketCreatedAt ?? row?.createdAt);
  const resolvedAt = timestamp(row?.resolvedAt ?? row?.resolvedDetectedAt ?? row?.resolutionEndDate ?? row?.endDate);
  const points = normalizedHistory({ history });
  const base = {
    tokenId,
    fingerprint: sourceFingerprint(row),
    question: String(row?.question || ""),
    outcome: String(row?.outcome || ""),
    slug: String(row?.slug || ""),
    eventSlug: String(row?.eventSlug || ""),
    marketCreatedAt: iso(createdAt),
    eventStartAt: iso(eventStartAt),
    resolvedAt: iso(resolvedAt),
    finalOutcomePrice: finalPrice == null ? null : round(finalPrice, 4),
  };
  if (!tokenId || !(finalPrice <= 0.005 || finalPrice >= 0.995)) {
    return { ...base, status: "skipped", reason: "market has no binary resolved outcome" };
  }
  if (!points.length) return { ...base, status: "unavailable", reason: "CLOB returned no historical prices" };

  const opening = points[0];
  const openingNearCreation = createdAt != null
    && opening.t >= createdAt - 300
    && opening.t <= createdAt + OPENING_WINDOW_SECONDS;
  const openingBeforeStart = eventStartAt != null && opening.t < eventStartAt;
  const verifiedOpening = openingNearCreation && openingBeforeStart;
  // The compact resolved archive predates marketCreatedAt for most historical rows. In
  // that case, treating a missing timestamp as a failed verification discarded every
  // market although the CLOB did return its oldest available, pre-start quote. It is not
  // proof of the literal creation price, so retain the distinction in the report, but it
  // is the best reproducible opening observation available for a historical simulation.
  const earliestPreStartOpening = createdAt == null && openingBeforeStart;
  const usableOpening = verifiedOpening || earliestPreStartOpening;
  const terminalCutoff = resolvedAt == null ? Number.POSITIVE_INFINITY : resolvedAt;
  const preResolution = points.filter((point) => point.t < terminalCutoff && point.p > 0.005 && point.p < 0.995);
  const lowest = preResolution.reduce((best, point) => (!best || point.p < best.p ? point : best), null);
  const inPlay = eventStartAt == null ? [] : preResolution.filter((point) => point.t >= eventStartAt);
  const openingInBand = usableOpening && opening.p >= OPENING_MIN && opening.p <= OPENING_MAX;
  const entries = {};
  for (const level of ENTRY_LEVELS) {
    const hit = openingInBand ? inPlay.find((point) => point.p <= level) : null;
    if (!hit) {
      entries[String(level)] = null;
      continue;
    }
    const fee = feeForEntry(row, hit.p);
    const cost = STAKE_USDC + fee;
    const pnl = finalPrice >= 0.995 ? (STAKE_USDC / hit.p) - cost : -cost;
    entries[String(level)] = {
      enteredAt: iso(hit.t),
      entryPrice: round(hit.p, 6),
      feeUsdc: round(fee, 6),
      pnlUsdc: round(pnl, 6),
      outcome: finalPrice >= 0.995 ? "WIN" : "LOSS",
    };
  }
  return {
    ...base,
    status: "complete",
    openingSource: verifiedOpening
      ? "CLOB near market creation"
      : (earliestPreStartOpening ? "earliest available CLOB quote before event start" : "earliest CLOB point only"),
    openingAt: iso(opening.t),
    openingPrice: round(opening.p, 6),
    verifiedOpening,
    usableOpening,
    earliestPreStartOpening,
    openingInBand,
    lowestPreResolutionAt: lowest ? iso(lowest.t) : null,
    lowestPreResolutionPrice: lowest ? round(lowest.p, 6) : null,
    maxDrawdownPct: lowest ? round(Math.max(0, (opening.p - lowest.p) / opening.p) * 100, 3) : null,
    entries,
  };
}

function historyRange(row) {
  const createdAt = timestamp(row?.marketCreatedAt ?? row?.createdAt);
  const eventStartAt = timestamp(row?.eventStartTime ?? row?.scheduledEventDate);
  const resolvedAt = timestamp(row?.resolvedAt ?? row?.resolvedDetectedAt ?? row?.resolutionEndDate ?? row?.endDate);
  // The long lookback gives CLOB a chance to return the first plotted ALL-chart point even
  // for old records that predate our own marketCreatedAt field.
  const fallbackStart = eventStartAt != null ? eventStartAt - (180 * 86400) : (resolvedAt != null ? resolvedAt - (180 * 86400) : null);
  const start = createdAt ?? fallbackStart;
  const end = resolvedAt ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  const span = end - start;
  // CLOB history is an observed price series, not a tick tape. Keep enough detail for an
  // in-play collapse without asking for millions of points on a long-running outright.
  const fidelity = span > 90 * 86400 ? 3600 : span > 21 * 86400 ? 300 : 60;
  return { start, end, fidelity };
}

async function fetchMarketHistory(row) {
  const tokenId = sourceToken(row);
  const range = historyRange(row);
  if (!tokenId || !range) return [];
  const url = new URL(`${CLOB_HOST}/prices-history`);
  url.searchParams.set("market", tokenId);
  url.searchParams.set("startTs", String(range.start));
  url.searchParams.set("endTs", String(range.end));
  url.searchParams.set("fidelity", String(range.fidelity));
  const payload = await fetchJson(url, `price history ${tokenId}`);
  return Array.isArray(payload?.history) ? payload.history : [];
}

function reportFromCache(sourceRows, cache, processedThisRun) {
  const rows = sourceRows.map((row) => cache.markets[sourceToken(row)]).filter(Boolean);
  const complete = rows.filter((row) => row.status === "complete");
  const usableOpening = complete.filter((row) => row.usableOpening);
  const creationVerified = usableOpening.filter((row) => row.verifiedOpening);
  const openingBand = usableOpening.filter((row) => row.openingInBand);
  const outcomes = ENTRY_LEVELS.map((level) => {
    const entries = openingBand.map((row) => row.entries?.[String(level)]).filter(Boolean);
    const wins = entries.filter((entry) => entry.outcome === "WIN").length;
    const losses = entries.length - wins;
    const fees = entries.reduce((sum, entry) => sum + (number(entry.feeUsdc, 0) || 0), 0);
    const pnl = entries.reduce((sum, entry) => sum + (number(entry.pnlUsdc, 0) || 0), 0);
    const invested = entries.length * STAKE_USDC + fees;
    return {
      entryProbability: Math.round(level * 100),
      trades: entries.length,
      wins,
      losses,
      accuracy: entries.length ? round((wins / entries.length) * 100, 2) : null,
      investedUsdc: round(invested, 2),
      feesUsdc: round(fees, 4),
      pnlUsdc: round(pnl, 2),
      roiPct: invested > 0 ? round((pnl / invested) * 100, 2) : null,
    };
  });
  const pending = sourceRows.filter((row) => {
    const stored = cache.markets[sourceToken(row)];
    return !stored || stored.fingerprint !== sourceFingerprint(row) || stored.status === "error";
  }).length;
  const details = openingBand
    .sort((left, right) => (number(right.maxDrawdownPct, -1) || -1) - (number(left.maxDrawdownPct, -1) || -1))
    .slice(0, 600);
  return {
    ok: true,
    version: OPENING_RULE_VERSION,
    generatedAt: new Date().toISOString(),
    tag: TAG,
    stakeUsdc: STAKE_USDC,
    openingRule: {
      probabilityMin: 70,
      probabilityMax: 99,
      maximumDelayMinutes: 90,
      description: "Uses a CLOB quote within 90 minutes of creation when creation time is recorded; otherwise the earliest available quote before event start.",
    },
    coverage: {
      sourceMarkets: sourceRows.length,
      cachedMarkets: rows.length,
      processedThisRun,
      pendingMarkets: pending,
      completeMarkets: complete.length,
      verifiedOpeningMarkets: usableOpening.length,
      creationVerifiedOpeningMarkets: creationVerified.length,
      openingBandMarkets: openingBand.length,
      unavailableHistory: rows.filter((row) => row.status === "unavailable").length,
      errors: rows.filter((row) => row.status === "error").length,
    },
    drawdown: {
      medianPct: round(median(openingBand.map((row) => number(row.maxDrawdownPct)).filter(Number.isFinite)), 2),
      maximumPct: round(Math.max(0, ...openingBand.map((row) => number(row.maxDrawdownPct, 0) || 0)), 2),
    },
    entries: outcomes,
    details,
    caveats: [
      "Entry uses the first recorded CLOB price at or below the selected level after the event began.",
      "Historical price series does not include contemporaneous order-book depth, so it cannot prove a full FOK fill at the displayed stake.",
      "When market creation time is missing from the archive, the oldest available CLOB quote before event start is used and is labelled pre-start rather than creation-verified.",
    ],
  };
}

async function runPool(rows, handler) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      await handler(row);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const sourceUrl = new URL(`${APP_HOST}/api.php`);
  sourceUrl.searchParams.set("action", "dip-backtest-source");
  sourceUrl.searchParams.set("tag", TAG);
  const source = await fetchJson(sourceUrl, "backtest source");
  const sourceRows = Array.isArray(source?.markets) ? source.markets.filter((row) => sourceToken(row)) : [];
  if (!sourceRows.length) throw new Error(`No resolved ${TAG} markets were returned by the application`);

  const previous = await readJson(cachePath, { version: OPENING_RULE_VERSION, tag: TAG, markets: {} });
  const cache = {
    version: OPENING_RULE_VERSION,
    tag: TAG,
    updatedAt: new Date().toISOString(),
    markets: previous?.tag === TAG && previous?.markets && typeof previous.markets === "object" ? previous.markets : {},
  };
  const pending = sourceRows.filter((row) => {
    const stored = cache.markets[sourceToken(row)];
    return !stored || stored.fingerprint !== sourceFingerprint(row) || stored.status === "error";
  }).slice(0, MAX_MARKETS);
  let completed = 0;
  await runPool(pending, async (row) => {
    const tokenId = sourceToken(row);
    try {
      cache.markets[tokenId] = backtestDipMarket(row, await fetchMarketHistory(row));
    } catch (error) {
      cache.markets[tokenId] = {
        tokenId,
        fingerprint: sourceFingerprint(row),
        status: "error",
        reason: String(error?.message || error).slice(0, 240),
      };
    }
    completed += 1;
    if (completed % 25 === 0 || completed === pending.length) console.log(`Processed ${completed}/${pending.length}`);
  });
  const current = new Set(sourceRows.map(sourceToken));
  for (const tokenId of Object.keys(cache.markets)) {
    if (!current.has(tokenId)) delete cache.markets[tokenId];
  }
  const report = reportFromCache(sourceRows, cache, completed);
  await writeJson(cachePath, cache);
  await writeJson(reportPath, report);
  console.log(`Backtest ${TAG}: ${report.coverage.cachedMarkets}/${report.coverage.sourceMarkets} cached, ${report.coverage.pendingMarkets} pending`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
