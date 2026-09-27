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
// Empty means RANK EVERY TAG, which is the tool's default question. It used to fall back to
// "dota", so passing an empty tag from the workflow silently re-ran the single-tag analysis
// -- the workflow's default was changed and this fallback was not, and the run looked
// successful while answering the previous question.
const TAG = String(process.env.MARKET_TAG || "").trim().toLowerCase();
// Blank means NO band, not a default one. A tool that quietly substitutes 0.51-0.60 for an
// empty input answers a question nobody asked -- the same fault the tag fallback had.
const optionalBound = (value, fallback) => {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : fallback;
};
const MIN_PROBABILITY = optionalBound(process.env.MIN_PROBABILITY, 0.01);
const MAX_PROBABILITY = optionalBound(process.env.MAX_PROBABILITY, 0.99);
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

// Could this entry have been taken at all?
//
// A settled row only teaches us about an entry that was still POSSIBLE when we first
// recorded it. Some catalogue rows were first stored AFTER Polymarket's stated resolution
// time and still carried a non-final quote -- a price from after the result was effectively
// known. Counting those is hindsight, not a configuration anyone could have run, and it is
// what produces impossible win rates.
//
// This is a line-for-line port of resolved_stats_entry_is_not_after_due() in api.php,
// including its field order and its "no time on the row means keep it" default, so the two
// answers cannot drift. That guard exists because the Setup finder once reported valorant at
// 100.0% over 36 trades when the tag's real record was 65-21, 75.6%.
export function entryWasStillPossible(row) {
  let seen = null;
  for (const field of ["firstObservedAt", "firstEvaluatedAt", "observedAt", "evaluatedAt"]) {
    const parsed = Date.parse(String(row?.[field] ?? ""));
    if (Number.isFinite(parsed) && parsed > 0) { seen = parsed; break; }
  }
  if (seen === null) return true;
  for (const field of ["resolutionEndDate", "endDate"]) {
    const due = Date.parse(String(row?.[field] ?? ""));
    if (Number.isFinite(due) && due > 0) return due > seen;
  }
  return true;
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

// Finer than the coarse timing split: this is the band a portfolio would be SET to, so it
// has to be readable at the resolution a person types.
const PRICE_EDGES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9, 1.0];
export function priceBand(price) {
  if (price == null) return "unknown";
  for (let i = 0; i < PRICE_EDGES.length - 1; i += 1) {
    if (price >= PRICE_EDGES[i] && price < PRICE_EDGES[i + 1]) {
      return `${(PRICE_EDGES[i] * 100).toFixed(0)}-${(PRICE_EDGES[i + 1] * 100).toFixed(0)}%`;
    }
  }
  return price < PRICE_EDGES[0] ? "<10%" : "100%";
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

// Every tag a row carries, as the union of the fields that hold them. Used for ranking,
// where a market belongs under each of its tags.
export function tagsOf(row) {
  const tags = new Set();
  for (const field of ["polymarketTags", "firstPolymarketTags", "tags", "polymarketCategories"]) {
    const value = row?.[field];
    if (!Array.isArray(value)) continue;
    for (const raw of value) {
      const tag = String(raw?.slug || raw?.label || raw?.name || raw || "").trim().toLowerCase();
      if (tag) tags.add(tag);
    }
  }
  return tags.size ? [...tags] : ["(untagged)"];
}

// What share of a tag's winnings came from its single best market.
//
// Without this the ranking is a lottery-ticket detector. Buying a 2% outcome that lands pays
// 49x the stake, so ONE such market can carry a tag's whole P/L and print as an edge. A tag
// whose top trade is most of its profit is a tag with one lucky row, not a strategy.
export function topTradeShare(rows) {
  const gains = rows.map((row) => row.sim.pnl).filter((pnl) => pnl > 0).sort((a, b) => b - a);
  const total = gains.reduce((sum, pnl) => sum + pnl, 0);
  return total > 0 ? gains[0] / total : null;
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

  // No tag named, or "*": rank every tag instead of analysing one. Asked for: "udelej mi
  // jednoduchou analyzu dle tagu z nasich resolved dat, co vychazi nejlepe."
  if (!TAG || TAG === "*") {
    rankTags(all);
    return;
  }

  const matchedAll = all.map((row) => ({ row, via: matchesTag(row, TAG) })).filter((item) => item.via);
  const tagged = matchedAll.filter((item) => entryWasStillPossible(item.row));
  const droppedHindsight = matchedAll.length - tagged.length;
  const viaTag = tagged.filter((item) => item.via === "tag").length;
  console.log(`\n== 2. rows matching "${TAG}"\n   ${tagged.length} matched`
    + ` (${viaTag} by tag, ${tagged.length - viaTag} by question text only)`);
  console.log(`   ${droppedHindsight} further row(s) were first seen AFTER their own resolution`);
  console.log("   time and are dropped: that is hindsight, not an entry anyone could take.");
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
  // The tables a portfolio setting is actually chosen from, over the whole range.
  printTable("by ENTRY PRICE BAND, whole range", groupBy(everything, (item) => priceBand(item.sim.price)));
  printTable("by MARKET SHAPE, whole range", groupBy(everything, (item) => item.shape));
  printTable("by VOLUME, whole range",
    groupBy(everything, (item) => volumeBucket(num(item.row.volumeUsdc ?? item.row.liquidity))));
  printTable("by SHAPE x entry price band",
    groupBy(everything, (item) => `${item.shape} / ${priceBand(item.sim.price)}`));

  printTable("by TIMING x entry price", groupBy(timed, (item) => {
    const price = item.sim.price;
    const band = price < 0.3 ? "<30%" : price < 0.5 ? "30-50%" : price < 0.7 ? "50-70%" : "70%+";
    return `${band} / ${item.timing}`;
  }));
}

// Every tag, ranked. One simulated entry per market at the quote we recorded, settled at
// the real outcome. A market belongs under each of its tags, so the rows overlap and the P/L
// column does not sum to a total.
function rankTags(all) {
  const simulated = [];
  let unusable = 0;
  let hindsight = 0;
  for (const row of all) {
    const sim = simulate(row);
    if (!sim) { unusable += 1; continue; }
    // The guard, applied before anything is counted.
    if (!entryWasStillPossible(row)) { hindsight += 1; continue; }
    simulated.push({ row, sim, shape: shapeOf(row.question || row.market), tags: tagsOf(row) });
  }
  console.log(`\n== 2. every tag, ranked`);
  console.log(`   ${simulated.length} of ${all.length} markets have both a usable entry price`);
  console.log(`   and a clean settlement; ${unusable} do not and are left out.`);
  console.log(`   ${hindsight} more were FIRST SEEN AFTER their own resolution time and are`);
  console.log("   dropped: a quote recorded after the result was effectively known is not an");
  console.log("   entry anyone could have taken, and counting it invents wins out of nothing.");
  const overall = summarise(simulated);
  console.log(`   Whole archive: ${overall.n} markets, ${pct(overall.winRate)} won,`
    + ` P/L ${money(overall.pnl)}, ${pct(overall.perDollar)} per dollar staked.`);

  const groups = new Map();
  for (const item of simulated) {
    for (const tag of item.tags) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(item);
    }
  }
  const MIN_ROWS = 15;
  const ranked = [...groups.entries()]
    .filter(([, rows]) => rows.length >= MIN_ROWS)
    .sort((a, b) => summarise(b[1]).pnl - summarise(a[1]).pnl);
  const thin = groups.size - ranked.length;

  console.log(`\n   ${groups.size} distinct tag(s); ${ranked.length} carry at least ${MIN_ROWS} markets.`);
  console.log(`   ${thin} are thinner than that and are not listed -- a handful of markets is`);
  console.log("   not a result, and listing them would put the noisiest rows at the top.");
  console.log("   A market appears under each of its tags, so these rows overlap.");
  console.log("\n   top% is the share of the tag's winnings that came from its single best");
  console.log("   market. Buying a 2% outcome that lands pays 49x, so one lucky row can carry");
  console.log("   a whole tag; a high top% is one market, not an edge.");
  console.log("\n   tag                          n   won    win%      P/L    per trade   per $   top%");
  for (const [tag, rows] of ranked) {
    const s = summarise(rows);
    const share = topTradeShare(rows);
    console.log(`   ${tag.slice(0, 26).padEnd(26)} ${String(s.n).padStart(4)}  ${String(s.wins).padStart(4)}`
      + `  ${pct(s.winRate)}  ${money(s.pnl)}     ${money(s.perTrade)}  ${pct(s.perDollar)}`
      + `  ${pct(share)}${share != null && share > 0.5 ? "  <- one market" : ""}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Analysis failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
