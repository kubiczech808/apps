// Read-only, and deliberately thin: it asks api.php's own resolved-tag-probability-analysis
// for one tag and prints what comes back. No analysis of its own.
//
// Why thin. The previous tool in this directory pulled the whole resolved archive over HTTP
// and folded it in memory, which is the thing api.php's comment on this endpoint warns
// against -- "one tag analysis must stay a small database query, not another scan of the
// full resolved archive" -- and which exhausted the host's 512 MB PHP limit on a live
// request. This endpoint reads already-folded cells from MySQL and only falls back to
// scanning when the database is unavailable, so the response carries statsSource and this
// prints it: a 'stored' answer is the cheap path, an 'archive' answer means the heavy scan
// ran after all and should not be repeated.
//
// It also asks for several tags in one go, because "is it tha or tha1" is answered by which
// of them the fold actually holds.

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const TAGS = String(process.env.MARKET_TAGS || "tha,tha1")
  .split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
const SHAPE = String(process.env.MARKET_SHAPE || "*").trim() || "*";
const MODE = String(process.env.ANALYSIS_MODE || "threshold").trim() || "threshold";

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pct = (value) => (value == null ? "   -  " : `${(value * 100).toFixed(1)}%`.padStart(6));
const money = (value) => (value == null ? "     -" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`.padStart(8));

async function ask(tag) {
  const url = `${HOST}/api.php?action=resolved-tag-probability-analysis`
    + `&tag=${encodeURIComponent(tag)}&shape=${encodeURIComponent(SHAPE)}&mode=${encodeURIComponent(MODE)}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, body: text.slice(0, 300) };
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, status: response.status, body: text.slice(0, 300) };
  }
}

// Printed from whatever keys the response actually carries rather than from an assumed
// shape. Three interface mismatches in this session went unnoticed because a tool assumed
// what it would be handed and reported the resulting emptiness as a finding.
function describe(payload) {
  const keys = Object.keys(payload || {});
  console.log(`      response keys: ${keys.join(", ") || "(none)"}`);
  for (const field of ["ok", "error", "reason", "statsSource", "source", "count", "tag", "shape", "mode"]) {
    if (payload?.[field] !== undefined) console.log(`      ${field}: ${JSON.stringify(payload[field])}`);
  }
  const rows = ["rows", "points", "thresholds", "byProbability", "analysis"]
    .map((field) => [field, payload?.[field]])
    .find(([, value]) => Array.isArray(value) && value.length);
  if (!rows) {
    console.log("      no row array found in the response; printing it whole so the shape is visible:");
    console.log(`      ${JSON.stringify(payload).slice(0, 1200)}`);
    return;
  }
  const [field, list] = rows;
  console.log(`      ${list.length} row(s) under "${field}":`);
  console.log("      entry     n   won    win%        P/L    per $");
  for (const row of list) {
    // minimumProbability is what resolved-tag-probability-analysis calls it. Reading only the
    // combinations endpoint's name printed a column of dashes over rows that had the number.
    const entry = num(row.minimumProbability ?? row.probability ?? row.entry ?? row.floor);
    const n = num(row.trades ?? row.count ?? row.n);
    const wins = num(row.wins ?? row.won);
    const pnl = num(row.pnlUsdc ?? row.pnl ?? row.profitUsdc);
    const staked = num(row.stakedUsdc ?? row.costUsdc);
    console.log(`      ${entry == null ? "   -" : String(entry).padStart(4)}%`
      + ` ${n == null ? "   -" : String(n).padStart(5)}`
      + ` ${wins == null ? "   -" : String(wins).padStart(5)}`
      + `  ${pct(n && wins != null ? wins / n : null)}`
      + ` ${money(pnl)}`
      + `  ${pct(pnl != null && staked ? pnl / staked : null)}`);
  }
}

// The ranked rows live under "best" -- NOT under "combinations", which is an integer count
// of them. Reading the count as if it were the list is how the first run of this printed
// "no rows" against a response that carried 21,535 of them, which is the same class of
// mistake as the three interface mismatches above: assuming the shape instead of reading it.
export function rankedRows(payload) {
  for (const field of ["best", "rows", "results"]) {
    if (Array.isArray(payload?.[field])) return payload[field];
  }
  return [];
}

// One row per tag, ranked by nominal profit.
//
// The endpoint ranks by return per dollar and emits every (tag, shape, horizon, threshold)
// combination, so one tag appears many times over. Asked for profitability by tag, the
// useful reduction is the best-earning setup each tag reached -- and ranked by the nominal
// figure, because that is the half of the answer that was asked for. What the ordering
// cannot fix is that the slice was cut by return: a high-volume tag with a modest edge can
// miss the slice entirely, so the caveat travels with the table.
export function byTag(rows) {
  const best = new Map();
  for (const row of rows) {
    const tag = String(row?.tag ?? "");
    if (!tag || tag === "*") continue;
    const pnl = num(row.pnlUsdc);
    if (pnl === null) continue;
    const held = best.get(tag);
    if (!held || pnl > num(held.pnlUsdc)) best.set(tag, row);
  }
  return [...best.values()].sort((left, right) => num(right.pnlUsdc) - num(left.pnlUsdc));
}

function printRows(rows, limit) {
  console.log("   tag                      shape         horizon    from    n   win%       P/L    per $");
  for (const row of rows.slice(0, limit)) {
    const n = num(row.trades);
    const wins = num(row.wins);
    const pnl = num(row.pnlUsdc);
    const staked = num(row.stakedUsdc);
    console.log(`   ${String(row.tag ?? "-").slice(0, 24).padEnd(24)}`
      + ` ${String(row.shape ?? "*").slice(0, 13).padEnd(13)}`
      + ` ${String(row.horizon ?? "*").slice(0, 8).padEnd(8)}`
      + ` ${String(row.probability ?? "-").padStart(4)}%`
      + ` ${n == null ? "   -" : String(n).padStart(5)}`
      + `  ${pct(n && wins != null ? wins / n : null)}`
      + ` ${money(pnl)}`
      + `  ${pct(pnl != null && staked ? pnl / staked : null)}`);
  }
}

// The Setup finder's own ranking. Reads the stored fold first and the archive only if no
// fold exists, so it is the cheap path AND the guarded one -- unlike the archive scan this
// tool replaced, which had neither property.
async function combinations() {
  const minTrades = Number(process.env.MIN_TRADES || 30);
  const limit = Number(process.env.RESULT_LIMIT || 400);
  const show = Number(process.env.SHOW_ROWS || 25);
  const url = `${HOST}/api.php?action=resolved-combinations&min_trades=${minTrades}&limit=${limit}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    console.log(`   !! HTTP ${response.status}: ${text.slice(0, 300)}`);
    return;
  }
  let payload;
  try { payload = JSON.parse(text); } catch { console.log(`   !! ${text.slice(0, 300)}`); return; }
  for (const field of ["ok", "statsSource", "foldedAt", "scannedRows", "pricedRows",
    "afterDueRejected", "cells", "combinations", "minTrades", "stakeUsdc"]) {
    if (payload?.[field] !== undefined) console.log(`   ${field}: ${JSON.stringify(payload[field])}`);
  }
  const rows = rankedRows(payload);
  if (!rows.length) {
    console.log(`   no rows: ${JSON.stringify(payload).slice(0, 600)}`);
    return;
  }
  console.log(`\n   ${rows.length} combination(s) in the slice, by return per dollar.`);
  console.log(`\n== best setup per tag, ranked by nominal P/L`);
  printRows(byTag(rows), show);
  console.log(`\n== raw top combinations, as the endpoint ranked them (return per dollar)`);
  printRows(rows, show);
  const worst = Array.isArray(payload?.worst) ? payload.worst : [];
  if (worst.length) {
    console.log(`\n== worst, so the losing end is visible too`);
    printRows(worst, 10);
  }
}

async function main() {
  if (String(process.env.RANK_COMBINATIONS || "").toLowerCase() === "true") {
    console.log(`Setup-finder ranking at ${new Date().toISOString()}`);
    await combinations();
    return;
  }
  console.log(`Tag probability query at ${new Date().toISOString()}`);
  console.log(`   host ${HOST}, shape "${SHAPE}", mode "${MODE}"`);
  console.log("   Asks api.php's own folded analysis. No archive scan here: the endpoint");
  console.log("   reads stored cells, and statsSource below says whether it managed to.\n");
  for (const tag of TAGS) {
    console.log(`== tag "${tag}"`);
    try {
      describe(await ask(tag));
    } catch (error) {
      console.log(`      !! ${error?.message || error}`);
    }
    console.log("");
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Query failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

export { ask, describe, main };
