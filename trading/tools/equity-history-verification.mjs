// Read-only verification. Writes nothing, publishes nothing, needs no secrets.
//
// Confirms on production that the account sync is now recording its own realised equity
// per day, and reports what the chart will draw from it -- so "it should work" is not the
// last word on it.
//
// The series is what replaced the ledger reconstruction for the equity chart. It only
// takes over once two days exist, so this also says how much longer that is.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const num = (value) => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

async function main() {
  console.log(`Equity history verification at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const live = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const state = live?.state || live || {};
  console.log(`live state generatedAt: ${state.generatedAt || "(none)"}`);

  const rows = Array.isArray(state.equityHistory) ? state.equityHistory : null;
  if (rows == null) {
    console.log("\n!! no equityHistory on the served state.");
    console.log("   Either no sync has run since the field shipped, or the field is being");
    console.log("   dropped between the sync and the served document. The chart stays on the");
    console.log("   ledger reconstruction until it appears.");
    return;
  }

  console.log(`\n== recorded daily buckets: ${rows.length}`);
  if (!rows.length) {
    console.log("   the field exists but is empty -- the first sample was skipped, which happens");
    console.log("   only when equity or open P/L could not be read.");
    return;
  }

  for (const row of rows.slice(-14)) {
    const samples = num(row?.samples);
    const sum = num(row?.realizedSum);
    const mean = samples && sum != null ? sum / samples : null;
    console.log(`   ${row.day}  samples ${String(samples ?? "?").padStart(3)}`
      + `  mean ${mean == null ? "     ?" : mean.toFixed(4).padStart(10)}`
      + `  low ${String(num(row?.realizedMin) ?? "?").padStart(10)}`
      + `  high ${String(num(row?.realizedMax) ?? "?").padStart(10)}`
      + `  last ${String(num(row?.realizedLast) ?? "?").padStart(10)}`);
  }
  if (rows.length > 14) console.log(`   ... and ${rows.length - 14} earlier day(s)`);

  // The same gates the chart applies, so this reports what it will actually draw rather
  // than what the data merely contains.
  const usable = rows.filter((row) => {
    const samples = num(row?.samples);
    return Number.isFinite(Date.parse(`${String(row?.day || "")}T12:00:00Z`))
      && samples != null && samples >= 1
      && num(row?.realizedSum) != null && num(row?.realizedMin) != null && num(row?.realizedMax) != null;
  });
  console.log(`\n== what the chart will draw`);
  console.log(`   buckets passing the chart's own gates  ${usable.length}`);
  if (usable.length >= 2) {
    console.log(`   -> the measured series takes over: ${usable.length} daily points, with the day's`);
    console.log(`      low in red and its high in green. The ledger reconstruction is no longer used.`);
    const spread = usable.filter((row) => Math.abs(num(row.realizedMax) - num(row.realizedMin)) > 0.0001);
    console.log(`   days whose low and high differ          ${spread.length} of ${usable.length}`);
    if (!spread.length) {
      console.log(`      (all flat so far -- expected until a day carries more than one sync)`);
    }
  } else {
    console.log(`   -> still one day or fewer, so the chart keeps the ledger reconstruction.`);
    console.log(`      The sync runs at :05 and :35, so a second day appears after the next UTC midnight.`);
  }

  const portfolio = state.portfolio || {};
  const equity = num(portfolio.equityUsdc);
  const openPnl = num(portfolio.openPnlUsdc) ?? 0;
  const newest = usable[usable.length - 1];
  if (newest && equity != null) {
    // Guards the recording itself: the newest bucket's last reading has to be the equity
    // the account is reporting right now, or something is transforming it on the way.
    const expected = equity - openPnl;
    const stored = num(newest.realizedLast);
    console.log(`\n== does the newest bucket match the account right now`);
    console.log(`   equity - openPnl   ${expected.toFixed(4)}`);
    console.log(`   realizedLast       ${stored == null ? "?" : stored.toFixed(4)}`);
    console.log(`   -> ${stored != null && Math.abs(stored - expected) < 0.0101 ? "MATCHES" : "DIFFERS -- worth a look"}`);
  }
}

main().catch((error) => {
  console.log(`\n!! verification stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
