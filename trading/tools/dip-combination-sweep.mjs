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
//   * Entry levels are the seven the backtest recorded. A buy CEILING between them is not
//     available, only at them.
//   * A buy FLOOR is applied to the recorded first-touch price, so a market that gapped
//     straight through the floor is counted as no opportunity. A live rule polling every
//     minute might still catch it climbing back into the band, so the floor's trade counts
//     are a lower bound.
//   * Historical prices carry no order-book depth, so none of this proves a fill.

const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const TAGS = String(process.env.DIP_SWEEP_TAGS || "esports,counter-strike-2,soccer,league-of-legends,dota-2,valorant")
  .split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
const STAKE_USDC = 5;

// The seven the backtest recorded. Not a choice made here -- reading any other ceiling out
// of this cache would mean inventing an entry price that was never observed.
export const BUY_CEILINGS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];

// Opening bands worth separating. The rule's default is 70-80; the report's fixed band is
// 70-99. Everything between is the question -- "is a 78% favourite that collapses a better
// bet than a 92% one" is not answerable from a single pooled band.
export const OPEN_BANDS = [
  [0.70, 0.80], [0.70, 0.85], [0.70, 0.90], [0.70, 0.99],
  [0.75, 0.85], [0.80, 0.90], [0.80, 0.99], [0.85, 0.99], [0.90, 0.99],
];

const BUY_FLOORS = String(process.env.DIP_SWEEP_BUY_FLOORS || "0,0.2,0.25,0.3")
  .split(",").map((entry) => Number(entry)).filter((value) => Number.isFinite(value) && value >= 0 && value < 1);
// A cell below this many trades is arithmetic, not a result. It is printed anyway -- hiding
// it would make the surviving rows look like the whole picture -- but never recommended.
const MIN_TRADES = Math.max(1, Number(process.env.DIP_SWEEP_MIN_TRADES || 20));

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

export function sweep(rows, { openBands = OPEN_BANDS, ceilings = BUY_CEILINGS, floors = [0] } = {}) {
  const days = spanDays(rows);
  const cells = [];
  for (const band of openBands) {
    const inBand = rows.filter((row) => inOpenBand(row, band));
    for (const floor of floors) {
      for (const ceiling of ceilings) {
        if (floor > 0 && floor >= ceiling) continue;
        const entries = inBand.map((row) => entryForCell(row, ceiling, floor)).filter(Boolean);
        const stats = cellStats(entries);
        cells.push({
          openMin: band[0],
          openMax: band[1],
          buyMin: floor,
          buyMax: ceiling,
          marketsInOpenBand: inBand.length,
          ...stats,
          tradesPerMonth: days ? (stats.trades / days) * 30 : null,
        });
      }
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

function printGrid(label, rows, floors) {
  const days = spanDays(rows);
  console.log(`\n=== ${label} -- ${rows.length} usable market(s)`
    + `${days ? `, spanning ${days.toFixed(0)} day(s)` : ", span unknown"} ===`);
  if (!rows.length) return [];
  const cells = sweep(rows, { floors });
  for (const floor of floors) {
    const forFloor = cells.filter((cell) => cell.buyMin === floor);
    if (!forFloor.length) continue;
    console.log(`\n  buy floor ${floor > 0 ? `${(floor * 100).toFixed(0)}%` : "none"}`);
    console.log("    open band   buy<=   trades   /month   win%    price%    ROI%      P/L");
    for (const cell of forFloor) {
      const band = `${(cell.openMin * 100).toFixed(0)}-${(cell.openMax * 100).toFixed(0)}`.padStart(9);
      const flag = cell.trades < MIN_TRADES ? " (thin)" : "";
      console.log(`    ${band}   ${String((cell.buyMax * 100).toFixed(0)).padStart(3)}%  ${int(cell.trades)}   ${pct(cell.tradesPerMonth)}  ${pct(cell.accuracy)}  ${pct(cell.impliedWinnerEntryPct)}  ${pct(cell.roiPct, 2)}  ${pct(cell.pnlUsdc, 2)}${flag}`);
    }
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
  for (const entry of present) perTag.set(entry.tag, printGrid(entry.tag, entry.rows, BUY_FLOORS));

  const pooled = present.flatMap((entry) => entry.rows);
  const pooledCells = present.length > 1 ? printGrid("all tags pooled", pooled, BUY_FLOORS) : [];

  // Last, because the log is read from the end: the combinations that clear both demands.
  const ranked = [];
  for (const [tag, cells] of perTag) for (const cell of shortlist(cells)) ranked.push({ tag, ...cell });
  for (const cell of shortlist(pooledCells)) ranked.push({ tag: "POOLED", ...cell });
  ranked.sort((left, right) => (right.roiPct ?? -Infinity) - (left.roiPct ?? -Infinity));

  console.log(`\n\n=== combinations with at least ${MIN_TRADES} trades AND a positive return ===`);
  if (!ranked.length) {
    console.log("   (none -- every profitable cell is below the trade floor, or every cell with volume loses)");
  }
  console.log("    tag                  open band   buy band    trades   /month   win%    price%    ROI%      P/L");
  for (const cell of ranked.slice(0, 30)) {
    const band = `${(cell.openMin * 100).toFixed(0)}-${(cell.openMax * 100).toFixed(0)}`.padStart(9);
    const buy = `${cell.buyMin > 0 ? (cell.buyMin * 100).toFixed(0) : "0"}-${(cell.buyMax * 100).toFixed(0)}`.padStart(7);
    console.log(`    ${cell.tag.padEnd(20)} ${band}   ${buy}   ${int(cell.trades)}   ${pct(cell.tradesPerMonth)}  ${pct(cell.accuracy)}  ${pct(cell.impliedWinnerEntryPct)}  ${pct(cell.roiPct, 2)}  ${pct(cell.pnlUsdc, 2)}`);
  }
  console.log("\n   price% is the mean price the winners were bought at. A win% far above it is an");
  console.log("   edge; a win% at it is a fairly priced coin flip that the fee turns into a loss.");
  console.log("   Opening bands below 70% are absent by construction: the cache never priced them.");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Sweep failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
