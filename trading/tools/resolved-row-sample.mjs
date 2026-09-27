// Read-only. Prints the actual settled rows behind one tag, so a cell that reads 100% can be
// looked at instead of theorised about.
//
// Two theories have already been wrong about these numbers. The first said the entry price
// belonged to a side that had since flipped; that is real, and it is 2% of rows, which
// cannot produce a 100% win rate on a tag. So this stops reasoning from the shape of the
// code and reads the rows.
//
// It asks taxonomy-observations, which takes one tag and a row limit. Deliberately a small
// limit: the endpoint reads the settled archive, and an unbounded read of it is what
// exhausted this host's memory once.

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const TAG = String(process.env.MARKET_TAG || "league-of-legends").trim().toLowerCase();
const LIMIT = Math.max(1, Math.min(800, Number(process.env.ROW_LIMIT || 300)));
const SHOW = Math.max(1, Math.min(60, Number(process.env.SHOW_ROWS || 20)));

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pct = (value) => (value == null ? "   -  " : `${(value * 100).toFixed(1)}%`.padStart(6));

// The same four gates resolved_stats_accumulate applies, so a row that the statistics
// counted can be told apart from one they skipped. Reported per gate rather than as a single
// "eligible", because which gate removes a row is the finding.
export function gateRow(row, maxSpread = 0.05) {
  const entry = [row?.firstMarketProbability, row?.lastLiveMarketProbability, row?.marketProbability, row?.marketPrice]
    .map(num).find((value) => value != null && value > 0 && value < 1) ?? null;
  const finalPrice = num(row?.finalOutcomePrice);
  const outcome = finalPrice == null ? null : (finalPrice <= 0.005 ? 0 : (finalPrice >= 0.995 ? 1 : null));
  const spread = num(row?.firstSpread) ?? (num(row?.firstBestAsk) != null && num(row?.firstBestBid) != null
    ? Math.abs(num(row.firstBestAsk) - num(row.firstBestBid))
    : null);
  const seen = Date.parse(String(row?.firstObservedAt || row?.firstEvaluatedAt || row?.observedAt || ""));
  const due = Date.parse(String(row?.resolutionEndDate || row?.endDate || ""));
  return {
    entry,
    outcome,
    spread,
    flipped: String(row?.firstTokenId || "") !== "" && String(row?.tokenId || "") !== ""
      && String(row.firstTokenId) !== String(row.tokenId),
    hasEntry: entry != null,
    hasOutcome: outcome != null,
    spreadOk: spread == null || spread <= maxSpread,
    notAfterDue: !(Number.isFinite(seen) && Number.isFinite(due)) || due > seen,
  };
}

export function counted(gated) {
  return gated.hasEntry && gated.hasOutcome && gated.spreadOk && gated.notAfterDue;
}

// The question every one of these rows has to answer: how often did a favourite priced at p
// actually win? If the counted rows win far more often than they were priced, whatever is
// wrong is in which rows get counted, not in the arithmetic over them.
export function summarise(rows) {
  const gated = rows.map((row) => ({ row, gate: gateRow(row) }));
  const kept = gated.filter((entry) => counted(entry.gate));
  const wins = kept.filter((entry) => entry.gate.outcome === 1).length;
  const meanEntry = kept.length
    ? kept.reduce((total, entry) => total + entry.gate.entry, 0) / kept.length
    : null;
  return {
    total: rows.length,
    counted: kept.length,
    wins,
    winRate: kept.length ? wins / kept.length : null,
    meanEntry,
    noEntry: gated.filter((entry) => !entry.gate.hasEntry).length,
    noOutcome: gated.filter((entry) => entry.gate.hasEntry && !entry.gate.hasOutcome).length,
    wideSpread: gated.filter((entry) => entry.gate.hasEntry && entry.gate.hasOutcome && !entry.gate.spreadOk).length,
    afterDue: gated.filter((entry) => entry.gate.hasEntry && entry.gate.hasOutcome && entry.gate.spreadOk && !entry.gate.notAfterDue).length,
    flipped: kept.filter((entry) => entry.gate.flipped).length,
    kept,
  };
}

async function main() {
  const url = `${HOST}/api.php?action=taxonomy-observations&kind=tag`
    + `&value=${encodeURIComponent(TAG)}&statuses=RESOLVED&limit=${LIMIT}`;
  console.log(`Resolved row sample for "${TAG}" at ${new Date().toISOString()}`);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    console.log(`   !! HTTP ${response.status}: ${text.slice(0, 300)}`);
    return;
  }
  const payload = JSON.parse(text);
  const rows = ["observations", "rows", "marketObservations", "items"]
    .map((field) => payload?.[field]).find(Array.isArray) ?? [];
  console.log(`   response keys: ${Object.keys(payload || {}).join(", ")}`);
  if (!rows.length) {
    console.log(`   no rows: ${JSON.stringify(payload).slice(0, 500)}`);
    return;
  }

  const stats = summarise(rows);
  console.log(`\n   ${stats.total} settled row(s) returned; ${stats.counted} pass the statistics' own gates.`);
  console.log(`   dropped: ${stats.noEntry} with no live entry price, ${stats.noOutcome} with no clean 0/1`
    + ` settlement, ${stats.wideSpread} too wide at entry, ${stats.afterDue} first seen after they were due.`);
  console.log(`   of the counted rows, ${stats.flipped} changed sides since discovery.`);
  console.log(`\n   counted win rate ${pct(stats.winRate)} at a mean entry of ${pct(stats.meanEntry)}`);
  console.log(`   -- a fairly priced sample wins about as often as its price. A large gap here`);
  console.log(`      is in WHICH rows get counted, since the arithmetic over them is trivial.`);

  console.log(`\n   entry  settled  flip  spread  first seen            due                   question`);
  for (const { row, gate } of stats.kept.slice(0, SHOW)) {
    console.log(`   ${pct(gate.entry)} ${String(gate.outcome).padStart(8)} ${gate.flipped ? " yes" : "  no"}`
      + ` ${gate.spread == null ? "     -" : (gate.spread * 100).toFixed(1).padStart(6)}`
      + `  ${String(row?.firstObservedAt || "-").slice(0, 19).padEnd(20)}`
      + `  ${String(row?.resolutionEndDate || row?.endDate || "-").slice(0, 19).padEnd(20)}`
      + `  ${String(row?.question || "").slice(0, 60)}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Sample failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
