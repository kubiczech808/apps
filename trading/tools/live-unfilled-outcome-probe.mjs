// Read-only probe. Writes nothing, publishes nothing, needs no secrets.
//
// Measured: the live "Unfilled limit orders" list holds 48 rows, 0 of them graded, and 37
// of them carry an outcomeLastCheckedAt -- several stamped within the last hours. So
// refreshUnfilledLimitOrderOutcomes() is running, is selecting these rows, and is
// completing its try block (the catch path never stamps), yet finalOutcomePrice comes back
// null every single time. Something inside that block is silently answering "no price".
//
// Only three things in it can do that, and this asks Gamma which one it is, using the same
// call and the same fields the sync itself uses:
//
//   const market = await gammaMarketForOpenOrder(tokenId);            // /markets?clob_token_ids=
//   const tokenIds = parseArrayField(market.clobTokenIds).map(String);
//   const outcomeIndex = tokenIds.indexOf(tokenId);                   // (1) -1 => undefined
//   const outcomePrices = parseArrayField(market.outcomePrices)...;   // (2) empty/short
//   market.closed === true ? ... : null                              // (3) strict identity
//
// (3) is worth naming: the paper bot carries an apiBoolean() helper precisely because
// Gamma's booleans are not reliably booleans, and a string "true" fails === true.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const GAMMA = process.env.POLYMARKET_GAMMA_API || "https://gamma-api.polymarket.com";
const SAMPLE = Number(process.env.PROBE_SAMPLE || 8);

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function parseArrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const optionalNumber = (value) => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

// The paper bot's helper, quoted so the two readings can be compared side by side.
const apiBoolean = (value) => ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());

async function main() {
  console.log(`Live unfilled-order outcome probe at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no credentials are used.\n");

  const live = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const state = live?.state || live || {};
  const rows = (Array.isArray(state.unfilledLimitOrders) ? state.unfilledLimitOrders : [])
    .filter((order) => !(optionalNumber(order?.finalOutcomePrice) != null))
    .filter((order) => {
      const end = Date.parse(order?.endDate || order?.resolutionEndDate || "");
      return Number.isFinite(end) && end <= Date.now();
    })
    .sort((a, b) => (Date.parse(a.outcomeLastCheckedAt || "") || 0) - (Date.parse(b.outcomeLastCheckedAt || "") || 0))
    .slice(0, SAMPLE);

  console.log(`probing ${rows.length} of the rows the sync itself would pick next\n`);

  const verdicts = new Map();
  for (const order of rows) {
    const tokenId = String(order?.tokenId || order?.assetId || "").trim();
    console.log(`-- "${String(order.question || "").slice(0, 70)}"`);
    console.log(`   tokenId          ${tokenId}`);
    console.log(`   lastChecked      ${order.outcomeLastCheckedAt || "NEVER"}`);
    if (!tokenId) {
      console.log(`   VERDICT: no token id on the row; the sync returns early before any lookup\n`);
      verdicts.set("no token id", (verdicts.get("no token id") || 0) + 1);
      continue;
    }

    // The sync's own query is the first of these. The rest are the obvious ways a settled
    // market might still be reachable -- notably `closed=true`, which is exactly what
    // paper-trading-bot.mjs learned to pass (fetchMarketBySlugUncached loops closed
    // true-then-false) and which this lookup never does.
    const attempts = [
      ["clob_token_ids (the sync's own query)", `${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`],
      ["clob_token_ids + closed=true", `${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}&closed=true`],
      ["clob_token_ids + closed=false", `${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}&closed=false`],
      ...(order.slug ? [["slug + closed=true", `${GAMMA}/markets?slug=${encodeURIComponent(order.slug)}&closed=true`]] : []),
      ...(order.conditionId ? [["condition_ids", `${GAMMA}/markets?condition_ids=${encodeURIComponent(order.conditionId)}`]] : []),
    ];
    let market = null;
    let foundBy = null;
    for (const [label, url] of attempts) {
      let payload = null;
      try {
        payload = await fetchJson(url);
      } catch (error) {
        console.log(`   ${label.padEnd(38)} threw: ${error.message.slice(0, 60)}`);
        continue;
      }
      const hit = Array.isArray(payload) ? payload[0] : null;
      console.log(`   ${label.padEnd(38)} ${hit ? `market found (closed=${JSON.stringify(hit.closed)})` : "no market"}`);
      if (hit && !market) {
        market = hit;
        foundBy = label;
      }
    }
    if (!market) {
      console.log(`   VERDICT: no Gamma query reaches this market at all\n`);
      verdicts.set("unreachable by every query", (verdicts.get("unreachable by every query") || 0) + 1);
      continue;
    }
    if (foundBy !== attempts[0][0]) {
      console.log(`   -> the sync's own query misses it; ${foundBy} finds it`);
      verdicts.set(`only reachable via ${foundBy}`, (verdicts.get(`only reachable via ${foundBy}`) || 0) + 1);
    }

    const tokenIds = parseArrayField(market.clobTokenIds).map(String);
    const outcomeIndex = tokenIds.indexOf(tokenId);
    const outcomePrices = parseArrayField(market.outcomePrices).map((value) => optionalNumber(value));
    // Raw, with its JS type, because a string "true" is exactly the kind of thing
    // `market.closed === true` reads as not-closed.
    console.log(`   market.closed    ${JSON.stringify(market.closed)} (typeof ${typeof market.closed})`
      + `  === true -> ${market.closed === true}   apiBoolean -> ${apiBoolean(market.closed)}`);
    console.log(`   market.active    ${JSON.stringify(market.active)}   acceptingOrders ${JSON.stringify(market.acceptingOrders)}`);
    console.log(`   umaResolution    ${JSON.stringify(market.umaResolutionStatus ?? null)}`);
    console.log(`   clobTokenIds     ${tokenIds.length} entr${tokenIds.length === 1 ? "y" : "ies"}`
      + `${tokenIds.length ? ` first=${String(tokenIds[0]).slice(0, 20)}...` : ""}`);
    console.log(`   outcomeIndex     ${outcomeIndex}${outcomeIndex < 0 ? "  <- token not among the market's own tokens" : ""}`);
    console.log(`   outcomePrices    ${JSON.stringify(outcomePrices)}`);
    const finalOutcomePrice = market.closed === true ? (outcomePrices[outcomeIndex] ?? null) : null;
    console.log(`   sync would store ${JSON.stringify(finalOutcomePrice)}`);
    const wouldStoreIfLenient = apiBoolean(market.closed) ? (outcomePrices[outcomeIndex] ?? null) : null;
    console.log(`   with apiBoolean  ${JSON.stringify(wouldStoreIfLenient)}`);

    let verdict;
    if (outcomeIndex < 0) verdict = "outcomeIndex is -1";
    else if (!outcomePrices.length) verdict = "outcomePrices empty";
    else if (market.closed !== true && apiBoolean(market.closed)) verdict = "closed is truthy but not === true";
    else if (!apiBoolean(market.closed)) verdict = "market genuinely not closed yet";
    else verdict = "would have stored a price";
    console.log(`   VERDICT: ${verdict}\n`);
    verdicts.set(verdict, (verdicts.get(verdict) || 0) + 1);
  }

  console.log("== VERDICTS");
  for (const [verdict, count] of [...verdicts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(count).padStart(3)}  ${verdict}`);
  }
}

main().catch((error) => {
  console.log(`\n!! probe stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
