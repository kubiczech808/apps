#!/usr/bin/env node
// Read-only. Public GETs against the published state. No keys, no writes, no orders.
//
// Reported, again: "zase se uvolnil kapital pres close at certainity u vice nez jedne
// prilezitosti na 99.9 v jeden moment. tzn. tvoje oprava neni nasazena nebo nefunguje".
//
// Both of those were checked in the source first and neither holds on its face. The fix is
// on the default branch, which is what a scheduled pacer run checks out. There is exactly one
// place that books a certainty close and exactly one place that calls the refresh, and the
// one-per-pass guard sits between them and its result is used.
//
// So the source says it should work, which is precisely the point at which guessing has cost
// this project a dispatch three times already. What the source CANNOT tell me is the scope
// the guard runs at: it holds at most one close per portfolio per pass, and six portfolios
// each closing one on the same pass is six closes in one moment -- every one of them inside
// the rule as written, and none of them inside the rule as the user reads it.
//
// This separates the three, from the closed trades themselves:
//
//   same portfolio, same timestamp  -> the guard is not working
//   different portfolios, same pass -> the guard works per portfolio; the rule has to be global
//   same portfolio, minutes apart   -> the guard works; consecutive passes look like one moment
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
// A pass is minutes long, so closes within this window were plausibly one run.
const PASS_WINDOW_MS = Number(process.env.PROBE_PASS_WINDOW_MS || 180000);

async function json(path) {
  const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const time = (trade) => Date.parse(String(
  trade?.certaintyClosedAt || trade?.closedAt || trade?.resolvedAt || "")) || null;

async function main() {
  console.log(`Certainty burst probe, ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written and no credentials are used.\n");

  const config = await json("api.php?action=portfolio-config");
  const portfolios = Object.entries(config?.config?.paper || {})
    .map(([id, entry]) => ({ id, name: String(entry?.displayName || entry?.label || id), config: entry }));
  if (!portfolios.length) {
    console.log(`No paper portfolios in the config. Keys: ${Object.keys(config?.config || {}).join(", ")}`);
    return;
  }
  console.log(`${portfolios.length} paper portfolio(s) configured.\n`);

  // Every certainty close on record, with which portfolio booked it and when.
  const closes = [];
  for (const portfolio of portfolios) {
    let state;
    try {
      state = await json(`api.php?action=state&target=paper&summary=dashboard`
        + `&strategy_id=${encodeURIComponent(portfolio.id)}&t=${Date.now()}`);
    } catch (error) {
      console.log(`  ${portfolio.id.padEnd(26)} could not read: ${String(error.message).slice(0, 160)}`);
      continue;
    }
    const trades = state?.paperPortfolios?.[portfolio.id]?.trades;
    if (!Array.isArray(trades)) {
      // Printed rather than skipped: a shape that changed is the reason this probe would
      // otherwise report "no certainty closes" from a portfolio full of them.
      console.log(`  ${portfolio.id.padEnd(26)} no trades array;`
        + ` response keys: ${Object.keys(state || {}).join(", ").slice(0, 160)}`);
      continue;
    }
    const mine = trades.filter((trade) => String(trade?.closeReason || "") === "certainty");
    console.log(`  ${portfolio.id.padEnd(26)} ${String(trades.length).padStart(5)} trade(s),`
      + ` ${String(mine.length).padStart(4)} closed at certainty`
      + `  closeAtCertainty=${portfolio.config?.closeAtCertainty ?? "?"}`);
    for (const trade of mine) {
      closes.push({
        portfolio: portfolio.id,
        id: String(trade?.id ?? ""),
        at: time(trade),
        stamped: Boolean(trade?.certaintyClosedAt),
        price: Number(trade?.currentPrice),
        freed: Number(trade?.currentValueUsdc),
        question: String(trade?.question || trade?.slug || "?"),
      });
    }
  }

  const dated = closes.filter((entry) => entry.at !== null).sort((a, b) => a.at - b.at);
  console.log(`\n== ${closes.length} certainty close(s) on record, ${dated.length} of them dated`);
  const undated = closes.length - dated.length;
  if (undated) {
    // These are invisible to the guard too: it only holds a close that carries the stamp.
    console.log(`   ${undated} carry no timestamp at all, so nothing can group them --`);
    console.log("   and the one-per-pass rule cannot see them either, because it matches on the stamp.");
  }
  const unstamped = closes.filter((entry) => !entry.stamped).length;
  if (unstamped) {
    console.log(`   ${unstamped} carry no certaintyClosedAt. The guard ignores those by design`);
    console.log("   (they were booked before the stamp existed), so old rows are not evidence.");
  }

  // Group by pass window, and report only the bursts.
  const bursts = [];
  let current = [];
  for (const entry of dated) {
    if (current.length && entry.at - current[current.length - 1].at > PASS_WINDOW_MS) {
      if (current.length > 1) bursts.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length > 1) bursts.push(current);

  console.log(`\n== closes that landed within ${PASS_WINDOW_MS / 1000}s of each other`);
  if (!bursts.length) {
    console.log("   none. Every certainty close on record stands alone in its window,");
    console.log("   which is the rule working.");
    return;
  }
  for (const burst of bursts.slice(-8)) {
    const span = (burst[burst.length - 1].at - burst[0].at) / 1000;
    const byPortfolio = new Map();
    for (const entry of burst) byPortfolio.set(entry.portfolio, (byPortfolio.get(entry.portfolio) || 0) + 1);
    const worst = Math.max(...byPortfolio.values());
    console.log(`\n   ${new Date(burst[0].at).toISOString()}  ${burst.length} close(s) over ${span.toFixed(0)}s`);
    console.log(`      per portfolio: ${[...byPortfolio].map(([k, v]) => `${k}=${v}`).join(", ")}`);
    for (const entry of burst) {
      console.log(`      ${new Date(entry.at).toISOString()}  ${entry.portfolio.padEnd(24)}`
        + ` ${Number.isFinite(entry.price) ? entry.price.toFixed(4) : "?"}`
        + ` $${Number.isFinite(entry.freed) ? entry.freed.toFixed(2) : "?"}`
        + `  ${entry.stamped ? "stamped" : "UNSTAMPED"}  ${entry.question.slice(0, 44)}`);
    }
    // The verdict, per burst, rather than one summary that averages the two cases away.
    if (worst > 1) {
      console.log(`      VERDICT: one portfolio closed ${worst} positions inside a single window.`);
      console.log("      That is the guard failing, or these closes were booked on separate passes.");
    } else {
      console.log("      VERDICT: one close per portfolio. The guard held; the rule is per portfolio,");
      console.log("      and several portfolios hitting it at once still looks like a burst.");
    }
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
