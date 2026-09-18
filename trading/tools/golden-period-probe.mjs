#!/usr/bin/env node
// Read-only. Public GETs against the published state and the portfolio's own history. No
// keys, no writes, no orders.
//
// Asked: "chci abys prozkoumal, co se delo na portfoliu '70-80 esports' ve dnech cca 10.9. -
// 12.9. jinak resp. lepe, ze jsme byli schopni behem par dni takovou rychlosti navysovat
// kapital. nastaveni portfolia mi prijde v podstate stejne ... muj dojem je, ze se darilo
// otevirat vice pozici za stejne dlouhou dobu a mnohem vice z nich bylo bez ztraty a byli
// jsme je schopni otevrit na pravdepodobnostech, ktere nam dodali vysokou vyhru. dnes je
// problem, ze mame malo prilezitosti a kdyz uz se objevi, nechytneme je pri pravdepodobnosti
// lehce nad 70% ... ale mozna je za tim i neco technickeho."
//
// The cadence half is already measured and does NOT explain it: the live execution workflow
// ran 185 successful passes on 12.9. and 233 on 14.9., and the market scan 145 and 143. The
// pipeline was not running more often during the good days. So this measures the trades.
//
// Four questions, each answered per DAY so the shape over time is visible rather than two
// averages that can be made to say anything:
//
//   1. how many positions were opened, and how many closed
//   2. at what probability they were ENTERED -- the user's specific claim
//   3. how many closed without a loss
//   4. what the money did
//
// Plus the two things that would explain a change without anyone choosing it: what the
// portfolio's configuration actually did (from its own change history, not from memory) and
// how many candidates each run saw.
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const WANT = process.env.PROBE_PORTFOLIO || "70-80 esports";

async function get(path) {
  const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const day = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
};
const money = (value) => `${value < 0 ? "-" : "+"}$${Math.abs(value).toFixed(2)}`;

// The probability the position was ENTERED at. Deliberately not daysToResolution's neighbour
// marketProbability, which the bot RE-STAMPS on every mark of an open position: on a closed
// trade that field holds the last mark, which for a resolved market is near 0 or 1 and would
// show every trade as entered at a certainty it never had.
function entryProbability(trade) {
  for (const field of ["entryProbability", "openProbability", "probabilityAtEntry",
    "firstMarketProbability", "entryPrice", "avgPrice", "averagePrice", "price"]) {
    const value = num(trade[field]);
    if (value != null && value > 0 && value <= 1) return value;
  }
  // A cost-per-share derivation, for rows that carry only the money.
  const cost = num(trade.totalCostUsdc) ?? num(trade.stakeUsdc);
  const shares = num(trade.shares) ?? num(trade.size) ?? num(trade.quantity);
  if (cost != null && shares != null && shares > 0) {
    const derived = cost / shares;
    if (derived > 0 && derived <= 1) return derived;
  }
  return null;
}

const isClosed = (trade) => {
  const status = String(trade.status || "").toUpperCase();
  return status !== "OPEN" && status !== "LIMIT_ORDER_WAITING" && Boolean(trade.resolvedAt || trade.closedAt);
};
const closedDay = (trade) => day(trade.resolvedAt || trade.closedAt);
const openedDay = (trade) => day(trade.openedAt || trade.date);

function findTrades(state) {
  // The live state's shape has been guessed wrong twice, so it is searched rather than
  // addressed: every array anywhere in it whose members look like trades.
  const found = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 6) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const looksLikeTrades = node.length > 0 && node.every((item) => item && typeof item === "object"
        && (item.openedAt != null || item.status != null)
        && (item.tokenId != null || item.marketId != null || item.question != null));
      if (looksLikeTrades) found.push(node);
      for (const item of node.slice(0, 60)) walk(item, depth + 1);
      return;
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };
  walk(state, 0);
  // De-duplicated on the trade's own identity: the same array can be reached by two paths.
  const byKey = new Map();
  for (const row of found.flat()) {
    byKey.set(`${row.tokenId ?? ""}|${row.openedAt ?? ""}|${row.id ?? ""}`, row);
  }
  return [...byKey.values()];
}

function daily(trades) {
  const rows = new Map();
  const row = (date) => {
    if (!rows.has(date)) {
      rows.set(date, { date, opened: 0, closed: 0, noLoss: 0, pnl: 0, staked: 0, probs: [] });
    }
    return rows.get(date);
  };
  for (const trade of trades) {
    const open = openedDay(trade);
    if (open) {
      const entry = row(open);
      entry.opened += 1;
      const probability = entryProbability(trade);
      if (probability != null) entry.probs.push(probability);
    }
    if (isClosed(trade)) {
      const close = closedDay(trade);
      if (close) {
        const entry = row(close);
        entry.closed += 1;
        const pnl = num(trade.realizedPnlUsdc) ?? 0;
        entry.pnl += pnl;
        entry.staked += num(trade.totalCostUsdc) ?? num(trade.stakeUsdc) ?? 0;
        // "bez ztraty" -- not the same as a win: a break-even close is what the certainty
        // exit produces and the user counted those on the good side.
        if (pnl >= -0.005) entry.noLoss += 1;
      }
    }
  }
  return [...rows.values()].sort((left, right) => left.date.localeCompare(right.date));
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

async function main() {
  console.log(`Golden period probe, ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written and no credentials are used.\n");

  const config = await get("api.php?action=portfolio-config");
  const body = config?.config || {};
  const named = [];
  for (const [id, entry] of Object.entries(body.livePortfolios || {})) {
    named.push({ id, name: String(entry?.displayName || entry?.label || id), live: true, config: entry });
  }
  for (const [id, entry] of Object.entries(body.paper || {})) {
    named.push({ id, name: String(entry?.displayName || entry?.label || id), live: false, config: entry });
  }
  const want = WANT.toLowerCase();
  const match = named.find((entry) => entry.name.toLowerCase().includes(want)
    || entry.id.toLowerCase().includes(want));
  if (!match) {
    console.log(`No portfolio matching "${WANT}". Configured:`);
    for (const entry of named) console.log(`   ${entry.live ? "live " : "paper"} ${entry.id.padEnd(26)} ${entry.name}`);
    return;
  }
  console.log(`Portfolio: ${match.name} (${match.live ? "live" : "paper"}, id=${match.id})\n`);

  // 1. What the configuration says TODAY, in the terms the question is about.
  const cfg = match.config || {};
  console.log("== the parameters the question is about, as they stand now");
  for (const field of ["minProbability", "maxProbability", "stakeUsdc", "maxResolutionDays",
    "minLiquidityUsdc", "selectionOrder", "dipEntryEnabled", "dipEntryMinDrop",
    "stopLossMultiplier", "closeAtCertainty", "includedTags", "excludedTags",
    "excludedMarketShapes", "maxOpenPositions", "maxOrderFraction"]) {
    if (cfg[field] !== undefined) {
      console.log(`   ${field.padEnd(22)} ${JSON.stringify(cfg[field])}`);
    }
  }

  // 2. What it USED to say. The user's own read is "nastaveni portfolia mi prijde v podstate
  //    stejne", and the change history is the only thing that can confirm or refute it.
  console.log("\n== what actually changed, from the portfolio's own change history");
  try {
    const history = await get(`api.php?action=portfolio-config-history&strategy_id=${encodeURIComponent(match.id)}`);
    const entries = history?.history || history?.entries || history?.records || [];
    if (!entries.length) {
      console.log("   no recorded changes for this portfolio");
    }
    for (const entry of entries.slice(0, 40)) {
      const when = String(entry.changedAt || entry.at || "").slice(0, 16).replace("T", " ");
      for (const change of entry.changes || []) {
        const field = change.field ?? change.key ?? "?";
        console.log(`   ${when}  ${String(field).padEnd(24)} ${JSON.stringify(change.from ?? change.before)}`
          + ` -> ${JSON.stringify(change.to ?? change.after)}`);
      }
    }
  } catch (error) {
    console.log(`   could not read: ${error.message}`);
  }

  // 3. The trades, per day.
  const state = await get(`api.php?action=state&target=${match.live ? "live" : "paper"}`);
  let trades = findTrades(state);
  if (match.live) {
    const aliases = new Set([match.id, `live-${match.id}`, `live-custom-${match.id}`, `custom-${match.id}`]);
    const mine = trades.filter((trade) => aliases.has(String(trade.portfolioId ?? ""))
      || aliases.has(String(trade.strategyId ?? "")));
    const attribution = new Map();
    for (const trade of trades) {
      const key = String(trade.portfolioId ?? trade.strategyId ?? "(none)");
      attribution.set(key, (attribution.get(key) || 0) + 1);
    }
    console.log(`\n   live trades found: ${trades.length}; attributed to `
      + [...attribution].map(([key, count]) => `${key}=${count}`).join(", "));
    // Every row came back with no portfolioId, so the numbers below are the whole live
    // account rather than this portfolio. Printing the fields a trade actually carries is
    // how that gets fixed rather than re-guessed -- and it is task 21's question too.
    if (trades.length && !attribution.has(match.id)) {
      console.log(`   fields on a live trade: ${Object.keys(trades[0]).join(", ")}`);
    }
    if (mine.length) {
      trades = mine;
    } else {
      console.log(`   nothing matched ${[...aliases].join(" / ")} -- reporting ALL live trades`);
    }
  }

  const rows = daily(trades);
  console.log(`\n== per day (${trades.length} trades in the published state)`);
  console.log("   day          opened  closed  no-loss   rate   median entry     staked        P/L      return");
  for (const row of rows) {
    const rate = row.closed ? (row.noLoss / row.closed) * 100 : 0;
    const entry = median(row.probs);
    const ret = row.staked > 0 ? (row.pnl / row.staked) * 100 : 0;
    console.log(`   ${row.date}${String(row.opened).padStart(8)}${String(row.closed).padStart(8)}`
      + `${String(row.noLoss).padStart(9)}${`${rate.toFixed(0)}%`.padStart(7)}`
      + `${(entry == null ? "-" : `${(entry * 100).toFixed(1)}%`).padStart(15)}`
      + `${`$${row.staked.toFixed(2)}`.padStart(11)}${money(row.pnl).padStart(11)}`
      + `${`${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%`.padStart(12)}`);
  }

  // 4. The two windows, side by side, on the same numbers.
  const window = (from, to, label) => {
    const inside = rows.filter((row) => row.date >= from && row.date <= to);
    const opened = inside.reduce((sum, row) => sum + row.opened, 0);
    const closed = inside.reduce((sum, row) => sum + row.closed, 0);
    const noLoss = inside.reduce((sum, row) => sum + row.noLoss, 0);
    const pnl = inside.reduce((sum, row) => sum + row.pnl, 0);
    const staked = inside.reduce((sum, row) => sum + row.staked, 0);
    const probs = inside.flatMap((row) => row.probs);
    const days = inside.length || 1;
    console.log(`   ${label.padEnd(22)}${(opened / days).toFixed(1).padStart(7)}`
      + `${(closed / days).toFixed(1).padStart(8)}`
      + `${(closed ? `${((noLoss / closed) * 100).toFixed(0)}%` : "-").padStart(9)}`
      + `${(median(probs) == null ? "-" : `${(median(probs) * 100).toFixed(1)}%`).padStart(15)}`
      + `${money(pnl).padStart(11)}`
      + `${(staked > 0 ? `${((pnl / staked) * 100).toFixed(1)}%` : "-").padStart(10)}`);
  };
  console.log("\n== the two windows, per day averages");
  console.log("   window                opened/d closed/d  no-loss   median entry        P/L    return");
  window("2026-09-09", "2026-09-12", "the good days");
  window("2026-09-15", "2026-09-19", "the last few days");

  // 5. Opportunity: what each run actually SAW. "dnes je problem, ze mame malo prilezitosti"
  //    is a claim about candidates, and candidates are recorded per run.
  console.log("\n== what each run saw (candidates, per day)");
  try {
    // `records` is the key the endpoint actually uses. The first version looked for `runs`
    // and reported "no run log rows", which cost a dispatch -- so the shape is now PRINTED
    // rather than guessed, and stays printed.
    const log = await get(`api.php?action=portfolio-run-log&strategy_id=${encodeURIComponent(match.id)}&page_size=500`);
    const runs = log?.records || log?.runs || log?.entries || [];
    console.log(`   ${runs.length} run-log rows of ${log?.total ?? "?"} (page size ${log?.pageSize ?? "?"})`);
    if (runs.length) {
      console.log(`   fields on a row: ${Object.keys(runs[0]).join(", ")}`);
    }
    const byDay = new Map();
    for (const run of runs) {
      const date = day(run.runAt || run.at);
      if (!date) continue;
      if (!byDay.has(date)) byDay.set(date, { runs: 0, candidates: 0, evaluated: 0, opened: 0, skips: new Map() });
      const bucket = byDay.get(date);
      bucket.runs += 1;
      bucket.candidates += num(run.candidateCount) ?? num(run.candidates) ?? 0;
      bucket.evaluated += num(run.evaluatedCount) ?? num(run.evaluated) ?? 0;
      bucket.opened += num(run.openedCount) ?? num(run.opened) ?? 0;
      for (const reason of run.skipReasons || run.reasons || []) {
        const key = String(reason?.reason ?? reason ?? "");
        const count = num(reason?.count) ?? 1;
        bucket.skips.set(key, (bucket.skips.get(key) || 0) + count);
      }
    }
    if (!byDay.size) console.log(`   no run log rows (keys seen: ${Object.keys(log || {}).join(", ")})`);
    console.log("   day           runs  candidates  evaluated  opened   top skip reasons");
    for (const [date, bucket] of [...byDay].sort()) {
      const top = [...bucket.skips].sort((left, right) => right[1] - left[1]).slice(0, 3)
        .map(([reason, count]) => `${reason}=${count}`).join(", ");
      console.log(`   ${date}${String(bucket.runs).padStart(7)}${String(bucket.candidates).padStart(12)}`
        + `${String(bucket.evaluated).padStart(11)}${String(bucket.opened).padStart(8)}   ${top}`);
    }
  } catch (error) {
    console.log(`   could not read the run log: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
