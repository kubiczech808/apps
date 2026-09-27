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
    const entry = num(row.probability ?? row.entry ?? row.floor);
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

async function main() {
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

export { ask, describe };
