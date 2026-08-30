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
// summary=scraped is the endpoint the scraped list and its status filter actually read.
// The first version of this pointed at summary=execution, which is the executor's own
// shortlist: it carries no observationTotals at all, so the totals read as null and the
// verdict below was an artefact of asking the wrong endpoint rather than a finding.
const SCRAPED_STATE_URL = process.env.PAPER_SCRAPED_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=scraped";
// The executor's view of the same catalogue, reported alongside it: it is scoped and
// capped separately, and the two numbers being different is worth seeing side by side.
const EXECUTION_STATE_URL = process.env.PAPER_EXECUTION_STATE_URL
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

  const execution = await measure(EXECUTION_STATE_URL, "execution state").catch((error) => ({ error }));
  if (!execution.error) {
    const execRows = Array.isArray(execution.json?.marketObservations) ? execution.json.marketObservations : [];
    console.log(`\n1b. WHAT THE EXECUTOR SEES OF THE SAME CATALOGUE`);
    console.log(`   rows served to the executor   ${execRows.length}`);
    console.log(`   executionScopeTotal           ${num(execution.json?.executionScopeTotal)}`);
    console.log(`   executionScopeTruncated       ${execution.json?.executionScopeTruncated}`);
    console.log(`   -> this is scoped by the portfolio's own rules and capped separately. If it`);
    console.log(`      is far below the active total, the executor is choosing from a subset.`);
  }

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
  // These two counters were published over different populations until this was measured:
  // "before" counted every stored row including the resolved archive, "after" counted the
  // active rows alone, so their difference read as a mass deletion that never happened.
  // Labelled as what they are, and their difference is only meaningful once both sides
  // count the same thing.
  console.log(`\n3. ACTIVE CATALOGUE BEFORE AND AFTER EACH SCAN`);
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
    console.log(`   -> net ~0 with the active total sitting on the cap is eviction cancelling`);
    console.log(`      intake exactly. A large negative net means the two columns are still`);
    console.log(`      counting different populations, not that rows were destroyed.`);
  }

  // 4. THE ONLY QUESTION THAT DECIDES WHETHER THE CAP COSTS ANYTHING.
  //
  // Asked: does the 5000-row cap push aside opportunities that could have been executed?
  // The retention sorts active rows by nearest end date first, so the 5000 kept are the
  // 5000 soonest to resolve and what falls off the end is the far future. A portfolio only
  // trades markets resolving within its own max-resolution-days, so the cap costs an
  // opportunity ONLY if the retained set stops short of that horizon.
  //
  // So: how far out does the retained set actually reach, and how much of it is inside the
  // horizons the portfolios trade? If the furthest retained row is far beyond them, the cap
  // is cutting markets no portfolio would have taken anyway.
  const HORIZONS = [1, 2, 3, 7, 30];
  const now = Date.now();
  const activeRows = rows.filter((row) => String(row?.status || row?.selectionStatus || "").toUpperCase() !== "RESOLVED");
  const days = activeRows
    .map((row) => (Date.parse(row?.endDate || "") - now) / 86400000)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const undated = activeRows.length - days.length;

  console.log(`\n4. DOES THE CAP CUT ANYTHING A PORTFOLIO COULD TRADE?`);
  console.log(`   active rows in this response  ${activeRows.length} (${undated} with no usable end date)`);
  if (days.length) {
    console.log(`   soonest to resolve            ${days[0].toFixed(2)} d`);
    console.log(`   furthest retained             ${days[days.length - 1].toFixed(2)} d   <- the horizon the cap buys`);
    for (const horizon of HORIZONS) {
      const inside = days.filter((value) => value <= horizon).length;
      console.log(`   resolving within ${String(horizon).padStart(2)} day(s)      ${String(inside).padStart(5)}`
        + `${inside < activeRows.length ? "" : "   (every retained row is inside this)"}`);
    }
    const furthest = days[days.length - 1];
    console.log(`   -> the live portfolio trades markets resolving within LIVE_MAX_RESOLUTION_DAYS.`);
    console.log(`      The retained set reaches ${furthest.toFixed(2)} d, so the cap only discards markets`);
    console.log(`      beyond that. It costs an executable opportunity only if a portfolio's`);
    console.log(`      horizon is LONGER than ${furthest.toFixed(2)} d.`);
  }

  // And the second ceiling, which is a different one: what reaches the executor at all.
  if (!execution.error) {
    const execRows = Array.isArray(execution.json?.marketObservations) ? execution.json.marketObservations : [];
    const execDays = execRows
      .map((row) => (Date.parse(row?.endDate || "") - now) / 86400000)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    console.log(`\n5. THE SECOND CEILING: WHAT REACHES THE EXECUTOR`);
    console.log(`   scoped rows available         ${num(execution.json?.executionScopeTotal)}`);
    console.log(`   rows actually served          ${execRows.length}   truncated=${execution.json?.executionScopeTruncated}`);
    if (execDays.length) {
      console.log(`   served horizon                ${execDays[0].toFixed(2)} d .. ${execDays[execDays.length - 1].toFixed(2)} d`);
      for (const horizon of HORIZONS.slice(0, 3)) {
        console.log(`   served, resolving within ${String(horizon).padStart(2)} d   ${String(execDays.filter((v) => v <= horizon).length).padStart(5)}`);
      }
    }
    console.log(`   -> this cut is separate from retention and happens per request. If the served`);
    console.log(`      horizon stops short of a portfolio's max resolution days, candidates inside`);
    console.log(`      that horizon exist in the catalogue and never reach the run.`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
