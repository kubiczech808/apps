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

  console.log("\n== live-entry-claims.json for this token");
  try {
    const claims = await fetchJson(`${HOST}/data/live-entry-claims.json?t=${Date.now()}`);
    const rows = claims?.claims && typeof claims.claims === "object" ? claims.claims : {};
    console.log(`   updatedAt ${claims?.updatedAt || "-"}   ${Object.keys(rows).length} claim(s) on file total`);
    for (const tokenId of tokenIds) {
      const key = `BUY:${tokenId}`;
      const claim = rows[key];
      console.log(`   ${key.slice(0, 40)}...   ${claim ? JSON.stringify(claim) : "(no claim on file -- released, expired, or never claimed through the guard)"}`);
    }
  } catch (error) {
    console.log(`   !! ${error.message}`);
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
    console.log(`   ${portfolio.mode}${portfolio.label ? ` (${portfolio.label})` : ""}: ${hitsForPortfolio.length} matching run-log entr(y/ies)`);
    for (const hit of hitsForPortfolio.slice(0, 10)) {
      console.log(`      ${String(hit.at || "").slice(0, 19)} ${String(hit.action || "").padEnd(14)} side ${hit.side} price ${text(hit.price)} size ${text(hit.size)}`
        + `   claimed ${text(hit.claimed)}${hit.claimReason ? `   reason "${hit.claimReason}"` : ""}`);
    }
  }
  console.log("\n   Two different portfolios both showing a SUBMITTED entry for the same token means the");
  console.log("   guard let both claims through; one portfolio showing it twice means either the guard");
  console.log("   was bypassed on a retry, or the same run submitted the same candidate twice.");
}

main().catch((error) => {
  console.error(`diagnosis failed: ${error?.message || error}`);
  process.exitCode = 1;
});
