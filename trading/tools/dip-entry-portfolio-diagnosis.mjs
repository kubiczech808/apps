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

  // Reported next: three dip portfolios in paper, two of which never open anything, with
  // the entry parameters lowered a long way and markets visible in the candidates list.
  //
  // The candidates list is not where a dip portfolio's candidates come from, and that is the
  // first thing to establish. A dip portfolio's pool is the hits the RPi worker RECORDED --
  // the catalogue cannot hold a collapsed favourite at all, because the scan keeps only the
  // leading outcome above 0.50 -- so a portfolio with no hits has no pool, however full the
  // catalogue looks. Three things have to be true before a hit can exist, and each one fails
  // silently into the same run-log sentence: the portfolio has to be IN the watch list, the
  // worker has to be RUNNING, and the price has to actually REACH the band.
  console.log("\n== 3. is the portfolio in the watch list the worker polls");
  const watch = await fetchJson(`${HOST}/api.php?action=dip-entry-watch`, "dip watch");
  const watched = new Set(watch?.portfolios || []);
  const plansBy = new Map();
  for (const plan of watch?.plans || []) {
    const key = String(plan.portfolioId || "");
    if (!plansBy.has(key)) plansBy.set(key, []);
    plansBy.get(key).push(plan);
  }
  console.log(`   generated ${watch?.generatedAt || "-"}`
    + `   portfolios watching ${watched.size}   plans prepared ${(watch?.plans || []).length}`);
  for (const [id, row] of carriers) {
    const key = `paper-${id}`;
    const plans = plansBy.get(key) || [];
    const blocked = plans.filter((plan) => String(plan.blockedReason || "")).length;
    console.log(`   ${key.padEnd(26)} ${watched.has(key) ? "WATCHED" : "NOT WATCHED"}`
      + `   plans ${String(plans.length).padStart(3)}   of those blocked ${blocked}`);
    // The gates the payload applies, recomputed here so an absence has a reason beside it
    // rather than being reported as a bare "no".
    if (!watched.has(key)) {
      const buyMax = num(row.maxProbability);
      const openMin = num(row.dipEntryOpenMin);
      const reasons = [];
      if (row.dipEntryEnabled !== true) reasons.push("the rule is off on this portfolio");
      if (row.archived === true) reasons.push("the portfolio is archived");
      if (row.automationEnabled === false) reasons.push("automation is switched off");
      if (buyMax == null) reasons.push("it has no probability MAXIMUM, and an open-ended range necessarily overlaps the opening band");
      else if (openMin != null && buyMax >= openMin) {
        reasons.push(`its range reaches into the opening band (max ${pct(buyMax)} >= opening min ${pct(openMin)}),`
          + ` so the rule would fire on a market that never fell`);
      }
      for (const reason of reasons.length ? reasons : ["no gate in the payload explains this -- read the endpoint directly"]) {
        console.log(`      -> ${reason}`);
      }
    }
    for (const plan of plans.filter((one) => String(one.blockedReason || "")).slice(0, 5)) {
      console.log(`      blocked: ${plan.blockedReason}   "${String(plan.question || "").slice(0, 48)}"`);
    }
  }

  console.log("\n== 4. what the worker has actually recorded");
  const hitsPayload = await fetchJson(`${HOST}/api.php?action=dip-entry-hits`, "dip hits");
  const hits = Array.isArray(hitsPayload?.hits) ? hitsPayload.hits : [];
  console.log(`   ${hits.length} hit(s) on record`);
  const byPortfolio = new Map();
  for (const hit of hits) {
    const key = String(hit.portfolioId || "(none)");
    if (!byPortfolio.has(key)) byPortfolio.set(key, []);
    byPortfolio.get(key).push(hit);
  }
  for (const [key, rows] of [...byPortfolio.entries()].sort()) {
    const newest = rows.map((row) => String(row.at || "")).sort().pop() || "-";
    console.log(`   ${key.padEnd(26)} ${String(rows.length).padStart(3)} hit(s)   newest ${newest}`);
  }
  for (const [id] of carriers) {
    const key = `paper-${id}`;
    if (!byPortfolio.has(key)) console.log(`   ${key.padEnd(26)}   0 hit(s)  <- nothing to open a position from`);
  }

  console.log("\n== 5. what the answer means");
  console.log("   NOT WATCHED -> the reason is printed above it, and it is a configuration");
  console.log("   fault the portfolio cannot trade its way out of: fix the range or the band.");
  console.log("   WATCHED with plans but 0 hits -> the watch is right, and there are three");
  console.log("   reasons this can happen: the worker is not armed (LIVE_DIP_ENTRY_MODE=off");
  console.log("   is the default), nothing has fallen into the band yet, or the record was");
  console.log("   lost after being written. The last one is real: deploying the site used to");
  console.log("   delete data/dip-entry-hits.json, so check the worker's own event history");
  console.log("   for DIP_ENTRY_PAPER_RECORDED before concluding the watcher is off.");
  console.log("   WATCHED, hits recorded, still no trade -> the hit rows are being refused by");
  console.log("   an ordinary portfolio filter: liquidity, net yield, tags, market shape.");
  console.log("   And the candidates list is NOT this pool -- a collapsed favourite is not in");
  console.log("   the catalogue at all, so seeing markets there says nothing about this rule.");
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
