#!/usr/bin/env node
// Where candidates are actually lost, and how stale the in-play rows are.
//
// Read-only: public GETs, no secrets, no writes, no orders.
//
// Two questions.
//
// 1. "Often there are few candidates, so it takes what is there rather than the best."
//    The catalogue holds thousands of markets, so the shortage is not supply of ROWS -- it
//    is the filter chain. This runs the REAL chain (portfolioFilterResult, imported, not a
//    reimplementation) over the real catalogue for every configured portfolio, and counts
//    which rule rejected what. A replica would answer a question about the replica; the
//    point is to find out which rule is actually doing the cutting.
//
// 2. The claim to test is that the movement, and so the opportunity, is in events already
//    underway -- and that those should be refreshed far more often, perhaps every minute.
//    So: how many in-play rows there are, how old their quotes are, and how many of them
//    each portfolio can currently trade. If they are already refreshed within a minute or
//    two there is nothing to win; if they are hours stale, that is the lever.
import { setTimeout as sleep } from "node:timers/promises";

const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const PAGE_LIMIT = 1200;
const MAX_PAGES = 24;

async function get(path, attempts = 3) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      last = error;
      // The hosting has been intermittently 500ing under load. Retry gently rather than
      // dying on a blip, having already cost it the request.
      if (attempt + 1 < attempts) await sleep(2 ** attempt * 3000);
    }
  }
  throw new Error(`GET ${path} failed: ${last?.message || last}`);
}

const minutesSince = (value) => {
  const at = Date.parse(value || "");
  return Number.isFinite(at) ? (Date.now() - at) / 60000 : null;
};

function bucketise(values, edges, label) {
  const counts = edges.map(() => 0);
  let over = 0;
  for (const value of values) {
    const index = edges.findIndex((edge) => value <= edge);
    if (index === -1) over += 1;
    else counts[index] += 1;
  }
  console.log(`   ${label}`);
  edges.forEach((edge, index) => {
    if (counts[index]) console.log(`      <= ${String(edge).padStart(6)} : ${counts[index]}`);
  });
  if (over) console.log(`      >  ${String(edges[edges.length - 1]).padStart(6)} : ${over}`);
}

async function main() {
  const config = await get("data/portfolio-config.json");
  // The bot builds its strategies from this variable at module load, so it has to be set
  // before the import. That is why the import below is dynamic.
  const paper = config?.paper && typeof config.paper === "object" ? config.paper : {};
  process.env.PAPER_CUSTOM_PORTFOLIOS = JSON.stringify(paper);
  const bot = await import("./paper-trading-bot.mjs");

  const rows = [];
  const seen = new Set();
  let partial = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let payload = null;
    try {
      payload = await get(`api.php?action=state&target=paper&summary=scraped&offset=${page * PAGE_LIMIT}`);
    } catch (error) {
      console.log(`!! stopped paging at offset ${page * PAGE_LIMIT}: ${error.message}`);
      partial = true;
      break;
    }
    const batch = Array.isArray(payload?.marketObservations) ? payload.marketObservations : [];
    if (!batch.length) break;
    for (const row of batch) {
      const key = String(row?.tokenId || row?.id || row?.marketKey || "");
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push(row);
    }
    if (payload?.scrapedScopeTruncated !== true) break;
  }

  console.log(`== catalogue: ${rows.length} active rows${partial ? " (PARTIAL READ)" : ""}`);

  // ---- in-play ----------------------------------------------------------------------
  const running = rows.filter((row) => bot.rowEventIsRunning(row));
  console.log(`\n== events already underway: ${running.length} of ${rows.length}`);
  const quoteAges = running
    .map((row) => minutesSince(row?.marketDataUpdatedAt || row?.observedAt || row?.updatedAt))
    .filter((value) => value != null);
  console.log(`   rows whose quote age is readable: ${quoteAges.length}`);
  if (quoteAges.length) {
    const sorted = [...quoteAges].sort((a, b) => a - b);
    const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    console.log(`   quote age in minutes -- median ${at(0.5).toFixed(1)}, p90 ${at(0.9).toFixed(1)}, worst ${sorted[sorted.length - 1].toFixed(1)}`);
    bucketise(quoteAges, [1, 5, 15, 30, 60, 180, 720], "how stale the in-play quotes are (minutes):");
  }
  // The same for the whole catalogue, so "in-play is stale" can be told apart from
  // "everything is stale", which would be a different problem with a different fix.
  const allAges = rows
    .map((row) => minutesSince(row?.marketDataUpdatedAt || row?.observedAt || row?.updatedAt))
    .filter((value) => value != null);
  if (allAges.length) {
    const sorted = [...allAges].sort((a, b) => a - b);
    const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    console.log(`   whole catalogue for comparison -- median ${at(0.5).toFixed(1)}, p90 ${at(0.9).toFixed(1)} minutes`);
  }

  // ---- where candidates are lost ------------------------------------------------------
  const strategies = bot.PAPER_STRATEGIES;
  const ids = Object.keys(strategies).filter((id) => strategies[id] && strategies[id].archived !== true);
  console.log(`\n== why rows are rejected, per portfolio (${ids.length} active)`);
  console.log("   the REAL filter chain, imported from the bot, over the real catalogue\n");

  for (const id of ids) {
    const strategy = strategies[id];
    const reasons = new Map();
    let eligible = 0;
    let runningEligible = 0;
    for (const row of rows) {
      const result = bot.portfolioFilterResult(row, strategy);
      const list = Array.isArray(result?.reasons) ? result.reasons : [];
      if (!list.length) {
        eligible += 1;
        if (bot.rowEventIsRunning(row)) runningEligible += 1;
        continue;
      }
      // The FIRST reason only. Counting all of them says a market failed five rules; the
      // question here is which rule is the binding constraint, and that is the first one
      // that stopped it.
      const reason = String(list[0])
        .replace(/-?\d+(\.\d+)?%?/g, "N")
        .replace(/\(.*?\)/g, "(...)")
        .slice(0, 72);
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(`   ${id}`);
    console.log(`      eligible: ${eligible}   (of which underway: ${runningEligible})`);
    for (const [reason, count] of top) {
      console.log(`      ${String(count).padStart(6)}  ${reason}`);
    }
  }
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`probe failed: ${error?.stack || error}`);
  process.exit(1);
});
