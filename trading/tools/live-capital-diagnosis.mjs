// Read-only diagnostic. Writes nothing, places nothing, submits nothing.
//
// Reported: a live run skipped with "available USDC cannot cover Polymarket's current
// minimum order size" while the portfolio was believed to have free capital. The owner's
// rule is that capital available for a new order is the account total minus what is held
// in OPEN POSITIONS -- capital sitting in unfilled resting orders should not count against
// it, because an unfilled order can be cancelled and its capital comes straight back.
//
// The executor instead computes cash minus its own resting BUY notional. Whether that is
// double-counting depends on one fact this prints rather than assumes: does the CLOB
// collateral balance already exclude the notional locked by open orders? The code comments
// assert it does not. If it does, the executor subtracts the same money twice and the
// "0.41 USDC available" in the run digest is an artefact rather than the account.
//
// equity = cash + positions is the identity that settles it.
const LIVE_STATE_URL = process.env.LIVE_STATE_URL
  || "https://osobnizkusenosti.cz/trading/api.php?action=state&target=live";

const num = (value, fallback = null) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};
const money = (value) => (value == null ? "-" : `$${value.toFixed(4)}`);

// Copied from tools/live-order-executor.mjs so the diagnosis describes the executor.
const TERMINAL = new Set([
  "CANCELED", "CANCELLED", "CANCELLED_BY_USER", "FILLED", "MATCHED", "EXPIRED",
  "ORDER_STATUS_CANCELED", "ORDER_STATUS_CANCELLED", "ORDER_STATUS_FILLED", "ORDER_STATUS_EXPIRED",
]);

function liveOrders(state, side) {
  return (Array.isArray(state?.openOrders) ? state.openOrders : []).filter((order) => {
    const orderSide = String(order?.side || "BUY").toUpperCase();
    const wantsSell = side === "SELL";
    if (orderSide.includes("SELL") !== wantsSell) return false;
    const status = String(order?.status || order?.rawStatus || "").toUpperCase();
    if (TERMINAL.has(status)) return false;
    return num(order?.remainingSize ?? order?.originalSize ?? order?.size, 0) > 0.000001;
  });
}

function notionalOf(orders) {
  return orders.reduce((sum, order) => sum + (num(
    order?.notionalUsdc,
    num(order?.price, 0) * num(order?.remainingSize ?? order?.originalSize ?? order?.size, 0),
  ) ?? 0), 0);
}

async function main() {
  console.log(`Live capital diagnosis at ${new Date().toISOString()}\n`);
  const response = await fetch(LIVE_STATE_URL);
  if (!response.ok) throw new Error(`live state HTTP ${response.status}`);
  const state = await response.json();

  const portfolio = state?.portfolio || {};
  const collateral = num(state?.balanceAllowance?.collateral?.balanceUsdc);
  const cashUsdc = num(portfolio.cashUsdc);
  const equity = num(portfolio.equityUsdc);
  const marketValue = num(portfolio.marketValueUsdc);

  const buys = liveOrders(state, "BUY");
  const sells = liveOrders(state, "SELL");
  const buyNotional = notionalOf(buys);
  const positions = (Array.isArray(state?.positions) ? state.positions : []);

  console.log("ACCOUNT AS PUBLISHED");
  console.log(`  balanceAllowance.collateral   ${money(collateral)}`);
  console.log(`  portfolio.cashUsdc            ${money(cashUsdc)}`);
  console.log(`  portfolio.marketValueUsdc     ${money(marketValue)}   (${positions.length} position rows)`);
  console.log(`  portfolio.equityUsdc          ${money(equity)}`);
  console.log(`  resting BUY orders            ${money(buyNotional)}   (${buys.length} orders)`);
  console.log(`  resting SELL orders           ${sells.length}\n`);

  // The decisive test. If equity already equals cash + positions, then the cash figure is
  // the whole uncommitted balance and the resting orders are NOT deducted from it -- so
  // the executor subtracting them again is correct, and the account really is nearly
  // fully deployed. If equity is larger than cash + positions by roughly the resting
  // notional, the cash figure is already net of orders and subtracting again is a
  // double count.
  const cashSource = collateral ?? cashUsdc;
  if (cashSource != null && marketValue != null && equity != null) {
    const identity = cashSource + marketValue;
    const gap = equity - identity;
    console.log("IS THE CASH FIGURE ALREADY NET OF RESTING ORDERS?");
    console.log(`  cash + positions              ${money(identity)}`);
    console.log(`  equity                        ${money(equity)}`);
    console.log(`  equity - (cash + positions)   ${money(gap)}`);
    console.log(`  resting BUY notional          ${money(buyNotional)}`);
    if (Math.abs(gap) < 0.05) {
      console.log(`  -> the identity holds: cash is the whole uncommitted balance, resting`);
      console.log(`     orders are NOT already deducted, so the executor is not double counting.`);
      console.log(`     The account is genuinely deployed and a new order needs capital freed.`);
    } else if (Math.abs(gap - buyNotional) < Math.max(0.05, buyNotional * 0.02)) {
      console.log(`  -> the gap matches the resting notional: the published cash is ALREADY net`);
      console.log(`     of open orders, so subtracting them again understates free capital by`);
      console.log(`     ${money(buyNotional)}. That is the reported bug.`);
    } else {
      console.log(`  -> the gap matches neither; the equity figure is built from something else.`);
    }
  }

  // What each rule would allow, side by side, against a typical exchange minimum.
  const MIN_ORDER_COST = num(process.env.DIAGNOSIS_MIN_ORDER_COST, 3.5);
  console.log(`\nWHAT EACH RULE MAKES AVAILABLE (exchange minimum ~${money(MIN_ORDER_COST)})`);
  const executorRule = Math.max(0, (cashSource ?? 0) - buyNotional);
  const ownerRule = equity != null && marketValue != null ? Math.max(0, equity - marketValue) : null;
  console.log(`  executor today: cash - resting BUY notional   ${money(executorRule)}`
    + `  -> ${executorRule >= MIN_ORDER_COST ? "can order" : "SKIPS"}`);
  console.log(`  owner's rule:   equity - open positions       ${money(ownerRule)}`
    + `  -> ${ownerRule != null && ownerRule >= MIN_ORDER_COST ? "can order" : "SKIPS"}`);
  console.log(`  plain cash:                                   ${money(cashSource)}`
    + `  -> ${(cashSource ?? 0) >= MIN_ORDER_COST ? "can order" : "SKIPS"}`);

  // If the owner's rule allows an order the exchange would refuse for collateral, that is
  // worth knowing before it is adopted: the refusal costs a run, not money, but it would
  // turn a clear SKIP into a failed submission.
  if (ownerRule != null && ownerRule >= MIN_ORDER_COST && (cashSource ?? 0) < MIN_ORDER_COST) {
    console.log(`\n  !! the owner's rule would submit while the wallet holds only ${money(cashSource)}`);
    console.log(`     in uncommitted USDC. Whether that fills depends on whether Polymarket`);
    console.log(`     escrows collateral for resting bids -- the orders above are the test.`);
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
