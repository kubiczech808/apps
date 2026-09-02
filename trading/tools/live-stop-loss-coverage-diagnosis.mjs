// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: a live position lost its whole stake with no stop loss applied.
// Measured on "Como: Matej Dodig vs Henry Bernet", outcome Henry Bernet:
//
//   entry 0.73   shares 6.84   cost 4.9932   net gain if won 1.8468
//   realised P/L -4.9932       finalOutcomePrice 0
//   stopLossStatus (none)  stopLossRiskMultiplier (none)  stopLossPrice (none)
//   a 175% cap implies a risk target of 3.2319, so 1.7613 USDC more was lost
//   than the configured ceiling allows, and nothing on the row says a stop existed
//
// The live stop loss is not in the executor. rpi-live-exit-worker.mjs polls
// api.php?action=live-exit-policy and watches the tokens that payload names. And
// live_stop_loss_policy_payload() builds that list like this:
//
//   for each live portfolio with stopLossRiskMultiplier > 0:
//       read ITS execution state file
//       records = [state, ...state.runLog]
//       keep records where live_execution_record_was_submitted(record)
//       collect the token ids from those records
//
// So a position is protected only while the run that opened it is still in the
// retained run log. That log is bounded and compacted, which would mean a position
// silently loses its stop loss as its originating run scrolls out -- while it is
// still open. That is a hypothesis, not a finding, and there is a simpler
// explanation to rule out first: the portfolio may have no multiplier set at all.
//
// This reports which. It compares the account's OPEN positions against the token
// ids the policy payload actually covers, and prints the stop-loss configuration of
// every live portfolio.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const FOCUS = (process.env.FOCUS_MARKETS || "bernet")
  .split(";").map((text) => text.trim().toLowerCase()).filter(Boolean);

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
  console.log(`Live stop-loss coverage diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  console.log("== 1. is a stop loss configured at all, per live portfolio");
  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};
  const portfolios = [
    ["live", config.live],
    ["live5050", config.live5050],
    ...Object.entries(config.livePortfolios || {}).map(([id, row]) => [`live-custom-${id}`, row]),
  ];
  for (const [id, row] of portfolios) {
    if (!row || typeof row !== "object") {
      console.log(`   ${id.padEnd(26)} (no configuration)`);
      continue;
    }
    const multiplier = num(row.stopLossRiskMultiplier);
    const legacy = row.stopLossEnabled === true;
    const effective = multiplier != null ? multiplier : (legacy ? 1 : 0);
    console.log(`   ${id.padEnd(26)} name ${String(row.displayName || "-").padEnd(16)}`
      + ` archived ${String(row.archived === true).padEnd(5)}`
      + ` stopLossRiskMultiplier ${String(multiplier ?? "(unset)").padEnd(8)}`
      + ` stopLossEnabled ${String(legacy).padEnd(5)}`
      + ` -> effective ${effective}`
      + `${effective > 0 ? "" : "   NO POLICY: live_stop_loss_policy_config returns null"}`);
  }

  console.log("\n== 2. what the worker's policy payload actually covers");
  const payload = await fetchJson(`${HOST}/api.php?action=live-exit-policy&t=${Date.now()}`);
  const policies = Array.isArray(payload?.policies) ? payload.policies : [];
  const covered = new Map(policies.map((policy) => [String(policy.tokenId || ""), policy]));
  console.log(`   generatedAt        ${payload?.generatedAt || "(none)"}`);
  console.log(`   policies           ${policies.length} token(s)`);
  console.log(`   defaultPolicy      ${payload?.defaultPolicy
    ? `portfolio ${payload.defaultPolicy.portfolioId}, multiplier ${payload.defaultPolicy.stopLossRiskMultiplier}`
    : "(none) -- unlabelled positions are unprotected"}`);

  console.log("\n== 3. open positions against that coverage");
  const live = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`)
    .then((state) => state?.state || state || {});
  const positions = Array.isArray(live.positions) ? live.positions : [];
  let unprotected = 0;
  for (const position of positions) {
    const tokenId = String(position.tokenId || position.assetId || "").trim();
    const policy = covered.get(tokenId) || null;
    if (!policy) unprotected += 1;
    console.log(`   ${policy ? "covered  " : "UNCOVERED"}  ${String(position.question || "").slice(0, 54).padEnd(56)}`
      + ` stake ${String(num(position.totalCostUsdc ?? position.stakeUsdc) ?? "-").padStart(8)}`
      + `${policy ? `  multiplier ${policy.stopLossRiskMultiplier} from ${policy.portfolioId}` : ""}`);
  }
  console.log(`\n   open positions     ${positions.length}`);
  console.log(`   not in the payload ${unprotected}`
    + `${unprotected && !payload?.defaultPolicy ? "  <- and no defaultPolicy to catch them" : ""}`);
  if (unprotected && payload?.defaultPolicy) {
    console.log(`   (the defaultPolicy covers unlabelled positions for the main live portfolio,`);
    console.log(`    so an uncovered row is only truly unprotected if the worker declines it)`);
  }

  console.log("\n== 4. the reported market, wherever it appears");
  const rows = [
    ...positions.map((row) => ["position", row]),
    ...(Array.isArray(live.closedTrades) ? live.closedTrades : []).map((row) => ["closed", row]),
  ].filter(([, row]) => FOCUS.some((needle) => `${row?.question || ""} ${row?.outcome || ""}`.toLowerCase().includes(needle)));
  for (const [where, row] of rows) {
    const tokenId = String(row.tokenId || row.assetId || "").trim();
    const cost = num(row.totalCostUsdc ?? row.stakeUsdc);
    const reward = num(row.netGainIfWinUsdc);
    console.log(`\n   [${where}] "${String(row.question || "").slice(0, 58)}" (${row.outcome || "-"})`);
    console.log(`      status ${row.status || "-"}   realised P/L ${num(row.realizedPnlUsdc) ?? "-"}`
      + `   finalOutcomePrice ${num(row.finalOutcomePrice) ?? "-"}`);
    console.log(`      stopLossStatus ${row.stopLossStatus || "(none)"}`
      + `   multiplier ${num(row.stopLossRiskMultiplier) ?? "(none)"}`
      + `   stopPrice ${num(row.stopLossPrice) ?? "(none)"}`);
    console.log(`      in the policy payload now: ${covered.has(tokenId) ? "yes" : "no"}`);
    if (cost != null && reward != null && reward > 0) {
      // What the configured cap allows, against what was actually lost.
      for (const multiplier of [1, 1.5, 1.75]) {
        const target = Math.min(cost, reward * multiplier);
        console.log(`      at ${(multiplier * 100).toFixed(0)}%: risk target ${target.toFixed(4)}`
          + `   actual loss ${(-(num(row.realizedPnlUsdc) ?? 0)).toFixed(4)}`);
      }
    }
  }
  if (!rows.length) console.log(`   no live row matches ${FOCUS.join(", ")}`);
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
