// Read-only. How a probability band would have done on RESOLVED markets carrying a given
// tag, broken down by market shape and by when the entry would have been taken. Writes
// nothing, places nothing, uses no credentials.
//
// Asked for: "ukaz mi statistiku dle typu/tvaru na 51-60 s tagem dota-2 at uz z toho naseho
// paper portfolia nebo celkove nasich resolved dota-2 udalosti", and "kdy nastavit vstup,
// jak u tohoto nastaveni vychazi underway vs nejakou dobu dopredu".
//
// WHY THE OBSERVATIONS AND NOT THE TRADES. The trades cannot answer it. A paper trade never
// stored the market's tags (fixed today, so the record starts now), and it is in any case
// only the handful of markets a portfolio happened to take. The resolved observation archive
// has every market the scan ever saw settle, WITH its tags and its settlement price -- so
// the question "how does 51-60% do on dota-2" can be asked of the whole population instead
// of a sample of it.
//
// WHAT THIS IS NOT. It is a simulation over recorded quotes, not a record of trades:
//
//   * the entry price is a quote the scan stored, not a fill. No spread is crossed and no
//     fee is charged, so every figure here is BETTER than the same strategy would have done.
//   * a market is counted once, at one price. A real portfolio has finite capital and takes
//     some of these and not others.
//
// Both are stated in the output too, because a table of returns invites being read as a
// backtest and this is not one.

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const TAG = (process.env.MARKET_TAG || "dota").trim().toLowerCase();
const MIN_PROBABILITY = Number(process.env.MIN_PROBABILITY || 0.51);
const MAX_PROBABILITY = Number(process.env.MAX_PROBABILITY || 0.60);
const STAKE = Number(process.env.STAKE_USDC || 5);

async function fetchJson(url, label) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const pct = (value) => (value == null ? "   -  " : `${(value * 100).toFixed(1)}%`.padStart(6));
const money = (value) => (value == null ? "     -" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`.padStart(7));

// Shape, from the question. Same classification the bot applies, restated here so this tool
// does not import the whole bot to read one regex.
const SHAPE_PATTERNS = [
  [/\b(o\/u|over\/under|over-under|total(s)?\b|totals?:)/i, "over-under"],
  [/\bspread\b|\([-+]\d/i, "spread"],
  [/\bexact score\b/i, "exact-score"],
  [/\bdraw\b/i, "draw"],
  [/\b(map|game|round|set|inning|quarter|half)\s*\d/i, "in-event-leg"],
  [/\bboth teams\b/i, "both-teams"],
];
export function shapeOf(question) {
  const text = String(question || "");
  for (const [pattern, label] of SHAPE_PATTERNS) if (pattern.test(text)) return label;
  return "outright";
}

// Does this row belong to the tag being asked about? Tags first, and the question text as a
// fallback -- a market titled "Dota 2: ..." is a dota-2 market whether or not the tag
// survived into the archive, and refusing it because a field is missing would answer a
// different question from the one asked.
export function matchesTag(row, tag) {
  for (const field of ["polymarketTags", "firstPolymarketTags", "tags", "polymarketCategories"]) {
    const value = row?.[field];
    if (!Array.isArray(value)) continue;
    for (const raw of value) {
      const text = String(raw?.slug || raw?.label || raw?.name || raw || "").toLowerCase();
      if (text.includes(tag)) return "tag";
    }
  }
  const question = String(row?.question || row?.market || "").toLowerCase();
  return question.includes(tag) ? "question" : null;
}

// How the market settled. Anything that is not a clean 0 or 1 is not a settlement of this
// outcome and is skipped rather than guessed at -- the same rule api.php applies.
export function settlement(row) {
  const price = num(row?.finalOutcomePrice);
  if (price == null) return null;
  if (price >= 0.995) return 1;
  if (price <= 0.005) return 0;
  return null;
}

// The price an entry would have been taken at. Preference order, and the tool reports which
// one it actually used for how many rows: a settled book prints 0 or 1, so reading
// marketProbability off a resolved row would "enter" every winner at 100% and every loser at
// 0% and report a flawless strategy.
const ENTRY_FIELDS = ["firstMarketProbability", "lastLiveMarketProbability", "marketProbability"];
export function entryPrice(row) {
  for (const field of ENTRY_FIELDS) {
    const value = num(row?.[field]);
    if (value != null && value > 0 && value < 1) return { price: value, field };
  }
  return { price: null, field: null };
}

// Before the fixture began, or after it was under way? The question is "underway vs nejakou
// dobu dopredu", and it can only be answered where both times are on the row.
export function entryTiming(row) {
  const seen = Date.parse(row?.firstObservedAt || row?.observedAt || "");
  const kickoff = Date.parse(row?.eventStartTime || row?.scheduledEventDate || "");
  if (!Number.isFinite(seen) || !Number.isFinite(kickoff)) return "unknown";
  return seen < kickoff ? "before kickoff" : "under way";
}

function volumeBucket(value) {
  if (value == null) return "unknown";
  if (value < 1000) return "a <1k";
  if (value < 5000) return "b 1-5k";
  if (value < 25000) return "c 5-25k";
  if (value < 100000) return "d 25-100k";
  return "e 100k+";
}

// One market, one simulated entry at a fixed stake. No fee and no spread: see the header.
export function simulate(row, stake = STAKE) {
  const { price } = entryPrice(row);
  const outcome = settlement(row);
  if (price == null || outcome == null) return null;
  const shares = stake / price;
  const pnl = outcome === 1 ? shares - stake : -stake;
  return { price, outcome, pnl, stake };
}

export function summarise(rows) {
  if (!rows.length) return { n: 0, wins: 0, winRate: null, pnl: 0, perTrade: null, perDollar: null };
  const pnl = rows.reduce((sum, row) => sum + row.sim.pnl, 0);
  const staked = rows.reduce((sum, row) => sum + row.sim.stake, 0);
  const wins = rows.filter((row) => row.sim.outcome === 1).length;
  return {
    n: rows.length,
    wins,
    winRate: wins / rows.length,
    pnl,
    perTrade: pnl / rows.length,
    perDollar: staked > 0 ? pnl / staked : null,
  };
}

function printTable(title, groups) {
  console.log(`\n   ${title}`);
  console.log("      bucket          n   won    win%      P/L    per trade   per $ staked");
  for (const [label, rows] of [...groups.entries()].sort((a, b) => summarise(b[1]).pnl - summarise(a[1]).pnl)) {
    const s = summarise(rows);
    console.log(`      ${String(label).padEnd(14)} ${String(s.n).padStart(3)}  ${String(s.wins).padStart(4)}`
      + `  ${pct(s.winRate)}  ${money(s.pnl)}     ${money(s.perTrade)}      ${pct(s.perDollar)}`
      + `${s.n < 10 ? "  (thin)" : ""}`);
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

async function loadResolved() {
  const rows = [];
  for (let offset = 0; offset < 24000; offset += 1200) {
    let payload;
    try {
      payload = await fetchJson(
        `${HOST}/api.php?action=state&target=paper&summary=scraped&scope=resolved&offset=${offset}`,
        `resolved observations @${offset}`,
      );
    } catch (error) {
      console.log(`   !! stopped at offset ${offset}: ${error.message}`);
      break;
    }
    const state = payload?.state || payload || {};
    // BOTH keys. A scope=resolved page does not come back under
    // resolvedMarketObservations: compact_state_payload filters the archive into $rows and
    // assigns `$active = $rows`, so both scopes are published under the SAME key. Reading
    // only the resolved-sounding one returned 0 rows from an archive that has thousands,
    // and the tool reported "nothing to analyse" as though that were the answer.
    const page = [
      ...(Array.isArray(state.marketObservations) ? state.marketObservations : []),
      ...(Array.isArray(state.resolvedMarketObservations) ? state.resolvedMarketObservations : []),
    ];
    if (!page.length) break;
    rows.push(...page);
    if (page.length < 1200) break;
  }
  return rows;
}

async function main() {
  console.log(`Resolved-market analysis at ${new Date().toISOString()}`);
  console.log(`   tag "${TAG}", entry band ${pct(MIN_PROBABILITY)}-${pct(MAX_PROBABILITY)}, stake ${STAKE} USDC`);
  console.log("   Read-only. A SIMULATION over recorded quotes, not a record of trades:");
  console.log("   no spread is crossed and no fee is charged, so every figure below is");
  console.log("   BETTER than the same strategy would really have done.\n");

  const all = await loadResolved();
  console.log(`== 1. what is on record\n   ${all.length} resolved observation(s)`);
  if (!all.length) {
    console.log("   Nothing to analyse.");
    return;
  }

  // Field coverage, before any conclusion rests on a field. Measured rather than assumed:
  // the retained-field list in api.php is not obviously the same as what production holds.
  const coverage = (field, test) => all.filter(test).length;
  console.log("\n   field coverage across those rows:");
  for (const field of [...ENTRY_FIELDS, "finalOutcomePrice", "firstObservedAt", "observedAt",
    "eventStartTime", "scheduledEventDate", "polymarketTags", "tags", "volumeUsdc"]) {
    const have = coverage(field, (row) => {
      const value = row?.[field];
      return Array.isArray(value) ? value.length > 0 : value != null && value !== "";
    });
    console.log(`      ${field.padEnd(28)} ${String(have).padStart(5)} / ${all.length}`);
  }

  const tagged = all.map((row) => ({ row, via: matchesTag(row, TAG) })).filter((item) => item.via);
  const viaTag = tagged.filter((item) => item.via === "tag").length;
  console.log(`\n== 2. rows matching "${TAG}"\n   ${tagged.length} matched`
    + ` (${viaTag} by tag, ${tagged.length - viaTag} by question text only)`);
  if (!tagged.length) {
    console.log("   Nothing matched, so there is nothing to break down.");
    return;
  }

  const inBand = [];
  const usedField = new Map();
  let noSettlement = 0;
  let outOfBand = 0;
  for (const { row } of tagged) {
    const { price, field } = entryPrice(row);
    if (price == null) continue;
    if (settlement(row) == null) { noSettlement += 1; continue; }
    if (price < MIN_PROBABILITY || price > MAX_PROBABILITY) { outOfBand += 1; continue; }
    const sim = simulate(row);
    if (!sim) continue;
    usedField.set(field, (usedField.get(field) || 0) + 1);
    inBand.push({ row, sim, shape: shapeOf(row.question || row.market), timing: entryTiming(row) });
  }
  console.log(`\n== 3. inside the band\n   ${inBand.length} of ${tagged.length} matched rows priced`
    + ` ${pct(MIN_PROBABILITY)}-${pct(MAX_PROBABILITY)}`);
  console.log(`   ${outOfBand} were priced outside it, ${noSettlement} never settled to a clean 0 or 1`);
  console.log(`   entry price taken from: ${[...usedField.entries()].map(([f, n]) => `${f} (${n})`).join(", ") || "-"}`);
  if (!inBand.length) {
    console.log("   Nothing in the band, so there is nothing to break down.");
    return;
  }

  const overall = summarise(inBand);
  console.log(`\n   overall: ${overall.n} markets, ${overall.wins} won (${pct(overall.winRate)}),`
    + ` P/L ${money(overall.pnl)}, ${money(overall.perTrade)} per market, ${pct(overall.perDollar)} per dollar`);

  printTable("by MARKET SHAPE", groupBy(inBand, (item) => item.shape));
  printTable("by ENTRY TIMING  (the 'underway vs before' question)", groupBy(inBand, (item) => item.timing));
  printTable("by VOLUME", groupBy(inBand, (item) => volumeBucket(num(item.row.volumeUsdc ?? item.row.liquidity))));

  const known = inBand.filter((item) => item.timing !== "unknown");
  if (!known.length) {
    console.log("\n   No row carries both a first-seen time and a kickoff, so the timing question");
    console.log("   cannot be answered from this archive. The split above is a single 'unknown'.");
  } else {
    console.log(`\n   shape x timing, on the ${known.length} row(s) whose timing is known:`);
    printTable("shape x timing", groupBy(known, (item) => `${item.shape} / ${item.timing}`));
  }

  // ---------------------------------------------------------------------------------------
  // Asked separately: "kdyz pomineme 51-60 a jen urcite shapes na dota-2, bude hrat roli
  // nastaveni casu vstupu? treba jen underway?"
  //
  // The band is dropped here on purpose. Inside a narrow band, timing and price are
  // entangled -- a fixture already under way is priced by what has happened in it, so
  // "under way AND 51-60%" is a different kind of market from "before kickoff AND 51-60%",
  // and comparing them compares the fixtures as much as the timing. Across the whole range
  // the question is the one that was actually asked: does WHEN you enter matter at all.
  const everything = [];
  for (const { row } of tagged) {
    const sim = simulate(row);
    if (!sim) continue;
    everything.push({ row, sim, shape: shapeOf(row.question || row.market), timing: entryTiming(row) });
  }
  console.log("\n\n========================================================================");
  console.log("== 4. DOES ENTRY TIMING MATTER, IGNORING THE BAND?");
  console.log("========================================================================");
  console.log(`   Every settled "${TAG}" market with a usable entry price, at any probability.`);
  console.log(`   ${everything.length} market(s).`);
  const timed = everything.filter((item) => item.timing !== "unknown");
  if (!timed.length) {
    console.log("   None of them carries both a first-seen time and a kickoff, so timing cannot");
    console.log("   be answered from this archive at all -- not for this band and not for any.");
    return;
  }
  console.log(`   ${timed.length} carry both a first-seen time and a kickoff.`);
  printTable("by TIMING, whole probability range", groupBy(timed, (item) => item.timing));
  printTable("by TIMING x SHAPE", groupBy(timed, (item) => `${item.shape} / ${item.timing}`));
  // And where in the price range each timing actually puts you, which is the thing that
  // makes a raw timing comparison misleading on its own.
  printTable("by TIMING x entry price", groupBy(timed, (item) => {
    const price = item.sim.price;
    const band = price < 0.3 ? "<30%" : price < 0.5 ? "30-50%" : price < 0.7 ? "50-70%" : "70%+";
    return `${band} / ${item.timing}`;
  }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Analysis failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
