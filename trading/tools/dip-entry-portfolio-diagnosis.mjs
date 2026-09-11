// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: a paper portfolio was created to test the dip-entry rule -- buy a favourite that
// has collapsed, opening band 70-80%, buy band 30-40% -- and its trades are being opened at
// completely different probabilities.
//
// There are two separate things to establish, and they have different fixes:
//
//   1. WHAT THE PORTFOLIO IS CONFIGURED AS. The form asks for a probability range AND the
//      rule carries a buy band, which is a duplication: if the range is set to the opening
//      band then the portfolio is an ordinary 70-80% portfolio whatever the rule says.
//   2. WHETHER THE RULE IS APPLIED AT ALL by the paper bot. The rule and its configuration
//      shipped; the gate that uses them did not, pending a decision about where the data
//      comes from. If it was never applied, the portfolio trades normally and the buy band
//      is decoration.
//
// So this prints the portfolio's own configuration, then every trade it has opened with the
// probability it was bought at and the probability the market was FIRST seen at -- which is
// what the rule is about. A portfolio whose trades were all bought inside its opening band
// is answering question 1; one bought inside the buy band is the rule working.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const FOCUS = (process.env.DIP_PORTFOLIO || "").trim().toLowerCase();

async function fetchJson(url, label) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pct = (value) => (value == null ? "  -   " : `${(value * 100).toFixed(1)}%`.padStart(6));

async function main() {
  console.log(`Dip-entry portfolio diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config`, "portfolio config");
  const saved = config?.config || config || {};
  const paper = saved.paper || {};

  console.log("== 1. how every portfolio carrying the rule is actually configured");
  const carriers = [];
  for (const [id, row] of Object.entries(paper)) {
    if (!row || typeof row !== "object") continue;
    const name = String(row.displayName || id);
    const wanted = !FOCUS || name.toLowerCase().includes(FOCUS) || id.toLowerCase().includes(FOCUS);
    if (!wanted && row.dipEntryEnabled !== true) continue;
    carriers.push([id, row]);
    console.log(`   ${id.padEnd(20)} "${name}"`);
    console.log(`      dip entry ${row.dipEntryEnabled === true ? "ON " : "off"}`
      + `   opening band ${pct(num(row.dipEntryOpenMin))}-${pct(num(row.dipEntryOpenMax))}`
      + `   buy band ${pct(num(row.dipEntryBuyMin))}-${pct(num(row.dipEntryBuyMax))}`);
    console.log(`      the portfolio's OWN range ${pct(num(row.minProbability))}-${pct(num(row.maxProbability))}`
      + `   events under way: ${row.liveEventMode || "-"}`
      + `   automation ${row.automationEnabled === false ? "off" : "on"}`);
    // The duplication, named. If the portfolio's own range is the opening band then it will
    // buy favourites however the rule is configured, because that range is what the bot
    // filters on.
    const min = num(row.minProbability);
    const openMin = num(row.dipEntryOpenMin);
    const openMax = num(row.dipEntryOpenMax);
    if (row.dipEntryEnabled === true && min != null && openMin != null && openMax != null
      && min >= openMin - 0.001 && min <= openMax + 0.001) {
      console.log(`      -> its own range IS the opening band, so it shortlists favourites,`);
      console.log(`         not collapsed ones, whatever the buy band says`);
    }
  }
  if (!carriers.length) console.log("   no paper portfolio carries the rule");

  console.log("\n== 2. what those portfolios actually bought");
  const state = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard`, "paper state");
  const portfolios = state?.state?.paperPortfolios || state?.paperPortfolios || {};
  for (const [id, row] of carriers) {
    const held = portfolios[id] || {};
    const trades = [
      ...(Array.isArray(held.trades) ? held.trades : []),
      ...(Array.isArray(held.openTrades) ? held.openTrades : []),
      ...(Array.isArray(held.closedTrades) ? held.closedTrades : []),
    ];
    console.log(`\n   ${id} "${String(row.displayName || id)}": ${trades.length} trade(s)`);
    if (!trades.length) {
      console.log("      (no trade rows in the dashboard summary for this portfolio)");
      continue;
    }
    console.log("      bought   opened   under way  market");
    const buckets = new Map();
    for (const trade of trades.slice(0, 40)) {
      const bought = num(trade.entryPrice ?? trade.marketProbability ?? trade.marketPrice);
      const opened = num(trade.firstMarketProbability);
      const running = trade.eventStarted === true || (trade.eventStartTime
        ? Date.parse(trade.eventStartTime) <= Date.parse(trade.openedAt || trade.date || "") : null);
      console.log(`      ${pct(bought)}  ${pct(opened)}   ${running === null ? "  ?   " : (running ? " yes  " : " no   ")}`
        + `   "${String(trade.question || "").slice(0, 52)}" [${trade.outcome || "-"}]`);
      const key = bought == null ? "unknown" : `${Math.floor(bought * 10) * 10}-${Math.floor(bought * 10) * 10 + 10}%`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    console.log("      entry price distribution:");
    for (const [bucket, count] of [...buckets.entries()].sort()) {
      console.log(`         ${bucket.padEnd(10)} ${count}`);
    }
  }

  console.log("\n== 3. what the answer means");
  console.log("   Bought inside the OPENING band -> the portfolio is an ordinary favourites");
  console.log("   portfolio: its own probability range is what the bot filters on, and the");
  console.log("   buy band is not consulted. Bought inside the BUY band -> the rule is live.");
  console.log("   Anything else -> neither, and the gate is missing from the bot entirely.");
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
