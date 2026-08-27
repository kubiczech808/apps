// Read-only diagnostic. Writes nothing, places nothing.
//
// The companion to market-spread-quality-diagnosis.mjs, which measured Gamma. This one
// measures what actually landed in our own state, and answers three separate questions
// that a single "the statistics went empty" observation cannot tell apart:
//
//   1. Is the scan recording the spread at all? A field that never arrives looks exactly
//      like a gate that rejects everything.
//   2. How much of the stored catalogue does the five-point rule keep, split by whether a
//      row has a recorded spread or predates the field? The second group shrinks on its own
//      as the scan re-covers the catalogue, and that is the number to watch.
//   3. Does the published report's own excluded count agree with recomputing it here? If it
//      does not, the report was built by a pass that was not holding the whole archive.
//
// It also reports the distribution of recorded spreads, because a five-point rule that
// keeps almost nothing of the *quoted* catalogue would be the wrong limit rather than a
// working filter, and that is a distinction worth being able to see.
const STATE_URL = process.env.PAPER_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=scraped";
// The scraped summary carries the catalogue but not the calculation report, and the
// dashboard summary carries the report but not the catalogue. Both are wanted here, so
// both are read.
const REPORT_URL = process.env.PAPER_REPORT_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=paper&summary=dashboard";
const MAX_TRADABLE_SPREAD = Number(process.env.PAPER_MAX_TRADABLE_SPREAD || 0.05);

const num = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const pctOf = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "n/a");

// The same order the bot's own readers use: the statistics judge the discovery-time quote,
// an entry judges the live one. Both are reported, because a catalogue where they disagree
// is a catalogue where the two gates will disagree.
function spreadFrom(item, stated, askKey, bidKey) {
  const value = num(item?.[stated]);
  if (value != null) return Math.abs(value);
  const ask = num(item?.[askKey]);
  const bid = num(item?.[bidKey]);
  return ask != null && bid != null ? Math.abs(ask - bid) : null;
}

const firstSpread = (item) => spreadFrom(item, "firstSpread", "firstBestAsk", "firstBestBid");
const liveSpread = (item) => spreadFrom(item, "spread", "bestAsk", "bestBid");

function distribution(values, label) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) {
    console.log(`   ${label}: none recorded`);
    return;
  }
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const parts = [["p10", 0.1], ["p25", 0.25], ["median", 0.5], ["p75", 0.75], ["p90", 0.9]]
    .map(([name, fraction]) => `${name}=${(at(fraction) * 100).toFixed(1)}`);
  console.log(`   ${label}: n=${sorted.length} ${parts.join(" ")} max=${(sorted[sorted.length - 1] * 100).toFixed(1)} (points)`);
}

async function main() {
  console.log(`Stored spread diagnosis at ${new Date().toISOString()}`);
  console.log(`limit in force: ${(MAX_TRADABLE_SPREAD * 100).toFixed(1)} points\n`);

  const response = await fetch(`${STATE_URL}&t=${Date.now()}`);
  if (!response.ok) {
    console.log(`!! state read failed: HTTP ${response.status}`);
    process.exitCode = 1;
    return;
  }
  const state = await response.json();
  const rows = Array.isArray(state.marketObservations) ? state.marketObservations : [];
  console.log(`read ${rows.length} stored observations from the scraped summary\n`);
  if (!rows.length) return;

  // 1. Is the field arriving at all, and on which rows.
  {
    const withFirst = rows.filter((item) => firstSpread(item) != null);
    const withLive = rows.filter((item) => liveSpread(item) != null);
    const withEither = rows.filter((item) => firstSpread(item) != null || liveSpread(item) != null);
    console.log(`-- is the scan recording it --`);
    console.log(`   firstSpread (or first bid/ask): ${withFirst.length} of ${rows.length} (${pctOf(withFirst.length, rows.length)})`);
    console.log(`   live spread (or live bid/ask)  : ${withLive.length} of ${rows.length} (${pctOf(withLive.length, rows.length)})`);
    console.log(`   either                         : ${withEither.length} of ${rows.length} (${pctOf(withEither.length, rows.length)})`);
    if (!withEither.length) {
      console.log(`   !! nothing carries a spread yet. Either the scan has not run on the new`);
      console.log(`      code, or api.php is dropping the fields on the way out.`);
    }
    for (const item of rows.slice(0, 4)) {
      console.log(`   e.g. firstSpread=${item.firstSpread} spread=${item.spread}`
        + ` bestAsk=${item.bestAsk} bestBid=${item.bestBid} ${String(item.question || "").slice(0, 40)}`);
    }
  }

  // 2. What the rule keeps, and of what.
  {
    console.log(`\n-- what the ${(MAX_TRADABLE_SPREAD * 100).toFixed(0)}-point rule keeps --`);
    distribution(rows.map(firstSpread).filter((value) => value != null), "recorded discovery spreads");
    distribution(rows.map(liveSpread).filter((value) => value != null), "recorded live spreads     ");

    const recorded = rows.filter((item) => firstSpread(item) != null);
    const unrecorded = rows.length - recorded.length;
    const tradable = recorded.filter((item) => firstSpread(item) <= MAX_TRADABLE_SPREAD).length;
    console.log(`\n   of the ${recorded.length} rows that recorded one, ${tradable} are inside the limit (${pctOf(tradable, recorded.length)})`);
    console.log(`   ${unrecorded} rows recorded none and are held back until the scan revisits them (${pctOf(unrecorded, rows.length)})`);
    console.log(`   -> the statistics currently see ${tradable} of ${rows.length} (${pctOf(tradable, rows.length)})`);

    // Whether 5 points is the right number for our own catalogue rather than for Gamma's
    // newest listings. If almost nothing passes at any sane limit, the limit is not the
    // thing to argue about -- the catalogue is simply unquoted.
    console.log(`\n   what other limits would keep, of the ${recorded.length} that recorded a spread:`);
    for (const gate of [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.2, 0.5]) {
      const kept = recorded.filter((item) => firstSpread(item) <= gate).length;
      console.log(`     <= ${String((gate * 100).toFixed(0)).padStart(2)} pts: ${String(kept).padStart(5)} (${pctOf(kept, recorded.length)})`
        + (Math.abs(gate - MAX_TRADABLE_SPREAD) < 1e-9 ? "   <- in force" : ""));
    }

    // A rejected row can fail for two quite different reasons, and only one of them is
    // "the market is wide". A market with no bid at all is not a wide market, it is an
    // empty one, and that is the case the report was about.
    const rejected = recorded.filter((item) => firstSpread(item) > MAX_TRADABLE_SPREAD);
    const noBid = rejected.filter((item) => num(item.bestBid) == null && num(item.firstBestBid) == null).length;
    const zeroVolume = rejected.filter((item) => !(num(item.volume24hr) > 0)).length;
    console.log(`\n   of the ${rejected.length} rejected: ${noBid} have no bid recorded at all (${pctOf(noBid, rejected.length)})`
      + `, ${zeroVolume} traded nothing in 24h (${pctOf(zeroVolume, rejected.length)})`);

    // The two readers must not diverge wildly, or the entry gate and the statistics will
    // be filtering different catalogues.
    const both = rows.filter((item) => firstSpread(item) != null && liveSpread(item) != null);
    const disagree = both.filter((item) => (firstSpread(item) <= MAX_TRADABLE_SPREAD)
      !== (liveSpread(item) <= MAX_TRADABLE_SPREAD));
    console.log(`   discovery and live verdicts differ on ${disagree.length} of ${both.length} rows carrying both (${pctOf(disagree.length, both.length)})`
      + ` -- expected and fine: a book that tightened is tradable now but was not then`);
  }

  // 3. Does the published report agree with recomputing it here.
  {
    console.log(`\n-- what the published report says --`);
    const reportResponse = await fetch(`${REPORT_URL}&t=${Date.now()}`);
    if (!reportResponse.ok) {
      console.log(`   report read failed: HTTP ${reportResponse.status}`);
      return;
    }
    const dashboard = await reportResponse.json();
    const report = dashboard.latestCalculationReport
      || (Array.isArray(dashboard.calculationReports) ? dashboard.calculationReports[0] : null);
    if (!report) {
      console.log(`   no calculation report published yet`);
      return;
    }
    console.log(`   generatedAt        : ${report.generatedAt}`);
    console.log(`   maxTradableSpread  : ${report.maxTradableSpread ?? "(absent -- pre-gate report)"}`);
    console.log(`   scraped rows        : ${report.spreadScrapedCount ?? "-"}`);
    console.log(`   held back for spread: ${report.spreadExcludedCount ?? "-"}`);
    console.log(`   resolved sample     : ${report.resolvedSampleSize ?? report.sampleSize ?? "-"}`);
    if (report.maxTradableSpread == null) {
      console.log(`   !! this report predates the gate. It is rebuilt on a pass that holds the`);
      console.log(`      resolved archive, so a scan-only or execution-only pass leaves it as is.`);
    }
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
