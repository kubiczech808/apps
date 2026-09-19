// Read-only diagnostic. Places no orders, cancels nothing, writes nothing, needs no secrets.
//
// Reported directly off the Polymarket app: two identical BUY lines for the same market --
// "Dota 2: Conventus Stellarum vs PlayTime - Game 1 Winner", "Buy 7 Conventus Stellarum at
// 73c", -$4.99, both "9h ago" -- and the account now holds double the intended size.
//
// The live executor already has a purpose-built guard against exactly this
// (submitLiveEntryWithMakerPrecisionRecovery in live-order-executor.mjs, backed by
// live_entry_claim_request in api.php): a claim keyed on tokenId+side, checked against
// whether the account already holds or rests the outcome, and against whether the account
// has been freshly read SINCE the claim was made. So this did not happen for lack of a
// guard -- either the guard was asked and let two claims through, or one of the two fills
// never went through the guard at all. This finds out which, rather than guessing:
//
//   1. which token this is, read off the live positions the account is actually holding now;
//   2. what the account's own trade history says about it -- how many fills, how far apart,
//      which side, which order/transaction;
//   3. what live-entry-claims.json says about that token -- one claim, two, or none;
//   4. which portfolio's run log(s) show a SUBMITTED/entry attempt for this token, and when,
//      so a double order from ONE portfolio can be told apart from two DIFFERENT portfolios
//      independently deciding to buy the same market.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const DATA_API = process.env.POLYMARKET_DATA_API || "https://data-api.polymarket.com";
const NEEDLE = String(process.env.DUPLICATE_SEARCH || "conventus;playtime").toLowerCase();
const NEEDLES = NEEDLE.split(";").map((s) => s.trim()).filter(Boolean);

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const text = (value) => JSON.stringify(value ?? null);
const matches = (haystack) => NEEDLES.some((needle) => String(haystack || "").toLowerCase().includes(needle));

async function main() {
  console.log(`Live duplicate-entry diagnosis at ${new Date().toISOString()}`);
  console.log(`Searching for: ${NEEDLES.join(", ")}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.\n");

  const payload = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const live = payload?.state || payload || {};
  const account = String(live.accountAddress || live.account?.address || live.funderAddress || "").trim();
  console.log(`== live state`);
  console.log(`   generatedAt ${live.generatedAt || live.updatedAt || "-"}   account ${account || "(not published)"}`);

  const positions = Array.isArray(live.positions) ? live.positions : [];
  const hits = positions.filter((row) => matches(`${row?.question} ${row?.outcome} ${row?.slug} ${row?.eventSlug}`));
  console.log(`\n== matching open position(s): ${hits.length} of ${positions.length}`);
  for (const row of hits) {
    console.log(`   "${String(row?.question || "").slice(0, 70)}" [${row?.outcome || "-"}]`);
    console.log(`      token ${String(row?.tokenId || row?.assetId || "-").slice(0, 24)}...`);
    console.log(`      shares ${text(row?.shares)}   entryPrice ${text(row?.entryPrice)}   stakeUsdc ${text(row?.stakeUsdc)}`
      + `   portfolioId ${text(row?.portfolioId)}`);
  }
  const tokenIds = [...new Set(hits.map((row) => String(row?.tokenId || row?.assetId || "").trim()).filter(Boolean))];
  if (!tokenIds.length) {
    console.log("\n!! no open position matched -- widen DUPLICATE_SEARCH, or the position has since closed");
  }

  // Reported: "limit objednavky uz zdvojene obcas cekaji na vyporadani ... u market
  // objednavek jsem si toho zatim nikdy nevsiml."
  //
  // Two bids RESTING on one token is the state that proves two separate orders were
  // placed, before any fill can blur it -- and "limit only, never market" is the
  // discriminator, because only a resting order can be culled off the book and restored.
  // A market (FAK) order never rests, so it never enters that path at all.
  const openOrders = Array.isArray(live.openOrders) ? live.openOrders : [];
  const buyOrders = openOrders.filter((row) => !String(row?.side || "").toUpperCase().includes("SELL"));
  const byToken = new Map();
  for (const row of buyOrders) {
    const key = String(row?.tokenId || row?.assetId || "").trim();
    if (!key) continue;
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key).push(row);
  }
  const doubled = [...byToken.entries()].filter(([, rows]) => rows.length > 1);
  console.log(`\n== resting BUY orders: ${buyOrders.length} on ${byToken.size} token(s), ${doubled.length} token(s) carrying MORE THAN ONE`);
  for (const [token, rows] of doubled) {
    console.log(`   token ${token.slice(0, 24)}...  "${String(rows[0]?.question || "").slice(0, 52)}"`);
    for (const row of rows) {
      console.log(`      id ${String(row?.id || row?.orderId || "-").slice(0, 20)}   price ${text(row?.price ?? row?.limitPrice)}`
        + `   size ${text(row?.originalSize ?? row?.size)}   remaining ${text(row?.remainingSize)}   created ${text(row?.createdAt)}`);
    }
    // Same price AND same size means a re-placement of one order rather than two
    // independent decisions -- the executor sizes to a stake, and a second decision at a
    // later moment would almost never land on the identical share count.
    const signature = new Set(rows.map((row) => `${text(row?.price ?? row?.limitPrice)}@${text(row?.originalSize ?? row?.size)}`));
    console.log(`      -> ${signature.size === 1 ? "IDENTICAL price and size: a re-placement of the same order" : "different price/size: two independent sizings"}`);
  }
  if (!doubled.length) console.log("   (none resting twice right now -- the doubling may already have filled)");

  // The restore path is the one BUY that never passes the entry-claim guard:
  // restoreCulledOrders -> restoreOpenOrder -> submitOrder, with no claim taken. Its input
  // is this list, so a row here whose token is ALSO resting right now is the exact
  // precondition for placing a second identical bid.
  const unfilled = Array.isArray(live.unfilledLimitOrders) ? live.unfilledLimitOrders : [];
  const restorable = unfilled.filter((row) => String(row?.status || "").toUpperCase() === "LIVE_LIMIT_ORDER_UNFILLED");
  const restingTokens = new Set(buyOrders.map((row) => String(row?.tokenId || row?.assetId || "").trim()).filter(Boolean));
  const heldTokens = new Set(positions.map((row) => String(row?.tokenId || row?.assetId || "").trim()).filter(Boolean));
  const contradicted = restorable.filter((row) => {
    const token = String(row?.tokenId || row?.assetId || "").trim();
    return token && (restingTokens.has(token) || heldTokens.has(token));
  });
  console.log(`\n== the restore queue (what "vanished" and may be put back)`);
  console.log(`   ${restorable.length} row(s) marked LIVE_LIMIT_ORDER_UNFILLED`);
  console.log(`   ${contradicted.length} of them name a token the account is resting or holding RIGHT NOW`);
  for (const row of contradicted.slice(0, 10)) {
    const token = String(row?.tokenId || row?.assetId || "").trim();
    console.log(`      "${String(row?.question || "").slice(0, 52)}"  price ${text(row?.price ?? row?.limitPrice)}`
      + `  size ${text(row?.remainingSize ?? row?.releasedSize)}  left the book ${text(row?.closedAt ?? row?.detectedAt)}`
      + `  ${restingTokens.has(token) ? "STILL RESTING" : "NOW HELD"}`);
  }

  console.log("\n== live-entry-claims.json for this token");
  let claimedByPortfolio = null;
  try {
    const claims = await fetchJson(`${HOST}/data/live-entry-claims.json?t=${Date.now()}`);
    const rows = claims?.claims && typeof claims.claims === "object" ? claims.claims : {};
    console.log(`   updatedAt ${claims?.updatedAt || "-"}   ${Object.keys(rows).length} claim(s) on file total`);
    for (const tokenId of tokenIds) {
      const key = `BUY:${tokenId}`;
      const claim = rows[key];
      console.log(`   ${key.slice(0, 40)}...   ${claim ? JSON.stringify(claim) : "(no claim on file -- released, expired, or never claimed through the guard)"}`);
      if (claim?.portfolioId) claimedByPortfolio = String(claim.portfolioId);
    }
  } catch (error) {
    console.log(`   !! ${error.message}`);
  }

  // What a SINGLE order for this portfolio should have cost -- so a fill/position total of
  // roughly double that number is measured against the portfolio's own setting, not assumed.
  if (claimedByPortfolio) {
    try {
      const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
      const config = configPayload?.config || configPayload || {};
      const id = claimedByPortfolio.replace(/^live-custom-/, "");
      const portfolio = claimedByPortfolio === "live" ? config?.live
        : claimedByPortfolio === "live5050" ? config?.live5050
        : config?.livePortfolios?.[id];
      console.log(`\n== ${claimedByPortfolio}'s own configured stake`);
      console.log(`   stakeUsdc ${text(portfolio?.stakeUsdc)}   displayName ${text(portfolio?.displayName)}`);
    } catch (error) {
      console.log(`   !! ${error.message}`);
    }
  }

  console.log("\n== the account's own trade history for this token (data-api, up to 500 rows)");
  if (account) {
    try {
      const rows = await fetchJson(`${DATA_API}/trades?user=${encodeURIComponent(account)}&limit=500&takerOnly=false`);
      const list = Array.isArray(rows) ? rows : [];
      for (const tokenId of tokenIds) {
        const fills = list.filter((row) => String(row?.asset || row?.tokenId || "") === tokenId)
          .sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));
        console.log(`   token ${tokenId.slice(0, 24)}...   ${fills.length} fill(s)`);
        let previousTs = null;
        for (const fill of fills) {
          const ts = Number(fill?.timestamp) * 1000;
          const gap = previousTs != null ? `${((ts - previousTs) / 1000).toFixed(1)}s after the previous fill` : "-";
          console.log(`      ${new Date(ts).toISOString()}   side ${fill?.side}   price ${fill?.price}   size ${fill?.size}`
            + `   tx ${String(fill?.transactionHash || "").slice(0, 14)}...   gap ${gap}`);
          previousTs = ts;
        }
        // The full row, every field data-api actually sends -- an order id, maker/taker
        // role, anything that tells apart "one order, two matched legs" (completely
        // ordinary exchange behaviour, no bug) from "two separate orders that happened to
        // settle together" (which is the thing worth chasing). Guessing the field name
        // instead of printing everything is the mistake that has already cost real time
        // in this file more than once.
        if (fills.length > 1) {
          console.log(`      full rows, for a field that tells the two fills apart:`);
          for (const fill of fills) console.log(`         ${JSON.stringify(fill)}`);
        }
      }
    } catch (error) {
      console.log(`   !! ${error.message}`);
    }
  } else {
    console.log("   (no account address published in the live state, cannot query the feed)");
  }

  console.log("\n== which portfolio(s)' run log placed an order for this token");
  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};
  const targets = [{ mode: "live", target: "live-execution" }, { mode: "live-5050", target: "live-5050-execution" }];
  for (const [id, row] of Object.entries(config?.livePortfolios || {})) {
    if (row && typeof row === "object") targets.push({ mode: `live-custom-${id}`, target: `live-custom-${id}-execution`, label: String(row.displayName || id) });
  }
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
    const hitsForPortfolio = [];
    for (const run of runs) {
      const rows = Array.isArray(run.attempts) ? run.attempts : [run.selected || run.order || {}];
      for (const row of rows) {
        const rowToken = String(row?.tokenId || "").trim();
        if (!rowToken || !tokenIds.includes(rowToken)) continue;
        hitsForPortfolio.push({ at: run.generatedAt || run.runAt, action: run.action, side: row.side, price: row.orderPrice, size: row.orderSize, claimed: run.entryClaim?.claimed, claimReason: run.entryClaim?.reason });
      }
    }
    // Every restore this portfolio performed, whatever token -- not only the searched
    // market. This is the unguarded BUY: restoreCulledOrders takes no entry claim, so a
    // restore leaves no trace in live-entry-claims.json and is invisible to every check
    // that reads it. The run log is the only place it is recorded at all.
    const restores = [];
    for (const run of runs) {
      for (const entry of (Array.isArray(run.restoredCulledOrders) ? run.restoredCulledOrders : [])) {
        restores.push({ at: run.generatedAt || run.runAt, ...entry });
      }
    }
    console.log(`   ${portfolio.mode}${portfolio.label ? ` (${portfolio.label})` : ""}:`
      + ` ${hitsForPortfolio.length} matching run-log entr(y/ies), ${restores.length} culled-order restore(s) on record`);
    for (const hit of hitsForPortfolio.slice(0, 10)) {
      console.log(`      ${String(hit.at || "").slice(0, 19)} ${String(hit.action || "").padEnd(14)} side ${hit.side} price ${text(hit.price)} size ${text(hit.size)}`
        + `   claimed ${text(hit.claimed)}${hit.claimReason ? `   reason "${hit.claimReason}"` : ""}`);
    }
    for (const restore of restores.slice(0, 10)) {
      console.log(`      RESTORE ${String(restore.at || "").slice(0, 19)}  accepted ${text(restore.accepted)}`
        + `  price ${text(restore.price)}  size ${text(restore.size)}`
        + `  left the book ${String(restore.leftBookAt || "-").slice(0, 19)}`
        + `  "${String(restore.question || "").slice(0, 44)}"`);
    }
  }
  console.log("\n   A restore re-places the ORIGINAL price and size and takes no entry claim, so if the");
  console.log("   order it is replacing was never really gone, the result is two identical resting bids");
  console.log("   that a single taker sweep fills in one transaction -- limit orders only, because a");
  console.log("   market order never rests and so can never be culled or restored.");
}

main().catch((error) => {
  console.error(`diagnosis failed: ${error?.message || error}`);
  process.exitCode = 1;
});
