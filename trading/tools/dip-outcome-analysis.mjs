// Read-only. How the dip portfolios' RESOLVED trades did, broken down by the parameters a
// portfolio can actually be set to. Writes nothing, places nothing, uses no credentials.
//
// Asked for: "chci vedet na zaklade resolved dat, jak si vedou dle parametru, ktere mohu v
// portfoliu nastavit. tzn. typy trhu jako outright, pocatecni volumes, probability na
// kterych do trhu vstupuji, vuci tomu, jaka je ta jejich pocatecni - jestli ji nenastavit na
// jinou nez 70+ hodnotu."
//
// THE JOIN, and why this tool is not a one-liner. A paper trade records its entry price, its
// entry volume, its tags and its question -- but NOT the probability the market opened at.
// paperTradeFromCandidate copies named fields and firstMarketProbability is not among them.
// So the headline question cannot be answered from the trades alone: the opening price has
// to be recovered from the observation catalogue, by token, and joined back on.
//
// TWO WARNINGS THAT DECIDE HOW THE NUMBERS MAY BE READ, printed with the output rather than
// buried here:
//
//   1. firstMarketProbability means "what this row was quoted at the first time the scan
//      stored it", not "where the market opened". For a fixture the scan first met while it
//      was already being played, it is a mid-game price. Every trade opened before
//      2026-09-26 was selected on that number without anything checking which kind it was.
//      So this tool splits every opening-band bucket into VERIFIED (first seen before
//      kickoff, so it really is an opening price) and MID-GAME (first seen after kickoff,
//      so the number means nothing). A recommendation about the opening band can only come
//      from the verified half.
//   2. A bucket of a handful of trades is not a result. Counts are printed beside every
//      figure and small ones are marked, because the temptation with a table like this is to
//      read the best-looking row.
import { marketShape } from "./paper-trading-bot.mjs";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const FOCUS = (process.env.DIP_PORTFOLIO || "").trim().toLowerCase();
const PAGE = 1200;

async function fetchJson(url, label) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pct = (value) => (value == null ? "   -  " : `${(value * 100).toFixed(1)}%`.padStart(6));
const money = (value) => (value == null ? "     -" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`.padStart(7));

const CLOSED = new Set(["CLOSED", "WON", "LOST", "REDEEMED", "RESOLVED", "SETTLED", "STOP_LOSS_SOLD"]);

// Every observation the catalogue still holds, by token: the opening price the rule gated
// on, and the two times that say whether that price is an opening price at all.
async function loadObservations() {
  const byToken = new Map();
  for (const scope of ["active", "resolved"]) {
    for (let offset = 0; offset < 12000; offset += PAGE) {
      let payload;
      try {
        // `scope` and `offset`, which are the names api.php actually reads. The first
        // version of this sent scrapedScope/observationsLimit/observationsOffset -- the
        // internal parameter names, not the query ones -- so every request silently
        // returned page one of the ACTIVE catalogue, the resolved archive was never read,
        // and the join found an opening price for 0 of 373 resolved trades. The page size
        // is the server's (SCRAPED_SCOPE_PAGE_LIMIT) and is not settable by the caller.
        payload = await fetchJson(
          `${HOST}/api.php?action=state&target=paper&summary=scraped&scope=${scope}&offset=${offset}`,
          `observations ${scope}@${offset}`,
        );
      } catch (error) {
        console.log(`   !! ${scope} observations stopped at offset ${offset}: ${error.message}`);
        break;
      }
      const state = payload?.state || payload || {};
      const rows = [
        ...(Array.isArray(state.marketObservations) ? state.marketObservations : []),
        ...(Array.isArray(state.resolvedMarketObservations) ? state.resolvedMarketObservations : []),
      ];
      if (!rows.length) break;
      for (const row of rows) {
        for (const field of ["tokenId", "clobTokenId", "assetId"]) {
          const token = String(row?.[field] || "").trim();
          if (!token || byToken.has(token)) continue;
          byToken.set(token, {
            opened: num(row.firstMarketProbability),
            firstObservedAt: row.firstObservedAt || row.observedAt || null,
            eventStartTime: row.eventStartTime || row.scheduledEventDate || null,
            volumeUsdc: num(row.volumeUsdc ?? row.liquidity),
          });
        }
      }
      if (rows.length < PAGE) break;
    }
  }
  return byToken;
}

// Was that price taken BEFORE the fixture began? The same question dipEntryOpeningIsVerifiable
// asks, restated here so this tool stays readable on its own.
export function openingIsVerified(observation) {
  const first = Date.parse(observation?.firstObservedAt || "");
  const kickoff = Date.parse(observation?.eventStartTime || "");
  if (!Number.isFinite(first) || !Number.isFinite(kickoff)) return null;
  return first < kickoff;
}

export function bucketOf(value, edges) {
  if (value == null) return "unknown";
  for (let index = 0; index < edges.length - 1; index += 1) {
    if (value >= edges[index] && value < edges[index + 1]) {
      return `${(edges[index] * 100).toFixed(0)}-${(edges[index + 1] * 100).toFixed(0)}%`;
    }
  }
  return value >= edges[edges.length - 1] ? `${(edges[edges.length - 1] * 100).toFixed(0)}%+` : "below";
}

export function volumeBucket(value) {
  if (value == null) return "unknown";
  if (value < 1000) return "a <1k";
  if (value < 5000) return "b 1-5k";
  if (value < 25000) return "c 5-25k";
  if (value < 100000) return "d 25-100k";
  return "e 100k+";
}

// n, wins, P/L and P/L per dollar staked. Per-dollar matters because the stake is fixed per
// portfolio but the cost of a trade is not: a 30% entry buys three times the shares a 90%
// entry does, so raw P/L flatters cheap entries.
export function summarise(rows) {
  const staked = rows.reduce((sum, row) => sum + (num(row.totalCostUsdc) ?? num(row.stakeUsdc) ?? 0), 0);
  const pnl = rows.reduce((sum, row) => sum + (num(row.realizedPnlUsdc) ?? 0), 0);
  const wins = rows.filter((row) => (num(row.realizedPnlUsdc) ?? 0) > 0).length;
  return {
    n: rows.length,
    wins,
    winRate: rows.length ? wins / rows.length : null,
    pnl,
    perTrade: rows.length ? pnl / rows.length : null,
    perDollar: staked > 0 ? pnl / staked : null,
  };
}

function printTable(title, groups) {
  console.log(`\n   ${title}`);
  console.log("      bucket          n   won    win%      P/L    per trade   per $ staked");
  for (const [label, rows] of [...groups.entries()].sort()) {
    const s = summarise(rows);
    const thin = s.n < 10 ? "  (thin)" : "";
    console.log(`      ${label.padEnd(14)} ${String(s.n).padStart(3)}  ${String(s.wins).padStart(4)}`
      + `  ${pct(s.winRate)}  ${money(s.pnl)}     ${money(s.perTrade)}      ${pct(s.perDollar)}${thin}`);
  }
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

async function main() {
  console.log(`Dip portfolio outcome analysis at ${new Date().toISOString()}`);
  console.log("Read-only: nothing is written, no orders, no credentials.\n");

  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config`, "portfolio config");
  const paper = (config?.config || config || {}).paper || {};
  const carriers = Object.entries(paper).filter(([id, row]) => {
    if (!row || typeof row !== "object") return false;
    const name = String(row.displayName || id).toLowerCase();
    if (FOCUS) return name.includes(FOCUS) || id.toLowerCase() === FOCUS;
    return row.dipEntryEnabled || name.includes("dip");
  });
  if (!carriers.length) {
    console.log("No dip portfolio matched. Nothing to analyse.");
    return;
  }
  console.log(`== portfolios in scope (${carriers.length})`);
  for (const [id, row] of carriers) {
    console.log(`   ${id.padEnd(18)} "${row.displayName || id}"  buys ${pct(num(row.minProbability))}-${pct(num(row.maxProbability))}`
      + `  opens ${pct(num(row.dipEntryOpenMin))}-${pct(num(row.dipEntryOpenMax))}`
      + `  dipRule ${row.dipEntryEnabled ? "on" : "OFF"}  archived ${row.archived ? "yes" : "no"}`);
  }

  console.log("\n== recovering opening prices from the observation catalogue");
  const observations = await loadObservations();
  console.log(`   ${observations.size} token(s) with a stored observation`);

  const everything = [];
  for (const [id, row] of carriers) {
    let trades = [];
    try {
      const state = await fetchJson(
        `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`,
        `paper state ${id}`,
      );
      const portfolios = (state?.state || state)?.paperPortfolios || {};
      const held = portfolios[id] || {};
      trades = [
        ...(Array.isArray(held.trades) ? held.trades : []),
        ...(Array.isArray(held.closedTrades) ? held.closedTrades : []),
      ];
    } catch (error) {
      console.log(`\n   ${id}: !! ${error.message}`);
      continue;
    }
    const resolved = trades.filter((trade) => CLOSED.has(String(trade.status || "").toUpperCase())
      && num(trade.realizedPnlUsdc) != null);
    console.log(`\n== ${id} "${row.displayName || id}": ${trades.length} trade(s), ${resolved.length} resolved`);
    if (!resolved.length) {
      console.log("   nothing resolved to analyse yet");
      continue;
    }
    const enriched = resolved.map((trade) => {
      const observation = observations.get(String(trade.tokenId || "")) || {};
      return {
        ...trade,
        portfolioId: id,
        openedProbability: observation.opened ?? null,
        openingVerified: openingIsVerified(observation),
        shape: marketShape(trade),
        entryVolume: num(trade.entryVolumeUsdc) ?? observation.volumeUsdc ?? null,
      };
    });
    everything.push(...enriched);

    const s = summarise(enriched);
    console.log(`   overall: ${s.n} resolved, ${s.wins} won (${pct(s.winRate)}), P/L ${money(s.pnl)},`
      + ` ${money(s.perTrade)} per trade, ${pct(s.perDollar)} per dollar staked`);
    const known = enriched.filter((trade) => trade.openedProbability != null).length;
    const verified = enriched.filter((trade) => trade.openingVerified === true).length;
    console.log(`   opening price recovered for ${known}/${s.n}; of those, ${verified} were first seen BEFORE kickoff`);

    printTable("by ENTRY probability (the portfolio's own range)",
      groupBy(enriched, (trade) => bucketOf(num(trade.entryPrice), [0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.56, 0.6, 0.7])));
    printTable("by MARKET SHAPE", groupBy(enriched, (trade) => trade.shape));
    printTable("by ENTRY VOLUME", groupBy(enriched, (trade) => volumeBucket(trade.entryVolume)));
  }

  if (everything.length) {
    console.log("\n\n== ALL THREE POOLED - the opening band, which is the question");
    console.log("   Split by whether the opening price is one at all. Only the verified half");
    console.log("   can support a decision about where to set the band.");
    const verified = everything.filter((trade) => trade.openingVerified === true);
    const midGame = everything.filter((trade) => trade.openingVerified === false);
    const unknown = everything.filter((trade) => trade.openingVerified == null);
    console.log(`\n   ${verified.length} verified, ${midGame.length} first seen mid-game, ${unknown.length} undecidable`);

    const band = (trade) => bucketOf(trade.openedProbability, [0.3, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]);
    if (verified.length) printTable("VERIFIED opening price, by opening band", groupBy(verified, band));
    if (midGame.length) {
      printTable("MID-GAME 'opening' price, by band  (NOT evidence about the band)", groupBy(midGame, band));
      console.log("      ^ these rows describe trades selected on a number that never meant");
      console.log("        what it claimed. They are printed to show how much of the record");
      console.log("        they account for, not to be read as a result.");
    }
    printTable("ALL resolved, by entry probability", groupBy(everything,
      (trade) => bucketOf(num(trade.entryPrice), [0.2, 0.3, 0.35, 0.4, 0.45, 0.5, 0.56, 0.6, 0.7])));
    printTable("ALL resolved, by market shape", groupBy(everything, (trade) => trade.shape));
    printTable("ALL resolved, by entry volume", groupBy(everything, (trade) => volumeBucket(trade.entryVolume)));
  }
}

// Only when run as a command. Importing this file to test its arithmetic must not fire a
// hundred HTTPS reads at the host.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Analysis failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
