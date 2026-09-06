// Read-only diagnostic. Places no orders, writes nothing, needs no secrets.
//
// Speed matters in two places. One is the stop loss, which is now a one-second loop. The
// other is taking the candidate we chose -- and that one has never been measured, so
// "should we make the entry faster too" has only ever been an opinion.
//
// This measures it end to end, at the three points where the number can move:
//
//   1. SHOWN    what the candidate was priced at when it was selected
//   2. BID      what the order was actually placed at, after revalidation repriced it
//   3. PAID     what the account says it paid -- the position's own average entry
//
// 1 -> 2 is the cost of the time between choosing and submitting: the shortlist is built,
// revalidated against a fresh book, and only then signed. 2 -> 3 is the cost of crossing
// the spread and of whatever moved while the order was in flight.
//
// The distinction matters because the two have different fixes. A gap at 1 -> 2 is latency
// and would be worth the same work the exit loop just had. A gap at 2 -> 3 is the spread
// and the book's depth, which no amount of speed removes.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const RUNS = Math.max(1, Number(process.env.LIVE_DIAGNOSIS_RUNS || 40));

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function livePortfolioTargets(config) {
  const targets = [
    { id: "live", label: String(config?.live?.displayName || "Live"), target: "live-execution",
      useLimitOrders: config?.live?.useLimitOrders === true },
    { id: "live5050", label: String(config?.live5050?.displayName || "5050"), target: "live-5050-execution",
      useLimitOrders: config?.live5050?.useLimitOrders === true },
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

// What the exchange says actually happened. A matched order reports the two sides of the
// trade, and their ratio is the real price -- not the price that was asked for.
function filledPrice(response) {
  const taking = num(response?.takingAmount);
  const making = num(response?.makingAmount);
  if (taking == null || making == null || !(taking > 0) || !(making > 0)) return null;
  // A BUY takes shares and makes USDC, so USDC per share is making/taking.
  return making / taking;
}

function parsedResponse(row) {
  if (row?.response && typeof row.response === "object") return row.response;
  const summary = row?.responseSummary;
  if (typeof summary !== "string" || !summary) return null;
  try {
    return JSON.parse(summary);
  } catch {
    // The stored summary is truncated at 600 characters, so a long one is not JSON any
    // more. Reported as unreadable rather than guessed at.
    return null;
  }
}

function points(value) {
  return value == null ? "    -" : `${(value * 100).toFixed(2)}`.padStart(5);
}

async function main() {
  console.log(`Live entry slippage diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.\n");

  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};

  const livePayload = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const liveState = livePayload?.liveState || livePayload?.state || livePayload || {};
  const paidByToken = new Map();
  for (const position of Array.isArray(liveState?.positions) ? liveState.positions : []) {
    const tokenId = String(position?.tokenId || position?.assetId || "");
    const paid = num(position?.entryPrice ?? position?.avgPrice ?? position?.averagePrice);
    if (tokenId && paid != null) paidByToken.set(tokenId, paid);
  }
  console.log(`account: ${paidByToken.size} position(s) with a recorded entry price\n`);

  const shownToBid = [];
  const bidToPaid = [];
  const sizeShortfalls = [];

  for (const portfolio of livePortfolioTargets(config)) {
    let state = null;
    try {
      const payload = await fetchJson(`${HOST}/api.php?action=state&target=${portfolio.target}&t=${Date.now()}`);
      state = payload?.state || payload || null;
    } catch (error) {
      console.log(`== ${portfolio.label}\n   !! ${error.message}\n`);
      continue;
    }
    const runs = [state, ...(Array.isArray(state?.runLog) ? state.runLog : [])]
      .filter((run) => run && typeof run === "object")
      .slice(0, RUNS);

    const lines = [];
    for (const run of runs) {
      const action = String(run.action || "").toUpperCase();
      if (!action.includes("SUBMITTED") && action !== "PENDING_MATCH") continue;
      const batch = run.batchLog || run;
      const selected = batch.selected || run.selected || {};
      const attempts = Array.isArray(run.attempts) ? run.attempts : [];
      for (const row of attempts.length ? attempts : [selected]) {
        const status = String(row?.responseStatus ?? "").toLowerCase();
        if (!status || status === "duplicate_guard") continue;
        const tokenId = String(row?.tokenId || selected.tokenId || "");
        const shown = num(selected.marketPrice ?? selected.entryPrice ?? selected.marketProbability);
        const bid = num(row?.orderPrice);
        const response = parsedResponse(row);
        const paid = filledPrice(response) ?? paidByToken.get(tokenId) ?? null;

        if (shown != null && bid != null) shownToBid.push(bid - shown);
        if (bid != null && paid != null) bidToPaid.push(paid - bid);

        const wanted = num(row?.orderSize);
        const got = num(response?.takingAmount);
        if (wanted != null && got != null && got > 0 && got < wanted - 0.0001) {
          sizeShortfalls.push({ question: row?.question || selected.question || "", wanted, got });
        }

        lines.push(`   ${String(run.generatedAt || run.runAt || "").slice(0, 19).padEnd(20)}`
          + ` ${String(row?.orderType || "-").padEnd(4)} ${status.padEnd(9)}`
          + `  shown ${points(shown)}  bid ${points(bid)}  paid ${points(paid)}`
          + `  ${shown != null && paid != null ? `slip ${((paid - shown) * 100).toFixed(2).padStart(6)} pts` : "slip      -    "}`
          + `  ${String(row?.question || selected.question || "").slice(0, 40)}`);
      }
    }
    console.log(`== ${portfolio.label}   limit orders ${portfolio.useLimitOrders ? "on" : "off"}`);
    if (!lines.length) console.log("   (no submitted attempt in the retained log)");
    for (const line of lines) console.log(line);
    console.log("");
  }

  const summarize = (label, values) => {
    if (!values.length) {
      console.log(`   ${label.padEnd(28)} (nothing to measure)`);
      return;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`   ${label.padEnd(28)} n=${String(values.length).padStart(3)}`
      + `  mean ${(mean * 100).toFixed(2).padStart(6)} pts`
      + `  median ${(median * 100).toFixed(2).padStart(6)} pts`
      + `  worst ${(sorted[sorted.length - 1] * 100).toFixed(2).padStart(6)} pts`);
  };

  console.log("== where the entry price moves, in percentage points");
  summarize("shown -> bid (latency)", shownToBid);
  summarize("bid -> paid (spread/depth)", bidToPaid);
  console.log("");
  console.log("   A gap on the first line is time between choosing and submitting, and is");
  console.log("   the kind of thing more speed fixes. A gap on the second is the spread and");
  console.log("   the book's depth, which speed does not remove.");
  console.log("");
  if (sizeShortfalls.length) {
    console.log(`== orders that filled smaller than they asked for (${sizeShortfalls.length})`);
    for (const row of sizeShortfalls.slice(0, 10)) {
      console.log(`   wanted ${row.wanted.toFixed(4)} got ${row.got.toFixed(4)}  ${row.question.slice(0, 50)}`);
    }
  } else {
    console.log("== no order filled smaller than it asked for, in the retained log");
  }
}

main().catch((error) => {
  console.error(`diagnosis failed: ${error?.message || error}`);
  process.exitCode = 1;
});
