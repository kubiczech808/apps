// Read-only diagnostic. Writes nothing, places nothing.
//
// Reported: the scraping log says several recent manual runs each found and added
// thousands of new events, but the scraped list still shows about 1200 -- so either the
// rows are not accumulating or the log numbers are wrong.
//
// Three different quantities are involved and the report needs to tell them apart:
//
//   1. what a run PULLED from Gamma            (rawMarketCount)
//   2. what a run RETAINED after the scan's own retention rules (retainedObservationCount)
//      and how many of those were new to the catalogue           (newObservationCount)
//   3. what the catalogue actually HOLDS afterwards  (observationTotals, from the state
//      segment manifest -- the true stored count, not the served page)
//   4. what the scraped list SHOWS, which is a further subset: api.php's
//      is_active_scraped_market_observation() drops anything resolved or closed, anything
//      already past its end date or start time, and -- the big one -- anything priced
//      below 50%.
//
// A stable list count is consistent with all of (1) and (2) being large and honest. It is
// also consistent with the catalogue churning against its retention cap. This tells the
// two apart by reading the stored total, not by inferring it from the page.
const STATE_URL = process.env.PAPER_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=scraped";
// Mirrors MARKET_OBSERVATION_RETAIN_LIMIT in tools/paper-trading-bot.mjs.
const RETAIN_LIMIT = Number(process.env.DIAGNOSIS_RETAIN_LIMIT || 5000);

const int = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const pad = (value, width) => String(value).padStart(width);

// api.php's is_active_scraped_market_observation, port for port, so each clause can be
// counted separately. Order matters: the first matching clause is the one reported.
function inactiveReason(item = {}) {
  const status = String(item?.status ?? item?.selectionStatus ?? "").toUpperCase();
  if (["RESOLVED", "CLOSED", "EXPIRED", "FINALIZED", "SETTLED"].includes(status)) return "resolved/closed status";
  const resolution = String(item?.resolutionStatus ?? "").toUpperCase();
  if (["PENDING_RESULT", "FINAL_PRICE_AVAILABLE", "NOT_ACCEPTING_ORDERS"].includes(resolution)) return "settling";
  const probability = Number(item?.marketProbability ?? 0);
  if (!(probability >= 0.5)) return "priced below 50%";
  if (probability >= 1) return "priced at 100%";
  const scheduled = Date.parse(item?.scheduledEventDate ?? "");
  if (Number.isFinite(scheduled) && scheduled <= Date.now()) return "already started";
  const end = Date.parse(item?.endDate ?? item?.resolutionEndDate ?? "");
  if (Number.isFinite(end) && end <= Date.now()) return "past its end date";
  return null;
}

async function main() {
  console.log(`Scraped accumulation diagnosis at ${new Date().toISOString()}\n`);

  const response = await fetch(STATE_URL);
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  const payload = await response.json();

  const rows = Array.isArray(payload?.marketObservations) ? payload.marketObservations : [];
  const totals = payload?.observationTotals || {};
  console.log(`STORED (state segment manifest -- the real catalogue, not the served page)`);
  console.log(`  active   ${pad(int(totals.active), 7)}`);
  console.log(`  resolved ${pad(int(totals.resolved), 7)}${totals.resolvedTruncated ? "  (served page truncated)" : ""}`);
  console.log(`  all      ${pad(int(totals.all), 7)}`);
  console.log(`\nSERVED in this response: ${rows.length} rows\n`);

  // Is the catalogue pressed against the bot's retention cap? If it is, every run that
  // adds rows also evicts rows, and "thousands added" and "the count does not move" are
  // both true at once.
  const active = int(totals.active);
  if (active >= RETAIN_LIMIT) {
    console.log(`!! active ${active} is at or above the retention cap ${RETAIN_LIMIT}:`);
    console.log(`   the catalogue is CHURNING -- new rows evict old ones and it cannot grow.\n`);
  } else {
    console.log(`active ${active} is below the retention cap ${RETAIN_LIMIT}`
      + ` (${RETAIN_LIMIT - active} spare), so retention is not what is holding the count down.\n`);
  }

  // Why the list is smaller than the stored active count.
  const reasons = {};
  let listed = 0;
  for (const row of rows) {
    const reason = inactiveReason(row);
    if (!reason) listed += 1;
    else reasons[reason] = (reasons[reason] || 0) + 1;
  }
  console.log(`Of the ${rows.length} served rows, the scraped list shows ${listed}.`);
  console.log(`Held back by api.php's active-row rule:`);
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(count, 6)}  ${reason}`);
  }

  // What the scraping log claimed, run by run, next to what the catalogue did.
  const history = Array.isArray(payload?.marketScanHistory) ? payload.marketScanHistory : [];
  console.log(`\nLast ${Math.min(12, history.length)} scan runs, as the log reports them:`);
  console.log(`  ${"run".padEnd(20)} ${"trig".padEnd(7)} ${"pulled".padStart(7)} ${"retained".padStart(9)}`
    + ` ${"new".padStart(7)} ${"updated".padStart(8)}  top reason rows were dropped`);
  for (const run of history.slice(0, 12)) {
    const dropped = run?.notRetainedReasonCounts && typeof run.notRetainedReasonCounts === "object"
      ? Object.entries(run.notRetainedReasonCounts).sort((a, b) => b[1] - a[1])[0]
      : null;
    console.log(`  ${String(run?.runAt || "").slice(0, 19).padEnd(20)}`
      + ` ${String(run?.trigger || "").slice(0, 6).padEnd(7)}`
      + ` ${pad(int(run?.rawMarketCount ?? run?.loadedMarketCount), 7)}`
      + ` ${pad(int(run?.retainedObservationCount), 9)}`
      + ` ${pad(int(run?.newObservationCount), 7)}`
      + ` ${pad(int(run?.updatedObservationCount), 8)}`
      + `  ${dropped ? `${dropped[0]} x${dropped[1]}` : "-"}`);
  }

  // The decisive test for "do rows accumulate at all".
  //
  // Each scan merges what it just pulled into the catalogue it loaded, so if the merge
  // works the stored active rows carry observedAt stamps from MANY past runs: a market
  // seen an hour ago and not seen since keeps its old stamp. If instead every stored row
  // was stamped by the newest one or two runs, the catalogue is being replaced rather
  // than added to, and a large "new" count every run is the symptom, not the cause.
  const stamps = new Map();
  for (const row of rows) {
    if (inactiveReason(row)) continue;
    const stamp = String(row?.observedAt || row?.marketDataUpdatedAt || "").slice(0, 19);
    stamps.set(stamp, (stamps.get(stamp) || 0) + 1);
  }
  const ranked = [...stamps.entries()].sort((a, b) => b[1] - a[1]);
  const listedRows = [...stamps.values()].reduce((total, count) => total + count, 0);
  const newestShare = listedRows ? (ranked[0]?.[1] || 0) / listedRows : 0;
  console.log(`\nobservedAt spread across the ${listedRows} listed rows: ${ranked.length} distinct stamps`);
  for (const [stamp, count] of ranked.slice(0, 6)) {
    console.log(`  ${pad(count, 6)}  ${stamp || "(none)"}`);
  }
  if (newestShare >= 0.9) {
    console.log(`  -> ${(newestShare * 100).toFixed(1)}% of the catalogue carries a single scan's stamp:`);
    console.log(`     the catalogue is being REPLACED each run, not accumulated.`);
  } else {
    console.log(`  -> the catalogue carries stamps from many runs, so rows do survive between scans.`);
  }

  const claimedNew = history.slice(0, 12).reduce((total, run) => total + int(run?.newObservationCount), 0);
  console.log(`\nThe log claims ${claimedNew} rows new to the catalogue across those runs,`
    + ` while it stores ${active} active in total.`);
  console.log(`If ${claimedNew} greatly exceeds the stored total and the cap is not the`
    + ` binding constraint, the "new" count is not counting net additions.`);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
