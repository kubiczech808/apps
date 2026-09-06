// Read-only diagnostic. Places no orders, writes nothing, needs no secrets.
//
// Reported: two markets that were bought and sold on the account -- a completed round trip
// each, visible in Polymarket's own activity -- cannot be found in ANY live portfolio's
// closed positions.
//
// There are only a few places that can happen, and they need different fixes, so this asks
// which one it is rather than reasoning about it:
//
//   1. The account sync never produced a closed-trade row. Then the fault is upstream of
//      the dashboard and no filter change would show it.
//   2. The row exists but sits somewhere the closed list does not read -- still among the
//      open positions, or in unfilledLimitOrders.
//   3. The row exists and is attributed to a portfolio that no longer has a tab: archived,
//      deleted, or a mode string nothing matches. Every tab then filters it out and it is
//      invisible everywhere, which is the failure that looks exactly like this.
//
// It prints every row matching the search text from every collection in the live state,
// with the fields attribution is decided on.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const NEEDLES = String(process.env.CLOSED_TRADE_SEARCH || "yokohama;games total")
  .split(";").map((text) => text.trim().toLowerCase()).filter(Boolean);

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const text = (value) => JSON.stringify(value ?? null);

function matches(row) {
  const haystack = `${row?.question || ""} ${row?.market || ""} ${row?.slug || ""} ${row?.outcome || ""}`.toLowerCase();
  return NEEDLES.some((needle) => haystack.includes(needle));
}

function describe(row) {
  return `      token ${String(row?.tokenId || row?.assetId || "-").slice(0, 18)}...`
    + `  outcome ${text(row?.outcome)}  status ${text(row?.status)}`
    + `\n         entryPrice ${text(row?.entryPrice ?? row?.avgPrice ?? row?.averagePrice)}`
    + `  price ${text(row?.price ?? row?.orderPrice ?? row?.limitPrice)}`
    + `  shares ${text(row?.shares ?? row?.size)}`
    + `\n         realizedPnl ${text(row?.realizedPnlUsdc ?? row?.pnlUsdc)}`
    + `  portfolioId ${text(row?.portfolioId)}  exitReason ${text(row?.exitReason)}`
    + `  closedAt ${text(row?.closedAt ?? row?.exitRecordedAt)}`;
}

async function main() {
  console.log(`Live closed-trade lookup at ${new Date().toISOString()}`);
  console.log(`Searching for: ${NEEDLES.join(", ")}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.\n");

  const payload = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const live = payload?.liveState || payload?.state || payload || {};

  const collections = {
    positions: live.positions,
    closedTrades: live.closedTrades,
    "trades.closed": live.trades?.closed,
    unfilledLimitOrders: live.unfilledLimitOrders,
    openOrders: live.openOrders,
  };

  let found = 0;
  for (const [name, rows] of Object.entries(collections)) {
    const list = Array.isArray(rows) ? rows : [];
    const hits = list.filter(matches);
    console.log(`== ${name}: ${list.length} row(s), ${hits.length} matching`);
    for (const row of hits) {
      found += 1;
      console.log(`   "${String(row?.question || row?.market || "").slice(0, 70)}"`);
      console.log(describe(row));
    }
    if (!hits.length) console.log("   (none)");
    console.log("");
  }

  if (!found) {
    console.log("== nothing matched anywhere in the live state");
    console.log("   So the account sync never published these as rows at all, and no");
    console.log("   dashboard filter could have shown them. The fault is upstream.");
    return;
  }

  // Attribution is decided against the prices each portfolio's run log says it ordered at,
  // so the same run logs are read here -- a row whose buy price matches no logged order has
  // no owner, and one whose owner is a portfolio without a tab is filtered out everywhere.
  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};
  const targets = [
    { mode: "live", target: "live-execution", archived: false },
    { mode: "live-5050", target: "live-5050-execution", archived: config?.live5050?.archived === true },
  ];
  for (const [id, row] of Object.entries(config?.livePortfolios || {})) {
    if (!row || typeof row !== "object") continue;
    targets.push({
      mode: `live-custom-${id}`,
      target: `live-custom-${id}-execution`,
      archived: row.archived === true,
      label: String(row.displayName || id),
    });
  }

  console.log("== which portfolio's run log ordered at a price these rows could have filled at");
  for (const portfolio of targets) {
    let state = null;
    try {
      const response = await fetchJson(`${HOST}/api.php?action=state&target=${portfolio.target}&t=${Date.now()}`);
      state = response?.state || response || null;
    } catch (error) {
      console.log(`   ${portfolio.mode}: !! ${error.message}`);
      continue;
    }
    const runs = [state, ...(Array.isArray(state?.runLog) ? state.runLog : [])].filter(Boolean);
    const orders = [];
    for (const run of runs) {
      const rows = Array.isArray(run.attempts) ? run.attempts : [run.selected || run.order || {}];
      for (const row of rows) {
        if (!row?.tokenId) continue;
        if (!matches({ question: row.question, outcome: row.outcome })) continue;
        orders.push({ at: run.generatedAt || run.runAt, price: row.orderPrice, size: row.orderSize, question: row.question, action: run.action });
      }
    }
    console.log(`   ${portfolio.mode}${portfolio.archived ? " (ARCHIVED -- has no tab)" : ""}: ${orders.length} matching order(s)`);
    for (const order of orders.slice(0, 6)) {
      console.log(`      ${String(order.at || "").slice(0, 19)} ${String(order.action || "").padEnd(14)}`
        + ` price ${text(order.price)} size ${text(order.size)}  ${String(order.question || "").slice(0, 44)}`);
    }
  }
  console.log("");
  console.log("   A row whose buy price matches no logged order has no owner and falls back to");
  console.log("   the base Live portfolio. A row owned by an ARCHIVED portfolio has no tab to");
  console.log("   fall back to, so every tab filters it out and it is invisible everywhere.");
}

main().catch((error) => {
  console.error(`lookup failed: ${error?.message || error}`);
  process.exitCode = 1;
});
