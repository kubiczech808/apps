#!/usr/bin/env node
// Read-only. Public GETs against Gamma and against our own published catalogue. No keys, no
// writes, no orders.
//
// The question this exists to settle, and it has exactly two answers.
//
// Measured from the live executor's own run digests, same portfolio, same time of day:
//
//   12.9. 16:34  uniqueEvaluations=27  prefilterPassed=5  eligible=1  -> BUY 6.19 @ 0.80
//                prefilter: duplicate token already open x9, same event already open x7
//   17.9. 20:15  uniqueEvaluations=7   prefilterPassed=1  eligible=0
//                capital: 32.24 USDC available and unspent
//
// And on 10.9. the portfolio had 0.00 USDC of spendable cash against 14 open positions --
// fully deployed. The candidate pool fell by three quarters and a third of the account now
// sits in cash.
//
// WHY it fell is not yet known, and the two possible answers need opposite responses:
//
//   the world -- fewer esports matches are running this week, and nothing we change helps
//   us     -- the markets exist and our pipeline is not keeping them
//
// So this asks Gamma what exists right now, applies OUR scope to it in steps, and compares
// each step with what our published catalogue actually holds. Whichever number collapses
// first is the answer.
const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const GAMMA = "https://gamma-api.polymarket.com";
const HORIZON_HOURS = Number(process.env.PROBE_HORIZON_HOURS || 24);
const BAND = [Number(process.env.PROBE_BAND_MIN || 0.70), Number(process.env.PROBE_BAND_MAX || 0.80)];

async function json(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} on ${url.slice(0, 90)}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const parseMaybeJson = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// The best price on either side, which is what the band is actually compared against.
function marketProbabilities(market) {
  const prices = parseMaybeJson(market.outcomePrices).map(Number).filter(Number.isFinite);
  if (prices.length) return prices;
  const best = num(market.bestBid);
  return best == null ? [] : [best];
}

const endsAt = (row) => Date.parse(row.endDate || row.endDateIso || row.gameStartTime || "");

// EVENTS, not markets, and the markets taken from inside them.
//
// The first version asked /markets?tag_slug=esports and got 1200 rows -- exactly the page
// cap -- of which none ended within 24 hours, while our own catalogue held 107 esports
// markets that did. /markets does not filter on tag_slug, so that query was the whole
// unfiltered market list, ordered in a way that put nothing relevant in the first 1200.
// The tag lives on the event, which is also where the rest of this codebase reads it.
async function gammaEsports() {
  const markets = [];
  let cappedOut = true;
  for (let offset = 0; offset < 1500; offset += 100) {
    const page = await json(`${GAMMA}/events?closed=false&archived=false&limit=100&offset=${offset}`
      + `&tag_slug=esports`);
    if (!Array.isArray(page) || !page.length) {
      cappedOut = false;
      break;
    }
    for (const event of page) {
      for (const market of (Array.isArray(event.markets) ? event.markets : [])) {
        // The event carries the end date on a fixture; the market may not.
        markets.push({ ...market, endDate: market.endDate || event.endDate, eventSlug: event.slug });
      }
    }
    if (page.length < 100) {
      cappedOut = false;
      break;
    }
  }
  return { markets, cappedOut };
}

async function main() {
  console.log(`Esports supply gap, ${new Date().toISOString()}`);
  console.log(`Read-only. horizon <= ${HORIZON_HOURS} h, band ${(BAND[0] * 100).toFixed(0)}-${(BAND[1] * 100).toFixed(0)}%\n`);

  const now = Date.now();
  const horizon = now + HORIZON_HOURS * 3600000;

  // 1. What the world has.
  let gamma = [];
  let cappedOut = false;
  let gammaFailed = null;
  try {
    ({ markets: gamma, cappedOut } = await gammaEsports());
  } catch (error) {
    gammaFailed = error.message;
    console.log(`Gamma unreachable: ${error.message}`);
  }
  const open = gamma.filter((row) => row.closed !== true && row.active !== false);
  const soon = open.filter((row) => {
    const end = endsAt(row);
    return Number.isFinite(end) && end > now && end <= horizon;
  });
  const inBand = soon.filter((row) =>
    marketProbabilities(row).some((price) => price >= BAND[0] && price <= BAND[1]));

  // The volume floors, applied to the SAME set, so their cost is visible separately rather
  // than bundled into one "filtered" number.
  const volumeOf = (row) => num(row.volume24hr) ?? num(row.volumeNum) ?? num(row.volume) ?? 0;
  const liquidityOf = (row) => num(row.liquidityNum) ?? num(row.liquidity) ?? 0;

  console.log("== what Polymarket has right now (esports)");
  console.log(`   open esports markets                  ${open.length}${cappedOut ? "  (PAGE CAP HIT -- undercounted)" : ""}`);
  console.log(`   ... ending within ${String(HORIZON_HOURS).padStart(2)} h                 ${soon.length}`);
  console.log(`   ... and priced inside the band        ${inBand.length}`);
  console.log(`   ... and 24h volume >= $100            ${inBand.filter((row) => volumeOf(row) >= 100).length}`);
  console.log(`   ... and event liquidity >= $40 000    ${inBand.filter((row) => liquidityOf(row) >= 40000).length}`);
  console.log("");
  console.log("   The $40 000 line is the scheduled scan's floor, applied on five of every six");
  console.log("   passes. The $100 line is the executor's own minimum. If the first number is");
  console.log("   large and the last is small, the supply exists and our scope is what loses it.");

  // 2. What we hold.
  console.log("\n== what our published catalogue holds");
  try {
    const state = await json(`${HOST}/api.php?action=state&target=paper&summary=scraped&t=${Date.now()}`);
    const rows = Array.isArray(state?.marketObservations) ? state.marketObservations : [];
    const esports = rows.filter((row) => {
      const tags = [row.polymarketTags, row.tags, row.firstTags, row.eventTags, row.categoryTags]
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .map((value) => String(value?.slug ?? value?.label ?? value).toLowerCase());
      return tags.some((tag) => tag.includes("esport"))
        || /counter-strike|dota|league of legends|valorant|\bcs2\b|\blol\b/i.test(String(row.question || row.title || ""));
    });
    const held = esports.filter((row) => {
      const end = Date.parse(row.resolutionEndDate || row.endDate || "");
      return Number.isFinite(end) && end > now && end <= horizon;
    });
    const heldInBand = held.filter((row) => {
      const probability = num(row.marketProbability) ?? num(row.firstMarketProbability);
      return probability != null && probability >= BAND[0] && probability <= BAND[1];
    });
    console.log(`   catalogue rows served                 ${rows.length}`);
    console.log(`   ... esports                           ${esports.length}`);
    console.log(`   ... ending within ${String(HORIZON_HOURS).padStart(2)} h                 ${held.length}`);
    console.log(`   ... and inside the band               ${heldInBand.length}`);

    // The comparison, stated rather than left to be done by eye.
    console.log("\n== the verdict");
    // A measurement that contradicts itself is not a finding. The first run of this probe
    // announced "THE WORLD: the shortage is in the supply" off a Gamma query that had
    // returned zero markets ending within 24 hours while our own catalogue held 107 that
    // did -- a broken query stated as a confident conclusion, which is worse than no answer.
    if (gammaFailed) {
      console.log(`   INCONCLUSIVE: Gamma could not be read (${gammaFailed}).`);
    } else if (soon.length < held.length) {
      console.log(`   INCONCLUSIVE: Gamma reports ${soon.length} esports market(s) ending within`);
      console.log(`   ${HORIZON_HOURS} h while our own catalogue holds ${held.length}. We cannot hold more than`);
      console.log("   exists, so the Gamma query is wrong and no conclusion may be drawn from it.");
    } else if (!inBand.length && !heldInBand.length) {
      console.log("   Neither Gamma nor our catalogue has esports markets in this band and horizon.");
      console.log("   THE WORLD: there is nothing to trade right now. No setting we change helps.");
    } else if (heldInBand.length >= inBand.length * 0.8) {
      console.log(`   We hold ${heldInBand.length} of the ${inBand.length} that exist -- the pipeline is keeping what there is.`);
      console.log("   THE WORLD: the shortage is in the supply, not in our scope.");
    } else {
      const lost = inBand.length - heldInBand.length;
      console.log(`   Gamma has ${inBand.length} tradable esports markets in the band; we hold ${heldInBand.length}.`);
      console.log(`   US: ${lost} market(s) exist that our catalogue does not carry.`);
      const wouldSurvive = inBand.filter((row) => liquidityOf(row) >= 40000).length;
      console.log(`   Of the ${inBand.length}, only ${wouldSurvive} clear the scan's $40 000 liquidity floor.`);
      // Stated as a share of what exists, not as a share of what is missing. The two sets are
      // not nested -- every sixth scheduled pass runs untagged with no floor, so we hold some
      // rows the floor would have dropped -- and subtracting one from the other produced
      // "accounts for 142 of the 129 missing", a sentence whose own arithmetic is impossible.
      console.log(`   So the floor alone removes ${inBand.length - wouldSurvive} of the ${inBand.length} tradable markets`);
      console.log(`   (${((1 - wouldSurvive / Math.max(1, inBand.length)) * 100).toFixed(0)}%) before any portfolio rule is applied.`);
      // Volume and liquidity are different things and the floor measures the one esports is
      // worst at. A market can trade heavily on a thin resting book.
      const heavyButThin = inBand.filter((row) => volumeOf(row) >= 5000 && liquidityOf(row) < 40000);
      if (heavyButThin.length) {
        console.log(`   ${heavyButThin.length} of them traded $5 000+ in 24 h on a book under $40 000 --`);
        console.log("   actively traded markets dropped by a floor that measures resting depth.");
      }
    }

    // Named, so the next step is checking a market rather than trusting a count.
    console.log("\n== a few the band would accept right now, by liquidity");
    const sample = [...inBand].sort((left, right) => liquidityOf(right) - liquidityOf(left)).slice(0, 12);
    for (const row of sample) {
      const price = marketProbabilities(row).find((value) => value >= BAND[0] && value <= BAND[1]);
      const hours = ((endsAt(row) - now) / 3600000).toFixed(1);
      console.log(`   ${String(row.question || row.slug || "?").slice(0, 58).padEnd(58)}`
        + ` ${(price * 100).toFixed(0)}%  in ${hours.padStart(5)}h`
        + `  vol $${volumeOf(row).toFixed(0).padStart(7)}  liq $${liquidityOf(row).toFixed(0).padStart(8)}`);
    }
  } catch (error) {
    console.log(`   could not read our catalogue: ${error.message}`);
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
