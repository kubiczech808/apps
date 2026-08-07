// Read-only check: for every token the live portfolio currently holds or has
// resting, print what the CLOB says about neg risk next to what our own stored
// records say.
//
// This exists because a wrong neg-risk flag is invisible until an order is
// refused: it selects the exchange contract used as the EIP-712 verifying
// contract, so signing a neg-risk market against the plain exchange produces an
// order hash the CLOB does not reproduce, and the only symptom is
// "invalid POLY_1271 signature: signature does not match order hash".
//
// Places no orders and needs no credentials -- both endpoints are public GETs.

const CLOB_HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const LIVE_STATE_URL = process.env.LIVE_STATE_URL || "";

async function getJson(url, label) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
  return response.json();
}

// The compact market payload keys its fields `mts` (tick size), `mos` (min order
// size) and `nr` (neg risk). Reading `negRisk` off it silently yields undefined.
async function clobMarketNegRisk(conditionId) {
  if (!conditionId) return { nr: null, note: "no condition id" };
  try {
    const market = await getJson(new URL(`/clob-markets/${conditionId}`, CLOB_HOST), "clob-markets");
    return { nr: market?.nr ?? null, keys: Object.keys(market || {}).join(","), note: "" };
  } catch (error) {
    return { nr: null, note: error.message };
  }
}

async function tokenNegRisk(tokenId) {
  if (!tokenId) return { negRisk: null, note: "no token id" };
  try {
    const result = await getJson(new URL(`/neg-risk?token_id=${tokenId}`, CLOB_HOST), "neg-risk");
    return { negRisk: result?.neg_risk ?? null, note: "" };
  } catch (error) {
    return { negRisk: null, note: error.message };
  }
}

function storedNegRisk(record) {
  const value = record?.negRisk ?? record?.orderSnapshot?.negRisk;
  return typeof value === "boolean" ? value : null;
}

async function main() {
  if (!LIVE_STATE_URL) throw new Error("LIVE_STATE_URL is required");
  const liveState = await getJson(LIVE_STATE_URL, "live state");

  const rows = [
    ...(liveState.positions || []).map((item) => ({ kind: "position", item })),
    ...(liveState.openOrders || []).map((item) => ({ kind: "open order", item })),
  ].filter(({ item }) => item?.tokenId || item?.assetId);

  console.log("=== NEG RISK DIAGNOSTIC ===");
  if (!rows.length) console.log("no open positions or resting orders to check");

  let mismatches = 0;
  for (const { kind, item } of rows) {
    const tokenId = String(item.tokenId || item.assetId);
    const conditionId = item.conditionId || item.market || "";
    const [market, token] = await Promise.all([clobMarketNegRisk(conditionId), tokenNegRisk(tokenId)]);
    const stored = storedNegRisk(item);
    const truth = typeof token.negRisk === "boolean" ? token.negRisk : market.nr;
    // The failure mode is specifically "the CLOB says neg risk, we said it is not".
    const wrong = truth === true && stored === false;
    if (wrong) mismatches += 1;
    const label = String(item.question || "").slice(0, 52) || tokenId;
    console.log(`${kind.padEnd(10)} ${label}`);
    console.log(`  token       : ${tokenId}`);
    console.log(`  clob /neg-risk        : ${token.negRisk} ${token.note}`);
    console.log(`  clob /clob-markets nr : ${market.nr} ${market.note}`);
    console.log(`  our stored negRisk    : ${stored}`);
    console.log(`  verdict     : ${wrong ? "MISMATCH - an order signed from the stored value would be refused" : "consistent"}`);
  }
  console.log(`mismatches  : ${mismatches}`);
  console.log("=== END NEG RISK DIAGNOSTIC ===");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
