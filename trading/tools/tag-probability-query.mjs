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

// The tags that answer "which sports tag". Polymarket's own slugs, not a classification of
// our own -- a tag that is not here still appears in the output under "other tags seen", so
// the list narrows the reading without hiding anything.
export const SPORTS_TAGS = new Set([
  "sports", "soccer", "football", "nfl", "ncaaf", "basketball", "nba", "ncaab", "wnba",
  "baseball", "mlb", "hockey", "nhl", "tennis", "golf", "mma", "ufc", "boxing", "cricket",
  "rugby", "f1", "formula-1", "motorsport", "cycling", "olympics", "handball", "volleyball",
  "darts", "snooker", "table-tennis", "badminton", "epl", "laliga", "seriea", "bundesliga",
  "ligue-1", "ucl", "uel", "mls", "dfb-pokal", "efl", "copa-america", "euro", "world-cup",
]);

// What a row's own numbers say its winners were priced at.
//
// Every win returns stake/p and every trade cost stake+fee, so over the winners
// sum(stake/p) = pnl + staked. Dividing the stake by the mean of that gives the mean entry
// price of the trades that won -- and a sample that is not contaminated cannot win far more
// often than its own price says it should. It is the one plausibility check available
// without re-reading the archive, and on this data it is the difference between a setup and
// an artefact: 60 trades at 72c that won 60 times are not a 72% favourite behaving well.
export function impliedWinnerEntry(row, stake = 5) {
  const wins = num(row?.wins);
  const pnl = num(row?.pnlUsdc);
  const staked = num(row?.stakedUsdc);
  if (!wins || pnl == null || staked == null) return null;
  const grossReturned = pnl + staked;
  if (!(grossReturned > 0)) return null;
  return (stake * wins) / grossReturned;
}

// Accuracy minus what the price paid for. Near zero is a fairly priced sample; a large
// positive number is the archive's winner bias, not an edge anybody could have traded.
export function accuracyEdge(row, stake = 5) {
  const entry = impliedWinnerEntry(row, stake);
  const n = num(row?.trades);
  const wins = num(row?.wins);
  if (entry == null || !n || wins == null) return null;
  return (wins / n) - entry;
}

// all - outright - over-under, component by component. Exact, because the three requests are
// the same cells grouped three ways over one fold.
export function subtractShapes(all, parts) {
  if (!all) return null;
  const rest = { trades: num(all.trades) ?? 0, wins: num(all.wins) ?? 0, stakedUsdc: num(all.stakedUsdc) ?? 0, pnlUsdc: num(all.pnlUsdc) ?? 0 };
  for (const part of parts) {
    if (!part) continue;
    rest.trades -= num(part.trades) ?? 0;
    rest.wins -= num(part.wins) ?? 0;
    rest.stakedUsdc -= num(part.stakedUsdc) ?? 0;
    rest.pnlUsdc -= num(part.pnlUsdc) ?? 0;
  }
  if (rest.trades <= 0) return null;
  // A remainder that wins more often than it traded is not a remainder, it is evidence that
  // the three requests did not describe the same sample. The first run of this printed "uel
  // - everything else 134.4%" because the all-shapes row it subtracted from was a
  // shape-specific row that had survived the duplicate collapse. Refusing the row is the
  // only honest output: an impossible number presented as a setup is worse than a gap.
  if (rest.wins < 0 || rest.wins > rest.trades) return null;
  rest.stakedUsdc = Number(rest.stakedUsdc.toFixed(2));
  rest.pnlUsdc = Number(rest.pnlUsdc.toFixed(2));
  return rest;
}

async function askCombinations(params) {
  const url = `${HOST}/api.php?action=resolved-combinations&` + new URLSearchParams(params).toString();
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function sweepLine(label, row, stake) {
  if (!row) return `   ${label.padEnd(34)}      -`;
  const n = num(row.trades);
  const wins = num(row.wins);
  const pnl = num(row.pnlUsdc);
  const staked = num(row.stakedUsdc);
  const edge = accuracyEdge(row, stake);
  const entry = impliedWinnerEntry(row, stake);
  return `   ${label.padEnd(34)}`
    + ` ${String(n ?? "-").padStart(5)}`
    + `  ${pct(n && wins != null ? wins / n : null)}`
    + `  ${pct(entry)}`
    + `  ${edge == null ? "   -  " : `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}`.padStart(6)}`
    + ` ${money(pnl)}`
    + `  ${pct(pnl != null && staked ? pnl / staked : null)}`
    + `  ${edge != null && edge > 0.12 ? "SUSPECT" : ""}`;
}

// One entry rule, every tag, split the three ways that were asked for.
async function sweep() {
  const probability = Number(process.env.PROBABILITY || 70);
  const minTrades = Number(process.env.MIN_TRADES || 20);
  const base = { min_trades: String(minTrades), limit: "400", probability: String(probability), horizon: "*" };
  const byShape = new Map();
  let stake = 5;
  let truncated = false;
  for (const shape of ["*", "outright", "over-under"]) {
    const payload = await askCombinations({ ...base, shape });
    stake = num(payload.stakeUsdc) ?? 5;
    const rows = [...(payload.best || []), ...(payload.worst || [])];
    // Only the horizon rollup: the question is the tag, not when it settles.
    const rollup = new Map();
    for (const row of rows) {
      if (row.horizon !== "*" || row.tag === "*") continue;
      // The row must describe the shape that was asked for. Accepting any shape here is what
      // made the first run print a tag's total as 126 trades while its own over-under leg
      // held 4,556: the duplicate collapse leaves shape-specific rows in the same response,
      // and the first one seen for a tag was not its all-shapes total.
      if (row.shape !== shape) continue;
      if (!rollup.has(row.tag)) rollup.set(row.tag, row);
    }
    byShape.set(shape, rollup);
    if ((num(payload.combinations) ?? 0) > (payload.best?.length || 0) + (payload.worst?.length || 0)) truncated = true;
    console.log(`   shape "${shape}": ${payload.combinations} combination(s) at >=${probability}%,`
      + ` ${rollup.size} tag(s) in the slice, statsSource ${payload.statsSource},`
      + ` sideFlippedRejected ${payload.sideFlippedRejected}`);
  }
  if (truncated) {
    console.log("   !! the ranked slice did not carry every combination; raise min_trades to be sure of coverage");
  }

  const all = byShape.get("*");
  const tags = [...all.keys()].sort((left, right) => (num(all.get(right).pnlUsdc) ?? 0) - (num(all.get(left).pnlUsdc) ?? 0));
  const sports = tags.filter((tag) => SPORTS_TAGS.has(tag));
  const others = tags.filter((tag) => !SPORTS_TAGS.has(tag));

  console.log(`\n   entry rule: >= ${probability}%, any horizon, stake ${stake}`);
  console.log(`   "priced" is what the winners' own prices say; "edge" is win% minus that.`);
  console.log(`   An edge far above zero is the archive's winner bias, not a tradable edge.\n`);
  console.log(`   tag / shape                            n   win%  priced    edge       P/L    per $`);
  const emit = (tag) => {
    const allRow = all.get(tag);
    const outright = byShape.get("outright").get(tag);
    const overUnder = byShape.get("over-under").get(tag);
    const rest = subtractShapes(allRow, [outright, overUnder]);
    console.log(sweepLine(tag, allRow, stake));
    console.log(sweepLine(`   - outright`, outright, stake));
    console.log(`${sweepLine(`   - over/under`, overUnder, stake)}`);
    console.log(sweepLine(`   - everything else`, rest, stake));
  };
  console.log("== sports tags");
  for (const tag of sports) emit(tag);
  console.log("\n== other tags in the same slice, for contrast");
  for (const tag of others.slice(0, 12)) console.log(sweepLine(tag, all.get(tag), stake));
}

// One band, every horizon: "does it matter whether the fixture is already under way".
//
// The horizon is a dimension the nightly fold already keeps, so this is a stored read. Volume
// is NOT -- the fold's cells are (probability, tag, shape, horizon) and nothing else -- so a
// volume split cannot be answered from here at all, only by adding the dimension to the fold.
async function horizons() {
  const tag = String(process.env.MARKET_TAG || "soccer").trim().toLowerCase();
  const shape = String(process.env.MARKET_SHAPE || "*").trim() || "*";
  const floor = Number(process.env.PROBABILITY || 51);
  const ceiling = Number(process.env.CEILING || 72);
  const payload = await askCombinations({
    tag, shape, mode: "band", band_step: "1", min_width: "5",
    probability: String(floor), min_trades: String(Number(process.env.MIN_TRADES || 1)),
    limit: "400", only_open: "false",
  });
  const stake = num(payload.stakeUsdc) ?? 5;
  console.log(`   tag ${tag}, shape ${shape}, band ${floor}-${ceiling}%,`
    + ` statsSource ${payload.statsSource}, ${payload.combinations} combination(s)`);
  const rows = [...(payload.best || []), ...(payload.worst || [])]
    .filter((row) => row.probabilityMin === floor && row.probabilityMax === ceiling);
  if (!rows.length) {
    const seen = [...new Set([...(payload.best || []), ...(payload.worst || [])]
      .map((row) => `${row.probabilityMin}-${row.probabilityMax}`))];
    console.log(`   !! no row for exactly ${floor}-${ceiling}. Bands present: ${seen.slice(0, 20).join(", ")}`);
    return;
  }
  const seen = new Map();
  for (const row of rows) if (!seen.has(row.horizon)) seen.set(row.horizon, row);
  const order = ["*", "under way", "<= 3 h", "<= 6 h", "<= 12 h", "<= 24 h", "<= 48 h", "> 48 h", "unknown"];
  console.log(`\n   horizon                                n   win%  priced    edge       P/L    per $`);
  for (const horizon of order) {
    if (seen.has(horizon)) console.log(sweepLine(horizon === "*" ? "(every horizon)" : horizon, seen.get(horizon), stake));
  }
  for (const [horizon, row] of seen) {
    if (!order.includes(horizon)) console.log(sweepLine(horizon, row, stake));
  }
}

async function main() {
  if (String(process.env.HORIZONS || "").toLowerCase() === "true") {
    console.log(`Horizon breakdown at ${new Date().toISOString()}`);
    await horizons();
    return;
  }
  if (String(process.env.SWEEP || "").toLowerCase() === "true") {
    console.log(`Entry-rule sweep at ${new Date().toISOString()}`);
    await sweep();
    return;
  }
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
