// Read-only diagnostic. Places no orders, writes nothing, needs no secrets.
//
// Reported: the run log says an order was placed and accepted, and the position appears
// neither in the open positions list nor on Polymarket.
//
//   SUBMITTED  05. 09. 2026 23:19  Placing order "LoL: Sentinels vs Cloud9 (BO3)" ...
//   SUBMITTED  05. 09. 2026 23:15  Placing order "The Citadel vs. Charlotte" ...
//
// "Accepted by Polymarket" is decided by successfulOrderResponse in
// live-order-executor.mjs, which counts these as success:
//
//   live | matched | delayed | unmatched
//
// Only `matched` means the order filled. `live` means it is resting on the book -- real,
// but not a position yet. `delayed` means the match is queued. And `unmatched` means the
// order did not execute at all, which for a fill-or-kill entry is the definition of
// nothing happened. The exit worker already draws this line (exitFilled requires
// `matched`, with a comment saying that reading `live`/`delayed` as a fill would leave a
// position unmonitored); the entry path never did.
//
// This prints what the exchange actually answered for each recent run, so the difference
// between "resting", "queued" and "did not execute" is on screen rather than inferred.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const RUNS = Math.max(1, Number(process.env.LIVE_DIAGNOSIS_RUNS || 12));

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
      archived: row.archived === true,
      useLimitOrders: row.useLimitOrders === true,
      automationEnabled: row.automationEnabled !== false,
    });
  }
  return targets;
}

// Every response shape the executor has been seen to return, reduced to the one question
// that matters: is there a position now.
function verdict(status, orderType) {
  const value = String(status || "").toLowerCase();
  if (value === "matched") return ["FILLED", "a position exists"];
  if (value === "live") {
    return String(orderType || "").toUpperCase() === "GTC"
      ? ["RESTING", "a real order, but not a position until it fills"]
      : ["RESTING", "resting despite not being a GTC order"];
  }
  if (value === "delayed") return ["QUEUED", "the match is queued; it may or may not fill"];
  if (value === "unmatched") return ["NO FILL", "the order did not execute at all"];
  if (!value) return ["(no status)", "nothing on the row says what the exchange answered"];
  return [value.toUpperCase(), ""];
}

async function main() {
  console.log(`Live order acceptance diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.\n");

  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};

  const tally = new Map();
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
    console.log(`== ${portfolio.label} (${portfolio.id})`);
    console.log(`   limit orders ${portfolio.useLimitOrders ? "on" : "off"}`
      + `   automation ${portfolio.automationEnabled === false ? "off" : "on"}`
      + `   archived ${portfolio.archived === true}`);

    let printed = 0;
    for (const run of runs) {
      const action = String(run.action || "").toUpperCase();
      if (!action.includes("SUBMITTED")) continue;
      const attempts = Array.isArray(run.attempts) ? run.attempts : [];
      const selected = run.selected || run.order || {};
      const rows = attempts.length ? attempts : [selected];
      for (const row of rows) {
        const response = row?.response || {};
        // responseStatus is the field orderAttemptSummary writes; row.status is the
        // CANDIDATE's evaluation status and answers a different question entirely.
        const status = row?.responseStatus ?? response.status ?? null;
        const [label, note] = verdict(status, row?.orderType);
        tally.set(label, (tally.get(label) || 0) + 1);
        console.log(`   ${String(run.generatedAt || run.runAt || "").padEnd(26)} ${action.padEnd(22)}`
          + ` ${String(row?.orderType || "-").padEnd(5)} ${label.padEnd(10)} ${note}`);
        console.log(`      ${String(row?.question || selected.question || "").slice(0, 78)}`
          + `${row?.outcome ? ` (${row.outcome})` : ""}`);
        console.log(`      status ${JSON.stringify(status)}   orderId ${JSON.stringify(response.orderID || response.orderId || null)}`
          + `   size ${JSON.stringify(row?.orderSize ?? null)}   price ${JSON.stringify(row?.orderPrice ?? null)}`
          + `   error ${JSON.stringify(row?.responseError ?? response.errorMsg ?? response.error ?? null)}`);
        if (row?.responseSummary) console.log(`      summary ${JSON.stringify(row.responseSummary)}`);
        printed += 1;
      }
    }
    if (!printed) console.log("   (no SUBMITTED run in the retained log)");
    console.log("");
  }

  console.log("== what the exchange answered, across every SUBMITTED run above");
  for (const [label, count] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(4)}  ${label}`);
  }
  if (!tally.size) console.log("   (nothing to count)");
  console.log("");
  console.log("   FILLED is the only one of these that is a position. Anything else logged as");
  console.log("   SUBMITTED is a run log that promises something the account does not hold.");
}

main().catch((error) => {
  console.error(`diagnosis failed: ${error?.message || error}`);
  process.exitCode = 1;
});
