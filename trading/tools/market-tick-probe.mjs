#!/usr/bin/env node
// What tick Gamma actually declares for a token, and whether it says so at all.
//
// Read-only: public GETs, no secrets, no orders.
//
// A logged tickSize of 0.01 is ambiguous in the worker today: both the real answer and the
// fallback for a lookup that failed look identical. The certainty close fires exactly when
// an outcome is already decided, which is precisely when a closed=false lookup stops
// finding the market -- so "0.01" on those sales may never have been the market's grid at
// all. This asks both halves of the list separately and says which one answered.
const GAMMA = "https://gamma-api.polymarket.com";

async function ask(tokenId, closed) {
  const url = `${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}&closed=${closed}`;
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return { ok: false, note: `HTTP ${response.status}` };
    const body = await response.json();
    const market = Array.isArray(body) ? body[0] : null;
    if (!market) return { ok: false, note: "no market returned" };
    return {
      ok: true,
      tick: market.orderPriceMinTickSize ?? null,
      closed: market.closed,
      accepting: market.acceptingOrders,
      question: String(market.question || "").slice(0, 70),
    };
  } catch (error) {
    return { ok: false, note: error.message };
  }
}

async function main() {
  const tokens = process.argv.slice(2).filter(Boolean);
  if (!tokens.length) {
    console.log("usage: market-tick-probe.mjs <tokenId> [tokenId...]");
    return 0;
  }
  for (const tokenId of tokens) {
    console.log(`\n== ${tokenId}`);
    for (const closed of ["false", "true"]) {
      const result = await ask(tokenId, closed);
      if (!result.ok) {
        console.log(`   closed=${closed.padEnd(5)} -> ${result.note}`);
        continue;
      }
      console.log(`   closed=${closed.padEnd(5)} -> tick ${result.tick ?? "(not declared)"}`
        + `  closed=${result.closed}  accepting=${result.accepting}`);
      console.log(`                   ${result.question}`);
    }
    console.log("   -> if only closed=true answered, a closed=false lookup would have"
      + " reported no tick at all, and anything defaulting to 0.01 was guessing.");
  }
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`probe failed: ${error?.stack || error}`);
  process.exit(1);
});
