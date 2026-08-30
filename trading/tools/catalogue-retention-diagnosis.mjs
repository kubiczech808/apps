// Read-only diagnostic. Writes nothing, publishes nothing.
//
// Reported: the scraped list's status filter shows 5000 and does not move, not even
// straight after a scan. 5000 is also exactly PAPER_MARKET_OBSERVATION_RETAIN_LIMIT, which
// caps the ACTIVE catalogue -- so the question is whether the number is pinned because the
// cap is binding, and if so what is being evicted to hold it there.
//
// Three things need separating, and the owner asked for all three:
//   1. Is intake limited? The keyset cursor is what pulls from Gamma; the cap is retention.
//      If scans keep reporting new rows while the total stays flat, intake is fine and
//      eviction is cancelling it exactly.
//   2. Are earlier scraped events being lost? Resolved rows are retained without limit;
//      active ones are sorted and truncated. What falls off the end is the answer.
//   3. Should the number grow with new scrapes and shrink as markets resolve? It cannot do
//      either while it is pinned to a constant.
//
// The eviction order matters as much as the count. retainMarketObservations() sorts active
// rows with future end dates first, nearest first, and everything past-dated or undated
// last -- so the first rows evicted are exactly the past-dated-but-still-tradable ones the
// candidate list was recently changed to keep.
const SCRAPED_STATE_URL = process.env.PAPER_SCRAPED_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=execution";
const DASHBOARD_STATE_URL = process.env.PAPER_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=dashboard";
const RETAIN_LIMIT = Number(process.env.PAPER_MARKET_OBSERVATION_RETAIN_LIMIT || 5000);

const num = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

async function measure(url, label) {
  const started = Date.now();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  const text = await response.text();
  return {
    ms: Date.now() - started,
    bytes: Buffer.byteLength(text, "utf8"),
    json: JSON.parse(text),
  };
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

async function main() {
  console.log(`Catalogue retention diagnosis at ${new Date().toISOString()}`);
  console.log(`configured active retain limit: ${RETAIN_LIMIT}\n`);

  const scraped = await measure(SCRAPED_STATE_URL, "scraped state");
  const totals = scraped.json?.observationTotals || {};
  const rows = Array.isArray(scraped.json?.marketObservations) ? scraped.json.marketObservations : [];

  console.log("1. WHAT THE FILTER IS READING");
  console.log(`   observationTotals.scraped   ${num(totals.scraped ?? totals.active)}`);
  console.log(`   observationTotals.resolved  ${num(totals.resolved)}`);
  console.log(`   observationTotals.all       ${num(totals.all)}`);
  console.log(`   rows actually in this response ${rows.length}`
    + `${rows.length < num(totals.scraped ?? totals.active, 0) ? "  (response is truncated; the filter uses the totals, not this)" : ""}`);
  const activeTotal = num(totals.scraped ?? totals.active, 0);
  console.log(`   -> ${activeTotal === RETAIN_LIMIT
    ? `PINNED: the active total is exactly the retain limit, so every scan is evicting to hold it there.`
    : `not at the limit (${activeTotal} of ${RETAIN_LIMIT}); the cap is not what is holding the number.`}`);

  console.log(`\n2. WHAT THE ENDPOINTS COST AT THIS VOLUME`);
  console.log(`   scraped summary   ${mb(scraped.bytes)} in ${scraped.ms} ms`);
  const dashboard = await measure(DASHBOARD_STATE_URL, "dashboard state").catch((error) => ({ error }));
  if (dashboard.error) console.log(`   dashboard summary  failed: ${dashboard.error.message}`);
  else console.log(`   dashboard summary ${mb(dashboard.bytes)} in ${dashboard.ms} ms`);
  console.log(`   -> the cap exists to keep these inside the host's limit. Raising it is only`);
  console.log(`      safe in proportion to what one response actually carries.`);

  // 3. Intake versus eviction, from the scans' own before/after counts.
  const history = Array.isArray(scraped.json?.marketScan?.history)
    ? scraped.json.marketScan.history
    : (Array.isArray(scraped.json?.marketScanHistory) ? scraped.json.marketScanHistory : []);
  console.log(`\n3. INTAKE VERSUS EVICTION, PER SCAN`);
  if (!history.length) {
    console.log(`   no scan history in this response`);
  } else {
    console.log(`   ${"when".padEnd(22)} ${"seen".padStart(6)} ${"stored".padStart(7)} ${"before".padStart(7)} ${"after".padStart(7)} ${"net".padStart(6)}`);
    for (const entry of history.slice(0, 12)) {
      const before = num(entry.activeObservationCountBefore);
      const after = num(entry.activeObservationCountAfter);
      const net = num(entry.netObservationCount, before != null && after != null ? after - before : null);
      console.log(`   ${String(entry.completedAt || entry.startedAt || "-").slice(0, 22).padEnd(22)}`
        + ` ${String(num(entry.marketsSeen ?? entry.seen, "-")).padStart(6)}`
        + ` ${String(num(entry.storedCount ?? entry.stored, "-")).padStart(7)}`
        + ` ${String(before ?? "-").padStart(7)}`
        + ` ${String(after ?? "-").padStart(7)}`
        + ` ${String(net ?? "-").padStart(6)}`);
    }
    console.log(`   -> a run that stores rows while net stays ~0 is intake working and eviction`);
    console.log(`      cancelling it exactly. That is the number refusing to move.`);
  }

  // 4. What the eviction order would drop first, measured on the rows that are here.
  // retainMarketObservations puts future-dated rows first (nearest first) and everything
  // past-dated or undated last, so the tail of that order is what falls off the end.
  console.log(`\n4. WHAT THE EVICTION ORDER SACRIFICES FIRST`);
  const now = Date.now();
  let future = 0;
  let past = 0;
  let undated = 0;
  for (const row of rows) {
    const end = Date.parse(row?.endDate || "");
    if (!Number.isFinite(end)) undated += 1;
    else if (end >= now) future += 1;
    else past += 1;
  }
  console.log(`   of the ${rows.length} rows in this response: ${future} future-dated, ${past} past-dated, ${undated} undated`);
  console.log(`   -> past-dated and undated rows sort LAST and are evicted first. Those are the`);
  console.log(`      same rows the candidate list was changed to keep until the exchange`);
  console.log(`      confirms resolution, so the cap and that rule pull against each other.`);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
