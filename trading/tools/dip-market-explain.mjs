// Read-only. One market, explained end to end: what the hourly dip backtest saw, what the
// price actually did minute by minute, what the published backtest cache holds for it, and
// what the live account really traded. No orders, no writes, no credentials.
//
// Asked, after the setup backtest printed tennis outright dips as 8 of 8 wins: "tomuto
// vysledku neverim. tohle byl outright v tagu tennis a prohral" -- ATP Tabilo vs Paul,
// 2026-09-29. A single loss does not contradict 8 of 8 on its own; what matters is whether
// the backtest COULD have seen a trade like this one. So this prints both views of the same
// market side by side instead of arguing about the aggregate.
//
// The suspicion it is built to test: the backtest reads CLOB history one point per hour
// (fidelity is in minutes, and it asks for 60). A favourite that dips into the band and
// recovers tends to sit there long enough for an hourly point to land on it. A favourite
// that is actually losing falls THROUGH the band on its way down, between two hourly points,
// and the backtest sees it only once it is already below the floor -- no trade. The live
// worker checks the ask every second and buys on the way down. If that is what happens, the
// backtest is not merely noisy, it is biased toward winners.

import { backtestDipMarket, clobHistoryWindows } from "./dip-history-backtest.mjs";
import { dipRuleOf, findPortfolio, portfolioRows, setupEntry } from "./dip-setup-backtest.mjs";
import { marketShape } from "./paper-trading-bot.mjs";

const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const GAMMA = (process.env.GAMMA_API || "https://gamma-api.polymarket.com").replace(/\/+$/, "");
const CLOB = (process.env.POLYMARKET_CLOB_API || "https://clob.polymarket.com").replace(/\/+$/, "");

const num = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const seconds = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
};
const iso = (value) => (Number.isFinite(value) ? new Date(value * 1000).toISOString().replace(".000Z", "Z") : "-");

export function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// The kickoff, and which field it came from. Sports markets carry gameStartTime; the event
// may carry it instead. The field is printed with the time, because a wrong start time moves
// the whole in-play window and every conclusion below with it.
export function eventStartOf(market = {}, event = {}) {
  const candidates = [
    ["market.gameStartTime", market.gameStartTime],
    ["market.eventStartTime", market.eventStartTime],
    ["event.gameStartTime", event.gameStartTime],
    ["event.eventStartTime", event.eventStartTime],
    ["event.startTime", event.startTime],
  ];
  for (const [field, value] of candidates) {
    const at = seconds(value);
    if (at != null) return { at, field };
  }
  return { at: null, field: null };
}

function inPlay(points, startSec, endSec) {
  return points.filter((point) => point.t >= startSec && (endSec == null || point.t < endSec)
    && point.p > 0.005 && point.p < 0.995);
}

// The live rule at minute resolution: the first in-play moment the price sits inside the
// band. Price history is a mid, not the ask the worker reads, so on a liquid market this is
// close, and on an empty book it is not -- which is why the ask itself is printed from the
// live account wherever there was a real trade.
export function minuteRuleEntry(points, { startSec, endSec = null, buyMin, buyMax }) {
  return inPlay(points, startSec, endSec)
    .find((point) => point.p + 1e-9 >= buyMin && point.p - 1e-9 <= buyMax) || null;
}

// How long the price spent inside the band, and when. A band visit that lasts minutes
// between two hourly points is invisible to an hourly series.
export function bandVisits(points, { startSec, endSec = null, buyMin, buyMax }) {
  const live = inPlay(points, startSec, endSec);
  const inside = live.filter((point) => point.p + 1e-9 >= buyMin && point.p - 1e-9 <= buyMax);
  const lowest = live.reduce((best, point) => (!best || point.p < best.p ? point : best), null);
  return {
    points: live.length,
    insideCount: inside.length,
    firstInside: inside[0] || null,
    lastInside: inside[inside.length - 1] || null,
    lowest,
  };
}

function normalizedPoints(history) {
  const byTime = new Map();
  for (const point of Array.isArray(history) ? history : []) {
    const t = num(point?.t);
    const p = num(point?.p);
    if (t != null && p != null) byTime.set(t, { t, p });
  }
  return [...byTime.values()].sort((left, right) => left.t - right.t);
}

async function fetchJson(url, retries = 3) {
  let last = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "trading-dip-market-explain/1.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${last?.message || last}`);
}

async function priceHistory(tokenId, startSec, endSec, fidelityMinutes) {
  const points = [];
  for (const window of clobHistoryWindows(startSec, endSec)) {
    const url = new URL(`${CLOB}/prices-history`);
    url.searchParams.set("market", tokenId);
    url.searchParams.set("startTs", String(window.start));
    url.searchParams.set("endTs", String(window.end));
    url.searchParams.set("fidelity", String(fidelityMinutes));
    const payload = await fetchJson(url);
    if (Array.isArray(payload?.history)) points.push(...payload.history);
  }
  return normalizedPoints(points);
}

async function loadEvent(slug) {
  const events = await fetchJson(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`).catch(() => []);
  if (Array.isArray(events) && events[0]) return { event: events[0], markets: events[0].markets || [] };
  for (const closed of ["true", "false"]) {
    const markets = await fetchJson(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}&closed=${closed}`).catch(() => []);
    if (Array.isArray(markets) && markets[0]) return { event: (markets[0].events || [])[0] || {}, markets };
  }
  return { event: null, markets: [] };
}

const price = (value) => (value == null ? "   -  " : Number(value).toFixed(4));

function printPath(label, points, stepMinutes) {
  let lastShown = null;
  const shown = [];
  for (const point of points) {
    if (lastShown == null || point.t - lastShown >= stepMinutes * 60) {
      shown.push(`${iso(point.t).slice(11, 16)} ${point.p.toFixed(3)}`);
      lastShown = point.t;
    }
  }
  console.log(`      ${label}: ${shown.length ? shown.join("  ") : "(none)"}`);
}

async function main() {
  const slug = String(process.env.DIP_EXPLAIN_SLUG || "").trim().toLowerCase();
  const tag = String(process.env.DIP_EXPLAIN_TAG || "tennis").trim().toLowerCase();
  if (!slug) throw new Error("DIP_EXPLAIN_SLUG is required");
  console.log(`Dip market explain at ${new Date().toISOString()} -- ${slug}`);
  console.log("Read-only: Gamma, CLOB price history, the published cache and the live state.\n");

  let rule = { openMin: 0.7, openMax: 0.99, buyMin: 0.45, buyMax: 0.56, excludedShapes: [] };
  const wanted = String(process.env.DIP_EXPLAIN_PORTFOLIO || "dip 70+ -> 45-56 live");
  const config = (await fetchJson(`${HOST}/api.php?action=portfolio-config`).catch(() => ({})))?.config || {};
  const found = findPortfolio(portfolioRows(config), wanted);
  if (found) {
    const configured = dipRuleOf(found.row);
    if ([configured.openMin, configured.openMax, configured.buyMin, configured.buyMax].every((value) => value != null)) {
      rule = { ...configured, openMax: Math.min(configured.openMax, 0.99) };
    }
    console.log(`Rule of ${found.row.displayName || found.id}: opening ${rule.openMin}-${rule.openMax}, buy ${rule.buyMin}-${rule.buyMax},`
      + ` excluded shapes [${rule.excludedShapes.join(", ")}]`);
  } else {
    console.log(`No portfolio "${wanted}" -- using opening 0.70-0.99, buy 0.45-0.56`);
  }

  const { event, markets } = await loadEvent(slug);
  if (!markets.length) {
    console.log(`Gamma returned nothing for "${slug}".`);
    process.exitCode = 1;
    return;
  }
  console.log(`Event: ${event?.title || "-"}  (${markets.length} market(s))`);

  const cache = await fetchJson(`${HOST}/data/dip-backtest-${tag}-cache.json`).catch(() => null);
  const cached = cache?.markets && typeof cache.markets === "object" ? cache.markets : {};
  console.log(`Published ${tag} cache: ${cache ? `${Object.keys(cached).length} market(s)` : "unavailable"}`);

  const tokens = new Set();
  for (const market of markets) {
    const outcomes = parseList(market.outcomes).map(String);
    const tokenIds = parseList(market.clobTokenIds).map(String);
    const finals = parseList(market.outcomePrices).map(Number);
    const { at: startSec, field } = eventStartOf(market, event || {});
    const endSec = seconds(market.closedTime) ?? seconds(market.umaEndDate) ?? seconds(market.endDate);
    const shape = marketShape({ question: market.question, slug: market.slug, eventSlug: event?.slug });
    console.log(`\n=== ${market.question}  [${shape}]  slug ${market.slug}`);
    console.log(`   start ${iso(startSec)} (${field || "no start time"})   closed ${market.closed === true}   end ${iso(endSec)}`);
    if (startSec == null) continue;
    for (let side = 0; side < tokenIds.length; side += 1) {
      const tokenId = tokenIds[side];
      tokens.add(tokenId);
      const hourly = await priceHistory(tokenId, startSec - 14 * 86400, endSec ?? startSec + 12 * 3600, 60);
      const row = {
        tokenId, question: market.question, outcome: outcomes[side], slug: market.slug, eventSlug: event?.slug,
        eventStartTime: iso(startSec), marketCreatedAt: null, resolvedAt: endSec ? iso(endSec) : null,
        finalOutcomePrice: market.closed === true ? finals[side] : null,
      };
      const replay = backtestDipMarket(row, hourly);
      const opening = num(replay.openingPrice);
      const openInRule = opening != null && opening + 1e-9 >= rule.openMin && opening - 1e-9 <= rule.openMax;
      console.log(`\n   -- side ${outcomes[side]}  final ${finals[side] ?? "-"}   token ${tokenId.slice(0, 12)}...`);
      console.log(`      hourly opening ${price(opening)} at ${replay.openingAt || "-"} (${replay.openingSource || replay.reason || "-"})`
        + `   inside the rule's opening band: ${openInRule}`);
      if (!openInRule) continue;
      const hourlyInPlay = inPlay(hourly, startSec, endSec);
      console.log(`      hourly in-play points: ${hourlyInPlay.map((point) => `${iso(point.t).slice(11, 16)} ${point.p.toFixed(3)}`).join("  ") || "(none)"}`);
      const hourlyEntry = replay.status === "complete" ? setupEntry(replay, [rule.buyMin, rule.buyMax]) : null;
      console.log(`      HOURLY BACKTEST: ${hourlyEntry
        ? `buys at ${hourlyEntry.entryPrice} at ${hourlyEntry.enteredAt} -> ${hourlyEntry.outcome}`
        : `no trade (${replay.status === "complete" ? "no hourly in-play point inside the band" : replay.reason})`}`);

      const minute = await priceHistory(tokenId, startSec - 1800, Math.min(endSec ?? startSec + 12 * 3600, startSec + 12 * 3600), 1);
      const window = { startSec, endSec, buyMin: rule.buyMin, buyMax: rule.buyMax };
      const visits = bandVisits(minute, window);
      const entry = minuteRuleEntry(minute, window);
      printPath("minute path (every 10 min)", inPlay(minute, startSec, endSec), 10);
      console.log(`      minutes inside the band: ${visits.insideCount} of ${visits.points}`
        + `   first ${visits.firstInside ? `${iso(visits.firstInside.t)} at ${price(visits.firstInside.p)}` : "-"}`
        + `   lowest ${visits.lowest ? `${price(visits.lowest.p)} at ${iso(visits.lowest.t)}` : "-"}`);
      console.log(`      MINUTE RULE: ${entry
        ? `buys at ${price(entry.p)} at ${iso(entry.t)} -> ${finals[side] >= 0.995 ? "WIN" : finals[side] <= 0.005 ? "LOSS" : "unresolved"}`
        : "no trade"}`);
      const stored = cached[tokenId];
      console.log(`      published cache: ${stored
        ? `${stored.status}, opening ${stored.openingPrice}, entry@0.55 ${stored.entries?.["0.55"]?.entryPrice ?? "-"}, final ${stored.finalOutcomePrice}`
        : "not in the cache"}`);
    }
  }

  console.log("\n=== the live account on these tokens");
  const live = await fetchJson(`${HOST}/api.php?action=state&target=live&summary=dashboard`).catch((error) => ({ error: error.message }));
  const rows = [...(live?.closedTrades || []), ...(live?.positions || [])]
    .filter((row) => row && tokens.has(String(row.tokenId || row.assetId || "")));
  if (live?.error) console.log(`   live state unavailable: ${live.error}`);
  if (!rows.length) console.log("   no live trade or position on any token of this event");
  for (const row of rows) {
    console.log(`   ${String(row.question || "").slice(0, 50)} | ${row.outcome || "-"} | portfolio ${row.portfolioId || "-"}`);
    console.log(`      opened ${row.openedAt || row.createdAt || "-"} at ${row.entryPrice ?? "-"}   status ${row.status || "-"}`
      + `   exit ${row.exitPrice ?? "-"} ${row.closeReason || row.exitReason || ""}   closed ${row.closedAt || row.resolvedAt || "-"}`
      + `   P/L ${row.realizedPnlUsdc ?? row.pnlUsdc ?? "-"}`);
  }
  const policy = await fetchJson(`${HOST}/api.php?action=live-exit-policy`).catch(() => null);
  const policies = policy?.policies && typeof policy.policies === "object" ? policy.policies : {};
  for (const tokenId of tokens) {
    const entry = Array.isArray(policies) ? policies.find((item) => String(item?.tokenId) === tokenId) : policies[tokenId];
    if (entry) console.log(`   exit policy for ${tokenId.slice(0, 12)}...: owner ${entry.portfolioId || "-"}, ${JSON.stringify(entry).slice(0, 160)}`);
  }
  const hits = await fetchJson(`${HOST}/api.php?action=dip-entry-hits`).catch(() => null);
  for (const hit of (hits?.hits || []).filter((item) => tokens.has(String(item?.tokenId || "")))) {
    console.log(`   dip hit: ${hit.portfolioId || "-"} at ${hit.price ?? hit.entryPrice ?? "-"} ${hit.at || hit.recordedAt || ""}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Explain failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
