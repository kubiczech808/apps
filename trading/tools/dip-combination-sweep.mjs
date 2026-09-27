// Read-only. Which (opening band x buy band) actually pays, and how often it fires.
//
// Asked for: "pomoz mi najit vhodnou kombinaci pro dip portfolio ... zda se, ze je problem
// najit kombinaci, ktera poskytne dost prilezitosti ke zobchodovani a ktere skonci v zisku".
//
// Those are two demands pulling against each other, and no single table answered both. The
// published backtest report sweeps ONE dimension -- the entry level -- against a fixed
// 70-99% opening band, so it can say which entry level paid but not which opening band, and
// it never says how OFTEN a combination would have fired. A rule that returns 9% on four
// trades in six months is not a portfolio.
//
// So this reads the backtest's own per-market cache -- the same file its report is built
// from, already published per tag -- and sweeps both bands at once, reporting the trade
// count and the monthly rate beside every return.
//
// WHY THE CACHE AND NOT A NEW BACKTEST. Each cached market already carries its opening
// price, its deepest in-play price, its resolved outcome, and the exact first-touch entry
// price and P/L at each of seven levels. Everything below is a regrouping of numbers that
// were computed once against CLOB history. It costs one HTTPS GET per tag and touches
// neither Polymarket nor the application's database.
//
// WHAT IT CANNOT SAY, printed with the output rather than buried here:
//   * The cache only computed entries for markets that opened in 70-99%. An opening band
//     BELOW 70% cannot be swept from it; that needs the backtest re-run with a wider rule.
//   * Entry levels are the ones the backtest recorded. A buy CEILING between them is not
//     available, only at them.
//   * A buy FLOOR is applied to the recorded first-touch price, so a market that gapped
//     straight through the floor is counted as no opportunity. A live rule polling every
//     minute might still catch it climbing back into the band, so the floor's trade counts
//     are a lower bound.
//   * Historical prices carry no order-book depth, so none of this proves a fill.

const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const TAGS = String(process.env.DIP_SWEEP_TAGS || "sports,esports,counter-strike-2,soccer,tennis,atp")
  .split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
const STAKE_USDC = 5;

// The levels the backtest recorded. Not a choice made here -- reading any other ceiling out
// of this cache would mean inventing an entry price that was never observed.
export const BUY_CEILINGS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

// Opening FLOORS, not slices: "70+", "75+", "80+", ... up to 95+, each one nested inside the
// one below it. Asked for after the disjoint 5-point slices this used to sweep: those
// answered "what happened to favourites that opened BETWEEN 70 and 75", which starves every
// row above 80 of volume, since a 90%+ favourite is rare to begin with. A floor keeps the
// full population at every level: "70+" is every dip candidate the rule would admit at all,
// "90+" narrows to the surest favourites without throwing away the rest of the question.
export const OPEN_FLOORS = [0.70, 0.75, 0.80, 0.85, 0.90, 0.95];
export const OPEN_CEILING = 0.99;
export function openBands(floors = OPEN_FLOORS, ceiling = OPEN_CEILING) {
  return floors.map((floor) => [floor, ceiling]);
}
// Kept for anything still asking for the old disjoint-band shape by name.
export const OPEN_BANDS = openBands();

// Five-point buy bands, each ending on a level the backtest actually recorded. The floor is
// the rule refusing a collapse that went too far to be a dip; the ceiling is the level whose
// first-touch price the cache holds. Asked for "od 45-50 az po 75-80" -- MIN_BUY_FLOOR trims
// the bottom of the grid to that by default, while leaving the deeper legacy bands reachable
// for anyone who overrides it.
export function buyBands(ceilings = BUY_CEILINGS, width = 0.05, minFloor = 0) {
  return ceilings
    .map((ceiling) => [Math.round((ceiling - width) * 100) / 100, ceiling])
    .filter(([floor]) => floor >= -1e-9 && floor >= minFloor - 1e-9);
}
const MIN_BUY_FLOOR = Math.max(0, Number(process.env.DIP_SWEEP_MIN_BUY_FLOOR ?? 0.45));

// A cell below this many opportunities is arithmetic, not a result. Asked for at 100.
const MIN_TRADES = Math.max(1, Number(process.env.DIP_SWEEP_MIN_TRADES || 100));

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

// Every market the cache finished and could price an opening for. `status` and
// `usableOpening` both matter: an unusable opening is a market whose earliest CLOB quote is
// not an opening at all, and counting it would put mid-game prices in an opening band.
export function cacheRows(cache) {
  const markets = cache && typeof cache.markets === "object" && cache.markets ? cache.markets : {};
  return Object.values(markets).filter((row) => row && row.status === "complete" && row.usableOpening);
}

// The trade a cell would have taken, or null. Both bounds are INCLUSIVE: a band is a
// setting a person types into the form, and silently dropping its edges would answer a
// slightly different question than the one asked.
export function entryForCell(row, ceiling, floor = 0) {
  const opening = num(row?.openingPrice);
  if (opening == null) return null;
  const entry = row?.entries?.[String(ceiling)];
  if (!entry) return null;
  const price = num(entry.entryPrice);
  if (price == null) return null;
  // The floor is the rule refusing to buy a collapse that went too far to be a dip. Applied
  // to the price actually touched first, which is the only price the cache observed.
  if (floor > 0 && price + 1e-9 < floor) return null;
  return entry;
}

export function inOpenBand(row, [min, max]) {
  const opening = num(row?.openingPrice);
  return opening != null && opening + 1e-9 >= min && opening - 1e-9 <= max;
}

export function cellStats(entries, stake = STAKE_USDC) {
  const trades = entries.length;
  const wins = entries.filter((entry) => entry.outcome === "WIN").length;
  const fees = entries.reduce((sum, entry) => sum + (num(entry.feeUsdc) || 0), 0);
  const pnl = entries.reduce((sum, entry) => sum + (num(entry.pnlUsdc) || 0), 0);
  const staked = trades * stake + fees;
  // The mean price the winners were bought at, recovered from the payout rather than
  // averaged: sum(stake/p) over winners = pnl + staked. It is what the win rate has to beat
  // for the combination to be more than a coin flip priced correctly.
  const impliedWinnerEntry = pnl + staked > 0 && wins > 0 ? (stake * wins) / (pnl + staked) : null;
  return {
    trades,
    wins,
    accuracy: trades ? (wins / trades) * 100 : null,
    stakedUsdc: staked,
    feesUsdc: fees,
    pnlUsdc: pnl,
    roiPct: staked > 0 ? (pnl / staked) * 100 : null,
    impliedWinnerEntryPct: impliedWinnerEntry == null ? null : impliedWinnerEntry * 100,
  };
}

// How long the cached markets span, so a trade count can be read as a rate. "12 trades" is
// unreadable without it: over a fortnight it is a working portfolio, over two years it is
// nothing.
export function spanDays(rows) {
  const times = rows
    .map((row) => Date.parse(String(row?.resolvedAt || "")))
    .filter((value) => Number.isFinite(value));
  if (times.length < 2) return null;
  const days = (Math.max(...times) - Math.min(...times)) / 86400000;
  return days > 0 ? days : null;
}

export function sweep(rows, { openBands = OPEN_BANDS, bands = buyBands() } = {}) {
  const days = spanDays(rows);
  const cells = [];
  for (const band of openBands) {
    const inBand = rows.filter((row) => inOpenBand(row, band));
    for (const [floor, ceiling] of bands) {
      // Inverted, or a single price rather than a band. Neither is a setting anyone means,
      // and emitting them pads the grid with cells that can never fire.
      if (floor >= ceiling) continue;
      const entries = inBand.map((row) => entryForCell(row, ceiling, floor)).filter(Boolean);
      const stats = cellStats(entries);
      cells.push({
        openMin: band[0],
        openMax: band[1],
        buyMin: floor,
        buyMax: ceiling,
        marketsInOpenBand: inBand.length,
        ...stats,
        // What the win rate has to beat. Printed as its own column because it, and not the
        // return, is what separates an edge from a run of luck on a small cell.
        edgePoints: stats.accuracy == null || stats.impliedWinnerEntryPct == null
          ? null
          : stats.accuracy - stats.impliedWinnerEntryPct,
        tradesPerMonth: days ? (stats.trades / days) * 30 : null,
      });
    }
  }
  return cells;
}

// A combination is worth proposing only if it clears both demands at once. Ranked by return
// rather than by profit: a cell that trades ten times as often will always win on nominal
// P/L and says nothing about whether the rule is any good.
export function shortlist(cells, minTrades = MIN_TRADES) {
  return cells
    .filter((cell) => cell.trades >= minTrades && (cell.roiPct ?? -Infinity) > 0)
    .sort((left, right) => (right.roiPct ?? -Infinity) - (left.roiPct ?? -Infinity));
}

// The raw markets behind one cell, not the aggregate. Built for the moment a cell's edge is
// implausibly large: an 80%+ favourite winning 90%+ of the time after falling to 45-50% is
// either a genuine, extreme inefficiency or a handful of stale prints with no depth behind
// them, and the aggregate cannot tell those apart. Only the raw rows can.
export function sampleCell(rows, band, [floor, ceiling], limit = 10) {
  const inBand = rows.filter((row) => inOpenBand(row, band));
  const hits = [];
  for (const row of inBand) {
    const entry = entryForCell(row, ceiling, floor);
    if (entry) hits.push({ row, entry });
  }
  return hits.slice(0, limit).map(({ row, entry }) => ({
    question: row.question,
    slug: row.slug,
    openingAt: row.openingAt,
    openingPrice: row.openingPrice,
    lowestInPlayAt: row.lowestInPlayAt,
    lowestInPlayPrice: row.lowestInPlayPrice,
    enteredAt: entry.enteredAt,
    entryPrice: entry.entryPrice,
    pnlUsdc: entry.pnlUsdc,
    outcome: entry.outcome,
    resolvedAt: row.resolvedAt,
    finalOutcomePrice: row.finalOutcomePrice,
  }));
}

async function loadCache(tag) {
  const url = `${HOST}/data/dip-backtest-${tag}-cache.json`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return { tag, rows: [], missing: true, status: response.status };
  const text = await response.text();
  try {
    return { tag, rows: cacheRows(JSON.parse(text)), missing: false };
  } catch (error) {
    return { tag, rows: [], missing: true, status: `unparsable: ${String(error?.message || error).slice(0, 80)}` };
  }
}

const pct = (value, places = 1) => (value == null ? "     -" : `${value.toFixed(places)}`.padStart(6));
const int = (value, width = 5) => String(value ?? "-").padStart(width);

const HEADER = "    open band   buy band   trades   /month   win%    price%    edge    ROI%      P/L";

// "70-99" reads as a slice; "70+" reads as what it is -- a floor with everything above it.
function openLabel(cell) {
  return cell.openMax >= OPEN_CEILING - 1e-9 ? `${(cell.openMin * 100).toFixed(0)}+` : `${(cell.openMin * 100).toFixed(0)}-${(cell.openMax * 100).toFixed(0)}`;
}

function printRow(cell, prefix = "   ") {
  const open = openLabel(cell).padStart(9);
  const buy = `${(cell.buyMin * 100).toFixed(0)}-${(cell.buyMax * 100).toFixed(0)}`.padStart(8);
  console.log(`${prefix} ${open}  ${buy}  ${int(cell.trades, 6)}   ${pct(cell.tradesPerMonth)}  ${pct(cell.accuracy)}  ${pct(cell.impliedWinnerEntryPct)}  ${pct(cell.edgePoints)}  ${pct(cell.roiPct, 2)}  ${pct(cell.pnlUsdc, 2)}`);
}

function printGrid(label, rows) {
  const days = spanDays(rows);
  console.log(`\n=== ${label} -- ${rows.length} usable market(s)`
    + `${days ? `, spanning ${days.toFixed(0)} day(s)` : ", span unknown"} ===`);
  if (!rows.length) return [];
  // Floors are nested, not disjoint: "70+" already contains every row "75+" does and more, so
  // there is no separate "whole population" row needed any more -- it IS the first floor.
  const cells = sweep(rows, { bands: buyBands(BUY_CEILINGS, 0.05, MIN_BUY_FLOOR) });
  const shown = cells.filter((cell) => cell.trades >= MIN_TRADES);
  console.log(`\n  cells with at least ${MIN_TRADES} opportunities`
    + `  (${cells.length - shown.length} of ${cells.length} suppressed as too thin)`);
  console.log(HEADER);
  if (!shown.length) console.log("      (none -- no cell of this tag reaches the floor)");
  let lastFloor = null;
  for (const cell of shown) {
    // A blank line between floors, since each is a different, larger population than the
    // one above it and reading them as one continuous table invites comparing rows that are
    // not measuring the same thing.
    if (lastFloor !== null && cell.openMin !== lastFloor) console.log("");
    lastFloor = cell.openMin;
    printRow(cell);
  }
  return cells;
}

async function main() {
  console.log(`Dip combination sweep at ${new Date().toISOString()}`);
  console.log("Read-only: one published cache file per tag. No CLOB, no database, no writes.\n");

  const loaded = [];
  for (const tag of TAGS) loaded.push(await loadCache(tag));
  for (const entry of loaded) {
    console.log(`   ${entry.tag.padEnd(20)} ${entry.missing ? `no cache (${entry.status})` : `${entry.rows.length} usable market(s)`}`);
  }

  const present = loaded.filter((entry) => !entry.missing && entry.rows.length);
  if (!present.length) {
    console.log("\nNo cache has any usable market. Run Trading DIP History Backtest for a tag first.");
    return;
  }

  const perTag = new Map();
  for (const entry of present) perTag.set(entry.tag, printGrid(entry.tag, entry.rows));

  // Pooled by token, not by concatenation: a market carrying both `sports` and `soccer`
  // appears in both caches, and counting it twice would inflate every pooled cell and make
  // the opportunity floor pass on duplicates.
  const byToken = new Map();
  for (const entry of present) for (const row of entry.rows) byToken.set(String(row.tokenId || ""), row);
  const pooled = [...byToken.values()];
  const pooledCells = present.length > 1 ? printGrid("ALL TAGS (deduplicated by market)", pooled) : [];

  // Last, because the log is read from the end: the combinations that clear both demands.
  const ranked = [];
  for (const [tag, cells] of perTag) for (const cell of shortlist(cells)) ranked.push({ tag, ...cell });
  for (const cell of shortlist(pooledCells)) ranked.push({ tag: "POOLED", ...cell });
  ranked.sort((left, right) => (right.roiPct ?? -Infinity) - (left.roiPct ?? -Infinity));

  console.log(`\n\n=== combinations with at least ${MIN_TRADES} opportunities AND a positive return ===`);
  if (!ranked.length) {
    console.log("   (none -- every profitable cell is below the opportunity floor, or every cell with volume loses)");
  }
  console.log(`    tag              ${HEADER.trimStart()}`);
  for (const cell of ranked.slice(0, 30)) {
    printRow(cell, `    ${String(cell.tag).padEnd(16)}`);
  }
  console.log("\n   price% is the mean price the winners were bought at, and edge is win% minus it.");
  console.log("   An edge near zero is a fairly priced bet that the fee turns into a loss, however");
  console.log("   the ROI column happens to land. Opening bands below 70% are absent by");
  console.log("   construction: the cache never priced them.");

  // Optional: the raw markets behind one cell, printed only when asked for. An edge this
  // large asks to be checked before it is believed, and the aggregate alone cannot say
  // whether it is real or a handful of stale, depth-less prints.
  const sampleTag = String(process.env.DIP_SWEEP_SAMPLE_TAG || "").trim().toLowerCase();
  const sampleFloor = Number(process.env.DIP_SWEEP_SAMPLE_OPEN_FLOOR);
  const sampleBuyMin = Number(process.env.DIP_SWEEP_SAMPLE_BUY_MIN);
  const sampleBuyMax = Number(process.env.DIP_SWEEP_SAMPLE_BUY_MAX);
  if (sampleTag && Number.isFinite(sampleFloor) && Number.isFinite(sampleBuyMin) && Number.isFinite(sampleBuyMax)) {
    const entry = present.find((item) => item.tag === sampleTag);
    console.log(`\n\n=== sample: ${sampleTag} ${(sampleFloor * 100).toFixed(0)}+ / `
      + `${(sampleBuyMin * 100).toFixed(0)}-${(sampleBuyMax * 100).toFixed(0)} ===`);
    if (!entry) {
      console.log(`   tag "${sampleTag}" was not loaded (check DIP_SWEEP_TAGS includes it)`);
    } else {
      const rows = sampleCell(entry.rows, [sampleFloor, OPEN_CEILING], [sampleBuyMin, sampleBuyMax],
        Math.max(1, Math.min(50, Number(process.env.DIP_SWEEP_SAMPLE_LIMIT) || 10)));
      if (!rows.length) console.log("   (no market in this cell)");
      for (const row of rows) {
        console.log(`   ${String(row.question).slice(0, 70)}`);
        console.log(`      slug          ${row.slug}`);
        console.log(`      opened        ${row.openingAt}  at ${row.openingPrice}`);
        console.log(`      lowest touch  ${row.lowestInPlayAt}  at ${row.lowestInPlayPrice}`);
        console.log(`      entry         ${row.enteredAt}  at ${row.entryPrice}  pnl ${row.pnlUsdc}  ${row.outcome}`);
        console.log(`      resolved      ${row.resolvedAt}  final ${row.finalOutcomePrice}`);
        console.log("");
      }
    }
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Sweep failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
