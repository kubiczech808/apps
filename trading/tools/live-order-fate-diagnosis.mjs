// Read-only diagnostic. Places no orders, writes nothing, needs no secrets.
//
// The acceptance diagnosis answered what the exchange SAID. This answers what the account
// ended up HOLDING, which is the question actually asked: the run log announces an order,
// and neither the positions list nor Polymarket shows anything.
//
// It cross-references every submitted attempt in the retained run logs against live-state:
//
//   POSITION  the token is in positions -- the order became what it promised
//   RESTING   the token is in openOrders -- a real order, still waiting, visible in its tab
//   GONE      neither -- the order was accepted, and nothing exists for it now
//
// GONE is the interesting one, and the count by order type is the point. A GTC order that
// is gone either filled and was closed again or was cancelled. A fill-and-kill order that
// is gone was killed: it does not rest, so nothing survives it. If the queued FAK orders
// are all GONE, "delayed" on this account is not a fill that is on its way, it is a fill
// that will not happen, and the entry path needs a different instrument -- not just an
// honest label.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const RUNS = Math.max(1, Number(process.env.LIVE_DIAGNOSIS_RUNS || 24));

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

function livePortfolioTargets(config) {
  const targets = [
    { id: "live", label: String(config?.live?.displayName || "Live"), target: "live-execution" },
    { id: "live5050", label: String(config?.live5050?.displayName || "5050"), target: "live-5050-execution" },
  ];
  for (const [id, row] of Object.entries(config?.livePortfolios || {})) {
    if (!row || typeof row !== "object") continue;
    targets.push({
      id: `live-custom-${id}`,
      label: String(row.displayName || id),
      target: `live-custom-${id}-execution`,
      useLimitOrders: row.useLimitOrders === true,
    });
  }
  return targets;
}

function tokenIdOf(row) {
  for (const key of ["tokenId", "token_id", "asset", "assetId"]) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value)) return String(value);
  }
  return "";
}

async function main() {
  console.log(`Live order fate diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.\n");

  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};

  // The account snapshot is a state target like any other -- `target=live` -- not an
  // action of its own. This is the same read the dashboard does before it draws the
  // positions and the unfilled-orders tabs.
  const livePayload = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const liveState = livePayload?.liveState || livePayload?.state || livePayload || {};
  const positions = Array.isArray(liveState?.positions) ? liveState.positions : [];
  const openOrders = Array.isArray(liveState?.openOrders) ? liveState.openOrders : [];
  const heldTokens = new Set(positions.map(tokenIdOf).filter(Boolean));
  const restingTokens = new Set(openOrders.map(tokenIdOf).filter(Boolean));
  const restingOrderIds = new Set(openOrders
    .map((row) => String(row?.orderId || row?.orderID || row?.id || "")).filter(Boolean));

  console.log(`account right now: ${positions.length} position(s), ${openOrders.length} resting order(s)`);
  console.log(`live-state generated at ${JSON.stringify(liveState?.generatedAt || liveState?.updatedAt || null)}\n`);

  // Fate by order type is the whole point, so count them apart rather than together.
  const byType = new Map();
  function tally(orderType, fate) {
    const key = `${String(orderType || "-").toUpperCase()} ${fate}`;
    byType.set(key, (byType.get(key) || 0) + 1);
  }

  for (const portfolio of livePortfolioTargets(config)) {
    let state = null;
    try {
      const payload = await fetchJson(`${HOST}/api.php?action=state&target=${portfolio.target}&t=${Date.now()}`);
      state = payload?.state || payload || null;
    } catch (error) {
      console.log(`== ${portfolio.label} (${portfolio.id})\n   !! ${error.message}\n`);
      continue;
    }
    const runs = [state, ...(Array.isArray(state?.runLog) ? state.runLog : [])]
      .filter((run) => run && typeof run === "object")
      .slice(0, RUNS);

    console.log(`== ${portfolio.label} (${portfolio.id})   limit orders ${portfolio.useLimitOrders ? "on" : "off"}`);
    let printed = 0;
    for (const run of runs) {
      const action = String(run.action || "").toUpperCase();
      if (!action.includes("SUBMITTED") && action !== "PENDING_MATCH") continue;
      const attempts = Array.isArray(run.attempts) ? run.attempts : [];
      const rows = attempts.length ? attempts : [run.selected || run.order || {}];
      for (const row of rows) {
        const status = String(row?.responseStatus ?? row?.response?.status ?? "").toLowerCase();
        // The duplicate guard is the executor's own refusal, not an exchange answer, and
        // counting it as a lost order would overstate the problem by five.
        if (!status || status === "duplicate_guard") continue;
        const tokenId = tokenIdOf(row);
        const orderId = String(row?.response?.orderID || row?.response?.orderId || "");
        const held = tokenId && heldTokens.has(tokenId);
        const resting = (tokenId && restingTokens.has(tokenId)) || (orderId && restingOrderIds.has(orderId));
        const fate = held ? "POSITION" : (resting ? "RESTING" : "GONE");
        tally(row?.orderType, fate);
        console.log(`   ${String(run.generatedAt || run.runAt || "").padEnd(26)}`
          + ` ${String(row?.orderType || "-").padEnd(5)} ${status.padEnd(10)} -> ${fate.padEnd(8)}`
          + ` ${String(row?.question || "").slice(0, 60)}`);
        printed += 1;
      }
    }
    if (!printed) console.log("   (no submitted attempt in the retained log)");
    console.log("");
  }

  console.log("== what each accepted order turned into, by order type");
  for (const [key, count] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(4)}  ${key}`);
  }
  if (!byType.size) console.log("   (nothing to count)");
  console.log("");
  console.log("   A GTC order that is GONE filled and closed, or was cancelled -- it had a life.");
  console.log("   A FAK order that is GONE was killed: it does not rest, so nothing survives it.");
}

main().catch((error) => {
  console.error(`diagnosis failed: ${error?.message || error}`);
  process.exitCode = 1;
});
