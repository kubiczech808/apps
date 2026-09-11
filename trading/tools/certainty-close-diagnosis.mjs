// Read-only diagnostic. Writes nothing, publishes nothing, needs no secrets.
//
// Reported: the certainty close does not fire. Positions the market prices at 100%, waiting
// only for settlement, sit there until they are sold by hand.
//
// The rule is one line in rpi-live-exit-worker.mjs:
//
//     if (closeBid != null && bid != null && bid >= closeBid) return "settlement";
//
// so there are only a few places it can be failing, and they are worth separating before
// anything is changed:
//
//   1. the setting is not stored. "Close at certainty" was reported zeroing itself once
//      already, so the first question is whether the portfolio actually carries a value.
//   2. the position is not watched. The worker only looks at tokens the policy payload
//      names, and a position whose portfolio has no policy at all is never polled.
//   3. the setting is stored and the position is watched, but THE BID NEVER REACHES IT.
//      This is the one this is really asking about. The trigger compares the best BID
//      against the setting, and a market pricing an outcome at "100%" does not necessarily
//      have a bid at 0.999 -- somebody has to be willing to pay 99.9c for something worth
//      1.00, which is a tenth of a percent for the wait. If the book's top bid is 0.97
//      while the setting is 0.999, the rule is correct, the wiring is correct, and it can
//      never fire.
//
// So this prints, for every open live position: what the policy says, what the book says,
// and which of the three it is.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const CLOB = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";

async function fetchJson(url, label) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pct = (value) => (value == null ? "  -   " : `${(value * 100).toFixed(1)}%`.padStart(6));

async function bookFor(tokenId) {
  try {
    const book = await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, `book ${tokenId}`);
    const bids = (Array.isArray(book?.bids) ? book.bids : []).map((row) => num(row?.price ?? row?.p)).filter((price) => price != null);
    const asks = (Array.isArray(book?.asks) ? book.asks : []).map((row) => num(row?.price ?? row?.p)).filter((price) => price != null);
    return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null };
  } catch (error) {
    return { bid: null, ask: null, error: error?.message || String(error) };
  }
}

async function tickFor(tokenId) {
  try {
    const url = new URL("https://gamma-api.polymarket.com/markets");
    url.searchParams.append("clob_token_ids", String(tokenId));
    url.searchParams.set("closed", "false");
    const markets = await fetchJson(url, `gamma ${tokenId}`);
    const market = Array.isArray(markets) ? markets[0] : null;
    return num(market?.orderPriceMinTickSize);
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Certainty-close diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const [config, live, policy] = await Promise.all([
    fetchJson(`${HOST}/api.php?action=portfolio-config`, "portfolio config"),
    fetchJson(`${HOST}/api.php?action=state&target=live`, "live state"),
    fetchJson(`${HOST}/api.php?action=live-exit-policy`, "exit policy"),
  ]);
  const saved = config?.config || config || {};

  console.log("== 1. is the setting actually stored, per live portfolio");
  const portfolios = [
    ["live", saved.live],
    ["live5050", saved.live5050],
    ...Object.entries(saved.livePortfolios || {}).map(([id, row]) => [`live-custom-${id}`, row]),
  ];
  for (const [id, row] of portfolios) {
    if (!row || typeof row !== "object") {
      console.log(`   ${id.padEnd(24)} (no configuration)`);
      continue;
    }
    const closeBid = num(row.settlementCloseBid);
    console.log(`   ${id.padEnd(24)} name ${String(row.displayName || "-").slice(0, 22).padEnd(24)}`
      + ` settlementCloseBid ${closeBid == null || closeBid <= 0 ? "NOT SET" : closeBid}`
      + `   automation ${row.automationEnabled === false ? "off" : "on"}`
      + `   archived ${row.archived === true ? "yes" : "no"}`);
  }

  console.log("\n== 2. what the worker is told to watch");
  const policies = new Map((Array.isArray(policy?.policies) ? policy.policies : [])
    .map((row) => [String(row.tokenId), row]));
  const excluded = new Map((Array.isArray(policy?.excluded) ? policy.excluded : [])
    .map((row) => [String(row.tokenId), row]));
  const fallback = policy?.defaultPolicy || null;
  console.log(`   policies ${policies.size}   excluded ${excluded.size}`
    + `   defaultPolicy settlementCloseBid ${fallback ? (num(fallback.settlementCloseBid) ?? "-") : "(none)"}`);

  const positions = (Array.isArray(live?.positions) ? live.positions : [])
    .filter((row) => String(row?.tokenId || row?.assetId || "").trim())
    .filter((row) => !["CLOSED", "LOST", "WON", "REDEEM_REQUIRED", "SOLD"].includes(String(row.status || "").toUpperCase()));
  console.log(`   open positions in the live state: ${positions.length}`);

  console.log("\n== 3. every open position: the setting, the book, and which of the three it is");
  console.log("   status            close   bid     ask    tick    verdict");
  const verdicts = new Map();
  for (const position of positions) {
    const tokenId = String(position.tokenId || position.assetId);
    const row = policies.get(tokenId) || fallback;
    const closeBid = row ? num(row.settlementCloseBid) : null;
    const [book, tick] = await Promise.all([bookFor(tokenId), tickFor(tokenId)]);
    let verdict;
    if (excluded.has(tokenId)) verdict = `NOT WATCHED: ${excluded.get(tokenId).reason || "excluded"}`;
    else if (!row) verdict = "NOT WATCHED: no policy covers this token";
    else if (closeBid == null || closeBid <= 0) verdict = "SETTING NOT SET for the owning portfolio";
    else if (book.bid == null) verdict = "no bid in the book at all";
    else if (book.bid >= closeBid) verdict = "WOULD FIRE -- the bid is at or above the setting";
    else {
      // The interesting case, and the reason this file exists: how far the book is from the
      // level, and whether the tick grid even allows a bid that high.
      const reachable = tick != null && tick > 0 ? Math.round((1 - tick) * 10000) / 10000 : null;
      verdict = `bid is ${((closeBid - book.bid) * 100).toFixed(1)} points BELOW the setting`
        + (reachable != null && reachable < closeBid
          ? ` -- and the ${tick} tick caps any bid at ${reachable}, so it can NEVER fire`
          : "");
    }
    verdicts.set(verdict.split(" --")[0].split(":")[0], (verdicts.get(verdict.split(" --")[0].split(":")[0]) || 0) + 1);
    console.log(`   ${String(position.status || "-").padEnd(18)}${pct(closeBid)} ${pct(book.bid)} ${pct(book.ask)}`
      + `  ${String(tick ?? "-").padEnd(6)} ${verdict}`);
    console.log(`      "${String(position.question || "").slice(0, 62)}" [${position.outcome || "-"}]`
      + `   entry ${num(position.entryPrice) ?? "-"}   shares ${num(position.shares) ?? "-"}`);
  }

  console.log("\n== 4. the tally");
  if (!positions.length) console.log("   no open live position to judge");
  for (const [verdict, count] of [...verdicts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(4)}  ${verdict}`);
  }
  console.log("\n   A position that WOULD FIRE and has not been sold points at the worker --");
  console.log("   its mode, or its own state file. Everything else is answered above.");
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
