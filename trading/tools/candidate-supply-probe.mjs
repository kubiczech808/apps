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
    const pct = (value) => (value == null ? "-" : `${(Number(value) * 100).toFixed(0)}%`);
    console.log(`   ${id}`);
    // The settings themselves, because a recommendation has to name the number to change
    // and "the band is too narrow" is not actionable without knowing what it currently is.
    console.log(`      band ${pct(strategy.minProbability)}-${pct(strategy.maxProbability)}`
      + `  volume>=${Math.round(Number(strategy.minLiquidityUsdc) || 0)}`
      + `  window ${Math.round(Number(strategy.maxResolutionHours) || 0)}h`
      + `  live=${strategy.liveEventMode || "-"}`
      + `  tags=${[...(strategy.includeOnlyMarketTags || [])].join("|") || "any"}`);
    console.log(`      eligible: ${eligible}   (of which underway: ${runningEligible})`);
    for (const [reason, count] of top) {
      console.log(`      ${String(count).padStart(6)}  ${reason}`);
    }
  }

  // ---- where the in-play markets actually sit ------------------------------------------
  //
  // The claim under test is that the movement, and so the opportunity, is in events already
  // underway. The rows are there and they are fresh, so if a portfolio aimed at them still
  // finds nothing, the band it is aiming with is pointed somewhere the markets are not.
  // This says where they ARE, so a band can be chosen from the data rather than guessed.
  console.log(`\n== where the ${running.length} underway markets are priced`);
  const probabilityOf = (row) => {
    const value = Number(row?.marketProbability ?? row?.marketPrice);
    return Number.isFinite(value) && value > 0 && value < 1 ? value : null;
  };
  const buckets = new Map();
  let unpriced = 0;
  for (const row of running) {
    const probability = probabilityOf(row);
    if (probability == null) {
      unpriced += 1;
      continue;
    }
    const floor = Math.min(0.95, Math.floor(probability * 20) / 20);
    buckets.set(floor, (buckets.get(floor) || 0) + 1);
  }
  for (const [floor, count] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const bar = "#".repeat(Math.min(60, Math.round(count / 3)));
    console.log(`   ${(floor * 100).toFixed(0).padStart(3)}-${((floor + 0.05) * 100).toFixed(0).padStart(3)}%  ${String(count).padStart(4)}  ${bar}`);
  }
  if (unpriced) console.log(`   (${unpriced} underway rows carry no usable probability)`);

  // ---- what a different band would actually buy ----------------------------------------
  //
  // Measured with the real chain and only the band swapped, so every other rule the
  // portfolio has still applies. Guessing "a wider band gives more" is not the question --
  // the question is how many MORE, once volume, spread, tags and the in-play rule have all
  // had their say too.
  const BANDS = [[0.5, 0.99], [0.55, 0.95], [0.6, 0.95], [0.6, 0.9], [0.65, 0.9], [0.7, 0.8], [0.7, 0.9], [0.8, 0.97]];
  const sample = ids.filter((id) => {
    const strategy = strategies[id];
    return (strategy.liveEventMode === "only") || /underway|newportfolio5|moreProbable/i.test(id);
  });
  console.log(`\n== what changing ONLY the band would give these portfolios`);
  console.log("   every other rule of theirs still applies\n");
  for (const id of sample) {
    const strategy = strategies[id];
    const counts = BANDS.map(([lo, hi]) => {
      const tuned = { ...strategy, minProbability: lo, maxProbability: hi };
      let eligible = 0;
      for (const row of rows) {
        const result = bot.portfolioFilterResult(row, tuned);
        if (!(Array.isArray(result?.reasons) ? result.reasons : []).length) eligible += 1;
      }
      return `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}: ${eligible}`;
    });
    console.log(`   ${id}`);
    console.log(`      ${counts.join("   ")}`);
  }

  // ---- the two numbers on the Scraped tab --------------------------------------------
  //
  // Reported with two screenshots: the catalogue overview says Esports 1,370 and the list
  // that number links to holds 287. They count different populations -- the catalogue, and
  // the rows a portfolio could actually enter -- and the difference is the honest answer to
  // "are we missing tradable opportunities". Asked per tag, because the fix differs: a
  // market that never carried a quote is a gap in what the scan SAVES, and one quoting a
  // book wider than the ceiling has no counterparty and never will.
  const tagCounts = new Map();
  for (const row of rows) {
    const labels = Array.isArray(row?.firstPolymarketTags) && row.firstPolymarketTags.length
      ? row.firstPolymarketTags
      : (Array.isArray(row?.polymarketTags) ? row.polymarketTags : []);
    for (const raw of labels) {
      const label = String(typeof raw === "object" ? (raw?.slug || raw?.label || raw?.name || "") : raw)
        .trim().toLowerCase();
      if (!label || label.length > 60) continue;
      tagCounts.set(label, (tagCounts.get(label) || 0) + 1);
    }
  }
  const wanted = (process.env.PROBE_TAGS || "").split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const tags = wanted.length
    ? wanted
    : [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label]) => label);
  console.log(`\n== per tag: in the catalogue vs actually enterable`);
  console.log("   asked of the endpoint the dashboard's tag list uses, so these are the two");
  console.log("   numbers a reader sees on screen, with the difference itemised\n");
  console.log("   tag                       catalogue  enterable   no quote  no spread  too wide   status");
  for (const tag of tags) {
    let payload = null;
    try {
      payload = await get(`api.php?action=taxonomy-observations&kind=tag&value=${encodeURIComponent(tag)}`
        + `&statuses=SCRAPED&probability=0&limit=1`);
    } catch (error) {
      console.log(`   ${tag.padEnd(24)} could not be read: ${error.message}`);
      continue;
    }
    if (payload?.carryingTag === undefined) {
      console.log(`   ${tag.padEnd(24)} the hosting is running an api.php without the breakdown yet`);
      continue;
    }
    const skipped = payload.skipped || {};
    const cell = (value) => String(value ?? 0).padStart(9);
    console.log(`   ${tag.padEnd(24)} ${cell(payload.carryingTag)}  ${cell(payload.matched)}`
      + `  ${cell(skipped.noLiveQuote)}  ${cell(skipped.noRecordedSpread)}`
      + `  ${cell(skipped.spreadWiderThanCeiling)}  ${cell(skipped.otherStatus)}`);
  }
  console.log("\n   no quote  -> the row never carried a live price. Nothing can evaluate it, and");
  console.log("               it is a gap in what the scan saves rather than a market to skip.");
  console.log("   too wide  -> there is no counterparty at a tradable distance. Collecting more");
  console.log("               data will not change it; only a wider ceiling would, and that");
  console.log("               buys fills at prices the portfolio did not agree to.");
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`probe failed: ${error?.stack || error}`);
  process.exit(1);
});
