// Read-only. Public GETs against Polymarket's public APIs, no keys, no writes.
//
// Asked because the certainty close sold at 0.99 for the fourth time and the worker's own
// event log refutes the explanation I had just committed:
//
//   "Games Total: O/U 3.5"  bestBid 0.99  settlementCloseBid 0.999
//   settlementCloseBidInForce 0.99  marketTick 0.01  declaredTick 0.01  observedTick 0.01
//
// declaredTick 0.01 means the Gamma lookup did NOT fail -- Gamma answered, and it answered
// 0.01. So "an unknown tick fell back to the book" is not what happened here.
//
// And the same log holds four sales that FILLED at 0.999 on markets Gamma also declared at
// 0.01 (Atlante/Pachuca, Missouri/Kansas, Team Nemesis, Boston College) -- in each of those
// the book happened to be quoting 0.999, so the book, not Gamma, carried the finer grid.
//
// Which makes the open question: what does the exchange ITSELF enforce? The order executor
// already asks the CLOB (/clob-markets/{conditionId} -> mts) and only falls back to Gamma;
// the exit worker asks Gamma alone. This prints all of them side by side for the tokens
// that actually sold, so the next fix is chosen from measurement instead of a third guess.
const CLOB = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const GAMMA = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";

// Each of these is a real sale or refusal from the worker's retained event history.
const TOKENS = [
  ["Games Total: O/U 3.5 (Over)", "40135636771341807086343266882804236111907598997089201361044713543663191056013", "sold 0.99, declared 0.01, observed 0.01"],
  ["Will Club Necaxa win on 2026-09-11? (No)", "101333938763946898041359407170227153168231812340400512047889772793009020179368", "sold 0.99, declared 0.01, observed 0.01"],
  ["Counter-Strike: NRG vs Liquid - Map 1 (NRG)", "49103086335843746943080464065606384548362481119622285970929490209234841502009", "sold 0.99, declared 0.01, observed 0.01"],
  ["Atlante FC vs. CF Pachuca: BTTS (No)", "105192300182382912803607005424809406920416157616746372406904535287416705947764", "FILLED 0.999, declared 0.01, observed 0.001"],
  ["Missouri vs. Kansas: O/U 59.5 (Under)", "41566298752627186900689873316461461020554990865931268617545249352122098672371", "FILLED 0.999, declared 0.01, observed 0.001"],
  ["Spread: Boston College (-10.5) (Rutgers)", "13752732952183784887892240670011155093695859771911986081846556046532097836790", "FILLED 0.999, declared 0.01, observed 0.001"],
  ["Counter-Strike: ShindeN vs Fluxo W7M", "72245798338877459932125160509082456228346658574448978951203304392248546697997", "trigger tick 0.001 but the ORDER went out tick 0.01 px 0.99"],
];

async function getJson(url, label) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) return { error: `${label}: HTTP ${response.status}` };
  return { value: await response.json() };
}

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// The same inference the worker runs on the book, repeated here so the printout can be
// compared against what the worker decided at the moment of the sale.
function observedBookTick(book) {
  const rows = [...(book?.bids || []), ...(book?.asks || [])];
  const prices = rows.map((row) => number(row?.price)).filter((price) => price != null && price > 0);
  if (!prices.length) return null;
  for (const tick of [0.01, 0.001, 0.0001]) {
    if (prices.every((price) => Math.abs(price / tick - Math.round(price / tick)) < 1e-6)) return tick;
  }
  return 0.0001;
}

for (const [name, tokenId, history] of TOKENS) {
  console.log("");
  console.log(`== ${name}`);
  console.log(`   at the time: ${history}`);

  // 1. The CLOB's own per-token answer. This is the number the exchange enforces when an
  //    order is priced, and it is the one nobody has asked for yet.
  const tickSize = await getJson(`${CLOB}/tick-size?token_id=${encodeURIComponent(tokenId)}`, "CLOB tick-size");
  console.log(`   CLOB /tick-size          ${tickSize.error || JSON.stringify(tickSize.value)}`);

  // 2. Gamma's orderPriceMinTickSize -- the only source the exit worker consults today.
  const gamma = await getJson(`${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`, "Gamma markets");
  const market = Array.isArray(gamma.value) ? gamma.value[0] : null;
  console.log(`   Gamma orderPriceMinTick  ${gamma.error || JSON.stringify(market?.orderPriceMinTickSize ?? null)}`
    + `   closed=${JSON.stringify(market?.closed ?? null)}  bestBid=${JSON.stringify(market?.bestBid ?? null)}`);

  // 3. /clob-markets/{conditionId}.mts -- what the ORDER EXECUTOR uses. If this disagrees
  //    with Gamma, the trigger and the order have been pricing off different grids.
  const conditionId = market?.conditionId || market?.condition_id || null;
  if (conditionId) {
    const clobMarket = await getJson(`${CLOB}/clob-markets/${conditionId}`, "CLOB clob-markets");
    const row = clobMarket.value;
    console.log(`   CLOB /clob-markets mts   ${clobMarket.error || JSON.stringify(row?.mts ?? row?.minimum_tick_size ?? null)}`
      + `   nr=${JSON.stringify(row?.nr ?? null)}`);
  } else {
    console.log("   CLOB /clob-markets mts   (no conditionId in the Gamma row)");
  }

  // 4. And the book right now, so the observed grid can be compared with all three.
  const book = await getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, "CLOB book");
  const bids = book.value?.bids || [];
  const asks = book.value?.asks || [];
  const bestBid = bids.length ? Math.max(...bids.map((row) => number(row.price) ?? 0)) : null;
  const bestAsk = asks.length ? Math.min(...asks.map((row) => number(row.price) ?? 1)) : null;
  console.log(`   book observed tick       ${book.error || JSON.stringify(observedBookTick(book.value))}`
    + `   bestBid=${JSON.stringify(bestBid)}  bestAsk=${JSON.stringify(bestAsk)}  levels=${bids.length}/${asks.length}`);
}

console.log("");
console.log("Read this as: whichever source answers 0.001 on a market that FILLED at 0.999 is");
console.log("telling the truth about the grid, and whichever answers 0.01 there is not a bound");
console.log("the certainty close may lower itself to.");
