// Read-only diagnostic. Writes nothing, publishes nothing, places no orders.
//
// Reported: the scraped list is full of opportunities that look like they should reach the
// live portfolio's execution candidates -- football markets that are not Over/Under, 72-81%
// probability, five-figure volume -- and they do not appear.
//
// This does not re-implement the filter to answer that. It loads the live portfolio's real
// configuration from production, maps it to the same environment variables the live
// workflow's "Load portfolio config" step writes, imports live-order-executor.mjs (which
// reads those variables at import and does not start a run), fetches the same scoped
// catalogue a real pass would read, and calls the executor's own prepareLiveCandidatePool.
// So every verdict below is the production code's verdict, not an imitation of it.
//
// It then prints, per row, which gate rejected it -- and for the rows named on the command
// line, the values each gate compared.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
// Substrings identifying the rows to explain in full. The default set is the football and
// plain-win markets from the report.
const FOCUS = (process.env.FOCUS_MARKETS
  || "bayern;flamengo;koln;ipswich;barcelona;stuttgart;liverpool;frosinone;yunnan")
  .split(";").map((text) => text.trim().toLowerCase()).filter(Boolean);
const PORTFOLIO_ID = process.env.LIVE_PORTFOLIO_CONFIG_ID || "";

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

// The live workflow's own mapping, kept in the same order so the two can be compared by
// eye. Anything absent there is absent here: an unset variable is what the workflow
// produces for a missing setting, and the executor's own default then applies.
function environmentFromConfig(config, requestedId) {
  const live = requestedId
    ? ((config.livePortfolios || {})[requestedId] || {})
    : (config.live || {});
  const system = config.system || {};
  const portfolioId = requestedId ? `live-custom-${requestedId}` : "live";
  return {
    live,
    portfolioId,
    mapping: {
      LIVE_MIN_PROBABILITY: live.minProbability,
      LIVE_MAX_PROBABILITY: live.maxProbability,
      LIVE_STAKE_USDC: live.stakeUsdc,
      MAX_ORDER_FRACTION: live.maxOrderFraction,
      LIVE_MAX_RESOLUTION_HOURS: live.maxResolutionHours,
      LIVE_MAX_RESOLUTION_DAYS: live.maxResolutionDays,
      LIVE_EVENT_MODE: String(live.liveEventMode || (live.requireEventStarted ? "only" : "ignore")),
      LIVE_SELECTION_ORDER: live.selectionOrder,
      LIVE_CONFIG_MIN_LIQUIDITY_USDC: live.minLiquidityUsdc,
      LIVE_MIN_NET_YIELD: live.minNetYield,
      LIVE_MARKET_TYPE: live.marketType,
      LIVE_EXCLUDE_OVER_UNDER_MARKETS: String(Boolean(live.excludeOverUnderMarkets)).toLowerCase(),
      LIVE_EXCLUDED_CANDIDATE_TOKEN_IDS: (live.excludedCandidateTokenIds || []).filter((token) => /^\d+$/.test(String(token))).join(","),
      LIVE_EXCLUDED_MARKET_TAGS: (live.excludedMarketTags || []).map((tag) => String(tag).trim()).filter(Boolean).join(","),
      LIVE_INCLUDE_ONLY_MARKET_TAGS: (live.includeOnlyMarketTags || []).map((tag) => String(tag).trim()).filter(Boolean).join(","),
      LIVE_CROSS_PORTFOLIO_RISK_DIVERSIFICATION: String(system.crossLivePortfolioRiskDiversification !== false).toLowerCase(),
      LIVE_PORTFOLIO_ID: portfolioId,
    },
  };
}

async function main() {
  console.log(`Live candidate shortlist diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no order can be placed, no credentials are used.\n");

  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};
  const { live, portfolioId, mapping } = environmentFromConfig(config, PORTFOLIO_ID);

  console.log(`== the live portfolio's stored configuration (${portfolioId})`);
  if (!Object.keys(live).length) {
    console.log("   !! no configuration found for this portfolio id");
    return;
  }
  console.log(`   displayName                 ${live.displayName || "(none)"}`);
  console.log(`   archived                    ${JSON.stringify(live.archived ?? false)}`);
  console.log(`   automationEnabled           ${JSON.stringify(live.automationEnabled ?? true)}`);
  for (const [key, value] of Object.entries(mapping)) {
    if (value === undefined || value === null || value === "") continue;
    process.env[key] = String(value);
    console.log(`   ${key.padEnd(43)} ${value}`);
  }
  console.log(`   (variables not listed are unset, so the executor's own default applies)`);

  // Imported only after the environment is in place: the module reads these at import.
  const executor = await import("../tools/live-order-executor.mjs");

  const catalogueUrl = executor.executionCatalogueUrlForPortfolio(
    `${HOST}/api.php?action=state&target=paper&summary=execution`,
  );
  console.log(`\n== the catalogue a real pass would read`);
  console.log(`   ${catalogueUrl}`);
  const catalogue = await executor.loadScopedExecutionCatalogue(
    catalogueUrl,
    "scoped execution catalogue",
    async (location) => fetchJson(location),
  );
  const rows = Array.isArray(catalogue?.marketObservations) ? catalogue.marketObservations : [];
  console.log(`   rows loaded                 ${rows.length}`
    + `  (pages ${catalogue?.executionScopePagesLoaded ?? 1}, still truncated ${JSON.stringify(catalogue?.executionScopeTruncated ?? false)})`);
  console.log(`   scope total reported        ${catalogue?.executionScopeTotal ?? "(none)"}`);
  if (!rows.length) {
    console.log("   !! the catalogue is empty, so nothing downstream can produce a candidate");
    return;
  }

  const liveState = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`)
    .then((payload) => payload?.state || payload || null)
    .catch(() => null);
  console.log(`   live state for risk checks  ${liveState ? "loaded" : "unavailable"}`);

  const pool = executor.prepareLiveCandidatePool(rows, liveState);
  const stats = pool.diagnostics || {};
  console.log(`\n== the executor's own verdict on that catalogue`);
  console.log(`   stored rows                 ${stats.storedEvaluations ?? "?"}`);
  console.log(`   unique rows                 ${stats.uniqueEvaluations ?? "?"}`);
  console.log(`   passed the prefilter        ${stats.prefilterPassed ?? "?"}`);
  console.log(`   rejected                    ${stats.prefilterRejected ?? "?"}`);
  console.log(`   selected for revalidation   ${stats.selectedForRevalidation ?? "?"}`
    + `  (scan limit ${stats.scanLimit ?? "?"}, skipped by it ${stats.skippedByScanLimit ?? "?"})`);

  const counts = stats.reasonCounts || {};
  const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`\n   -- every rejection reason, by how many rows it rejected --`);
  for (const [reason, count] of ordered) {
    console.log(`      ${String(count).padStart(5)}  ${reason}`);
  }
  if (!ordered.length) console.log("      (nothing was rejected)");

  // Per-row detail for the markets named in the report. A count tells you what the filter
  // is doing in aggregate; this says why THIS market, the one on the screen, is not there.
  console.log(`\n== the rows from the report, in full`);
  const focusRows = rows.filter((row) => {
    const haystack = `${row?.question || ""} ${row?.outcome || ""} ${row?.slug || ""} ${row?.eventSlug || ""}`.toLowerCase();
    return FOCUS.some((needle) => haystack.includes(needle));
  });
  console.log(`   matched ${focusRows.length} row(s) against: ${FOCUS.join(", ")}\n`);

  const selectedTokens = new Set((pool.candidates || []).map((item) => String(item.tokenId || "")));
  for (const row of focusRows) {
    const tokenId = String(row?.tokenId || "");
    console.log(`-- "${String(row.question || "").slice(0, 76)}"`);
    console.log(`   outcome ${row.outcome || "-"}   tokenId ${tokenId.slice(0, 18)}...`);
    console.log(`   marketType ${executor.candidateMarketType(row)}`
      + `   daysToResolution ${(() => {
        const days = executor.localDaysToResolution(row);
        return Number.isFinite(days) ? days.toFixed(2) : "-";
      })()}`
      + `   endDate ${row.endDate || "-"}`);
    console.log(`   status ${row.status || "-"}   marketClosed ${JSON.stringify(row.marketClosed ?? null)}`
      + `   acceptingOrders ${JSON.stringify(row.acceptingOrders ?? null)}`);
    console.log(`   marketProbability ${num(row.marketProbability) ?? "-"}`
      + `   volume24hr ${num(row.volume24hr) ?? "-"}`
      + `   volumeUsdc ${num(row.volumeUsdc) ?? "-"}`
      + `   liquidity ${num(row.liquidity) ?? "-"}`);
    console.log(`   bestBid ${num(row.bestBid) ?? "-"}   bestAsk ${num(row.bestAsk) ?? "-"}`
      + `   tags ${JSON.stringify((Array.isArray(row.polymarketTags) ? row.polymarketTags : []).slice(0, 6))}`);
    // Filtering the row on its own makes the reason list unambiguous: an aggregate count
    // says what the filter does to the catalogue, not why THIS market is missing.
    const single = executor.prepareLiveCandidatePool([row], liveState);
    const reasons = Object.keys(single.diagnostics?.reasonCounts || {});
    if (selectedTokens.has(tokenId)) {
      console.log(`   VERDICT: selected for revalidation in this pass`);
    } else if (!reasons.length) {
      console.log(`   VERDICT: passes every gate on its own, so it was cut by the scan limit`
        + ` (${stats.scanLimit ?? "?"}) -- it is eligible but out-ranked`);
    } else {
      console.log(`   VERDICT: rejected by ${reasons.length} gate(s):`);
      for (const reason of reasons) console.log(`     - ${reason}`);
    }
    console.log("");
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
