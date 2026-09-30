// Read-only. One dip portfolio's exact rule, replayed against the published per-tag
// backtest caches: its own opening band, its own buy band, and its own excluded market
// shapes -- read from the portfolio's live config, not typed in by hand.
//
// Asked for: "udelej backtest a dej mi tabulkou, zda je rozumny setup mit portfolio 'dip 70+
// ->45-56 live' na include only tag 'tennis' popr. jake jine tagy spis zohlednit. vem v potaz
// i to, jake mam excluded tvary."
//
// THE ~0.50 PRINTS. A dip backtest cell looked far too good to believe (win% 95+ bought at a
// ~50% price). Its raw rows were favourites -- very often the "No" side of an Exact Score
// prop, a genuine 97% shot -- whose price series touched ~0.50 at the same hourly timestamp
// across several mutually exclusive markets of one fixture at once. No real market does
// that. It is what a price series reads when the book behind it is empty or absurdly wide:
// the midpoint of nothing is 0.50. The live rule buys only at a real ask inside the band, and
// an empty book has no ask, so none of those "entries" could ever have been taken.
//
// So every result is printed twice: all entries, and entries NOT sitting in the narrow
// ~0.50 cluster. If the edge lives only in the cluster, it is the artifact, not the market.
//
// WHAT IT CANNOT SAY, and why the cache is still the right source:
//   * The cache holds the first in-play price at or below each recorded level, not the full
//     series. The entry here is the earliest of those that lands inside the buy band, so a
//     market that gapped below the band and later climbed back into it is not counted.
//   * Prices come from CLOB price history, not from the order book the live worker reads.
//     Nothing here proves a fill.
//   * The cache only prices markets that opened at 60-99% (70-99% before 2026-09-30; rows
//     from then are re-simulated as their tag re-runs, and the grid says how many are left).

import { BUY_CEILINGS, cacheRows } from "./dip-combination-sweep.mjs";
import { MARKET_SHAPE_IDS, marketShape } from "./paper-trading-bot.mjs";

const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
const CACHE_STAKE_USDC = 5;

export const NEAR_HALF = [0.495, 0.51];

// Number(null) and Number("") are 0, so a setting missing from the config would otherwise
// read as a 0% band edge rather than as missing.
const num = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));

// A setting may be stored as 0.7 or typed as 70; a probability above 1 is a percentage.
export function probability(value) {
  const parsed = num(value);
  if (parsed == null) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

function list(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
}

// Every portfolio the config holds, keyed the way the rest of the application names them.
export function portfolioRows(config = {}) {
  const rows = [];
  for (const [id, row] of Object.entries(config?.livePortfolios || {})) {
    if (row && typeof row === "object") rows.push({ id: `live-custom-${id}`, account: "live", row });
  }
  for (const [id, row] of Object.entries(config?.paper || {})) {
    if (row && typeof row === "object") rows.push({ id: `paper-${id}`, account: "paper", row });
  }
  return rows;
}

// Exact display name first, then the id, then a contained name -- so "dip 70+ ->45-56 live"
// typed with a missing space still finds "dip 70+ -> 45-56 live".
export function findPortfolio(rows, wanted) {
  const squash = (text) => String(text || "").toLowerCase().replace(/\s+/g, "");
  const target = squash(wanted);
  if (!target) return null;
  return rows.find((entry) => squash(entry.row.displayName) === target)
    || rows.find((entry) => squash(entry.id) === target || squash(entry.id).endsWith(`-${target}`))
    || rows.find((entry) => squash(entry.row.displayName).includes(target))
    || null;
}

// The rule the live watch applies, in the one shape this file needs. Excluded shapes fold in
// the legacy over-under switch exactly as merge_excluded_market_shapes() does in api.php.
export function dipRuleOf(row = {}) {
  const shapes = new Set(list(row.excludedMarketShapes).filter((shape) => MARKET_SHAPE_IDS.includes(shape)));
  if (row.excludeOverUnderMarkets === true) shapes.add("over-under");
  return {
    openMin: probability(row.dipEntryOpenMin),
    openMax: probability(row.dipEntryOpenMax),
    buyMin: probability(row.dipEntryBuyMin ?? row.minProbability),
    buyMax: probability(row.dipEntryBuyMax ?? row.maxProbability),
    excludedShapes: [...shapes].sort(),
    includeOnlyTags: list(row.includeOnlyMarketTags),
    excludedTags: list(row.excludedMarketTags),
    stakeUsdc: num(row.stakeUsdc),
  };
}

// The trade the rule would have taken on one cached market, or null. The live worker buys
// the first time the ask sits inside [buyMin, buyMax]; the closest the cache can come is the
// earliest recorded first-touch that lands inside the band. A level below the band floor can
// only ever hold prices below it, so it is not consulted.
export function setupEntry(row, [buyMin, buyMax], levels = BUY_CEILINGS) {
  let best = null;
  for (const level of levels) {
    if (level + 1e-9 < buyMin) continue;
    const entry = row?.entries?.[String(level)];
    const price = num(entry?.entryPrice);
    if (price == null || price + 1e-9 < buyMin || price - 1e-9 > buyMax) continue;
    const at = Date.parse(String(entry.enteredAt || ""));
    if (!Number.isFinite(at)) continue;
    if (!best || at < best.at) best = { at, entry };
  }
  return best ? best.entry : null;
}

// The backtest rule version a cached row was simulated under: the first element of its
// source fingerprint. Rows before 7 read the in-play window one point per hour, which counts
// dips that linger and recover but misses favourites that fall straight through the band.
export function ruleVersion(row) {
  try {
    const version = Number(JSON.parse(String(row?.fingerprint || ""))[0]);
    return Number.isFinite(version) ? version : null;
  } catch {
    return null;
  }
}
export const MINUTE_IN_PLAY_VERSION = 7;

export function nearHalf(price, [low, high] = NEAR_HALF) {
  const value = num(price);
  return value != null && value + 1e-9 >= low && value - 1e-9 <= high;
}

// Every trade the rule takes on one tag's cached markets, with the shape it was classified
// as, so a caller can split by shape without classifying twice.
export function setupTrades(rows, rule) {
  const excluded = new Set(rule.excludedShapes || []);
  const trades = [];
  for (const row of rows) {
    const opening = num(row?.openingPrice);
    if (opening == null || opening + 1e-9 < rule.openMin || opening - 1e-9 > rule.openMax) continue;
    const shape = marketShape(row);
    if (excluded.has(shape)) continue;
    const entry = setupEntry(row, [rule.buyMin, rule.buyMax]);
    if (entry) trades.push({ row, entry, shape });
  }
  return trades;
}

// Stake-scaled: the cache priced every entry at $5, and a win's payout, a loss's cost and
// the entry fee are all proportional to the stake, so another stake is a straight multiple.
export function setupStats(trades, stakeUsdc = CACHE_STAKE_USDC) {
  const scale = (num(stakeUsdc) || CACHE_STAKE_USDC) / CACHE_STAKE_USDC;
  const n = trades.length;
  const wins = trades.filter(({ entry }) => entry.outcome === "WIN").length;
  const fees = trades.reduce((sum, { entry }) => sum + (num(entry.feeUsdc) || 0), 0);
  const pnl = trades.reduce((sum, { entry }) => sum + (num(entry.pnlUsdc) || 0), 0) * scale;
  const staked = (n * CACHE_STAKE_USDC + fees) * scale;
  const meanPrice = n ? trades.reduce((sum, { entry }) => sum + num(entry.entryPrice), 0) / n : null;
  const winRate = n ? wins / n : null;
  return {
    trades: n,
    wins,
    winPct: winRate == null ? null : winRate * 100,
    winPctLow: n ? wilson(wins, n)[0] * 100 : null,
    winPctHigh: n ? wilson(wins, n)[1] * 100 : null,
    meanPricePct: meanPrice == null ? null : meanPrice * 100,
    // What the win rate has to beat to be more than a fairly priced coin: a trade bought at
    // p pays off only if it wins more often than p.
    edgePoints: winRate == null || meanPrice == null ? null : (winRate - meanPrice) * 100,
    pnlUsdc: pnl,
    stakedUsdc: staked,
    roiPct: staked > 0 ? (pnl / staked) * 100 : null,
  };
}

// 95% Wilson interval. On forty tennis trades a win rate is a range, not a number, and an
// "edge" that fits inside the range is not one yet.
export function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = wins / n;
  const denominator = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / denominator), Math.min(1, (centre + spread) / denominator)];
}

// A market's league or game, read off the front of its slug ("atp-", "wta-", "lol-", "cs2-",
// "epl-"). The cache carries no tag list of its own, and this is the finest split it allows.
export function slugPrefix(row) {
  const slug = String(row?.slug || row?.eventSlug || "").trim().toLowerCase();
  const head = slug.split("-")[0];
  return head || "(no slug)";
}

// ---------------------------------------------------------------------------------------
// The grid. Asked for: "udelas vice tabulek pro to kdyz budu mit vstupni range 70-99 posunuty
// treba na 65-99 apod. a nakupni taky treba jen na 50-60, apod. hledame lepsi kombinaci
// parametru portfolia nez je ta soucasna."
//
// Each cell uses the portfolio's own rule (its excluded shapes and its stake) and swaps only
// the opening band and the buy band. Each is computed by setupTrades(), the function the
// single-rule report uses, so the cell with the current settings reproduces that report.
//
// Reading the ranking: with eighty cells over a few dozen markets, the top cell looks good
// partly by chance. Pick the best of eighty fair coins and it will have won most of its
// flips. So every row also prints the lower edge of the 95% interval on the edge. A cell is
// worth moving to only where that edge holds up and its neighbours agree.
export const GRID_OPEN_BANDS = [
  [0.6, 0.99], [0.65, 0.99], [0.7, 0.99], [0.75, 0.99], [0.8, 0.99], [0.85, 0.99],
  [0.65, 0.9], [0.7, 0.9],
];
export const GRID_BUY_BANDS = [
  [0.4, 0.5], [0.45, 0.5], [0.4, 0.56], [0.45, 0.56], [0.5, 0.56],
  [0.45, 0.6], [0.5, 0.6], [0.55, 0.6], [0.55, 0.65], [0.6, 0.7],
];
// The highest opening the cache priced; a rule's 99.9% ceiling reads as this.
const CACHE_OPEN_CEILING = 0.99;

// "60-99,0.65-0.9" -> [[0.6, 0.99], [0.65, 0.9]]. Percentages or fractions; an entry that is
// not a band (junk, reversed, outside 0-1) is dropped rather than guessed at.
export function parseBands(text, fallback) {
  const bands = String(text || "").split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [low, high] = part.split("-").map((value) => probability(value));
    return low != null && high != null && low >= 0 && high <= 1 && low < high ? [low, high] : null;
  }).filter(Boolean);
  return bands.length ? bands : fallback;
}

const sameBand = (left, right) => Math.abs(left[0] - right[0]) < 1e-6 && Math.abs(left[1] - right[1]) < 1e-6;

// Rows whose opening sits in the band but that were never simulated there: the cache ran under
// a narrower opening band, so they have a usable opening and no entries. A cell that silently
// counted them as "no dip" would read as a rule that rarely fires.
export function unsimulatedRows(rows, [openMin, openMax]) {
  return rows.filter((row) => {
    const opening = num(row?.openingPrice);
    return opening != null && opening + 1e-9 >= openMin && opening - 1e-9 <= openMax && row.openingInBand !== true;
  }).length;
}

export function gridCells(rows, rule, openBands = GRID_OPEN_BANDS, buyBands = GRID_BUY_BANDS) {
  const currentOpen = [rule.openMin, Math.min(rule.openMax, CACHE_OPEN_CEILING)];
  const currentBuy = [rule.buyMin, rule.buyMax];
  const cells = [];
  for (const open of openBands) {
    for (const buy of buyBands) {
      const trades = setupTrades(rows, { ...rule, openMin: open[0], openMax: open[1], buyMin: buy[0], buyMax: buy[1] });
      cells.push({
        open,
        buy,
        trades,
        clean: trades.filter(({ entry }) => !nearHalf(entry.entryPrice)),
        current: sameBand(open, currentOpen) && sameBand(buy, currentBuy),
      });
    }
  }
  return cells;
}

const bandLabel = ([low, high]) => `${Math.round(low * 100)}-${Math.round(high * 100)}%`;

// The lower edge of the 95% interval on the edge: the worst win rate the data still allows,
// minus the price paid. Above zero, the cell beat a fairly priced coin even at that edge.
function edgeLow(stats) {
  return stats.trades && stats.meanPricePct != null ? stats.winPctLow - stats.meanPricePct : null;
}

function gridHeader() {
  return `      ${"buy band".padEnd(12)} ${"n".padStart(4)} ${"/month".padStart(6)}  ${"win%".padStart(5)} ${"[95% CI]".padEnd(9)}`
    + ` ${"price%".padStart(6)} ${"edge".padStart(6)} ${"edge lo".padStart(7)} ${"P/L".padStart(8)} ${"ROI%".padStart(6)}`
    + `  |  ${"clean n".padStart(7)} ${"P/L".padStart(8)} ${"ROI%".padStart(6)}`;
}

function gridLine(cell, stake, days) {
  const all = setupStats(cell.trades, stake);
  const clean = setupStats(cell.clean, stake);
  const perMonth = days ? (all.trades / days) * 30 : null;
  const ci = all.trades ? `[${f(all.winPctLow, 0, 3)}-${f(all.winPctHigh, 0, 3)}]` : "";
  return `      ${`${bandLabel(cell.buy)}${cell.current ? " *" : ""}`.padEnd(12)} ${String(all.trades).padStart(4)}`
    + ` ${f(perMonth, 1, 6)}  ${f(all.winPct, 1, 5)} ${ci.padEnd(9)} ${f(all.meanPricePct)} ${f(all.edgePoints)}`
    + ` ${f(edgeLow(all), 1, 7)} ${f(all.pnlUsdc, 2, 8)} ${f(all.roiPct, 1, 6)}`
    + `  |  ${String(clean.trades).padStart(7)} ${f(clean.pnlUsdc, 2, 8)} ${f(clean.roiPct, 1, 6)}`;
}

// The grid for one tag: a table per opening band, then the cells ranked by P/L without the
// ~0.50 prints. Returns the ranked cells for the cross-tag summary.
export function printGrid(tag, rows, rule, { stake = CACHE_STAKE_USDC, openBands = GRID_OPEN_BANDS, buyBands = GRID_BUY_BANDS, minTrades = 10 } = {}) {
  const cells = gridCells(rows, rule, openBands, buyBands);
  const days = spanDays(cells.flatMap((cell) => cell.trades));
  console.log(`\n=== ${tag}: grid -- opening band x buy band, excluded shapes [${rule.excludedShapes.join(", ")}], stake ${stake} USDC ===`);
  console.log("   * = the portfolio's current setting. clean = without entries priced 0.495-0.51.");
  for (const open of openBands) {
    const inBand = rows.filter((row) => {
      const opening = num(row?.openingPrice);
      return opening != null && opening + 1e-9 >= open[0] && opening - 1e-9 <= open[1];
    }).length;
    const missing = unsimulatedRows(rows, open);
    console.log(`\n   opening ${bandLabel(open)}   ${inBand} market(s) opened in this band`
      + (missing ? `   !! ${missing} of them NOT simulated yet -- this table undercounts until the tag re-runs` : ""));
    console.log(gridHeader());
    for (const cell of cells.filter((item) => sameBand(item.open, open))) console.log(gridLine(cell, stake, days));
  }
  const ranked = cells
    .map((cell) => ({ cell, all: setupStats(cell.trades, stake), clean: setupStats(cell.clean, stake) }))
    .filter(({ clean }) => clean.trades >= minTrades)
    .sort((left, right) => right.clean.pnlUsdc - left.clean.pnlUsdc);
  console.log(`\n   -- ${tag}: cells ranked by P/L without the ~0.50 prints (${minTrades}+ such trades)`);
  console.log(`   ${"#".padStart(3)} ${"opening".padEnd(9)} ${"buy".padEnd(9)} ${"clean n".padStart(7)}  ${"win%".padStart(5)} ${"[95% CI]".padEnd(9)}`
    + ` ${"price%".padStart(6)} ${"edge lo".padStart(7)} ${"P/L".padStart(8)} ${"ROI%".padStart(6)}`);
  const rankLine = ({ cell, clean }, place) => {
    const ci = `[${f(clean.winPctLow, 0, 3)}-${f(clean.winPctHigh, 0, 3)}]`;
    console.log(`   ${`#${place}`.padStart(3)} ${bandLabel(cell.open).padEnd(9)} ${bandLabel(cell.buy).padEnd(9)} ${String(clean.trades).padStart(7)}`
      + `  ${f(clean.winPct, 1, 5)} ${ci.padEnd(9)} ${f(clean.meanPricePct)} ${f(edgeLow(clean), 1, 7)}`
      + ` ${f(clean.pnlUsdc, 2, 8)} ${f(clean.roiPct, 1, 6)}${cell.current ? "   <- current" : ""}`);
  };
  ranked.slice(0, 12).forEach((item, index) => rankLine(item, index + 1));
  // Where the current setting stands, even when it is not near the top.
  const currentPlace = ranked.findIndex(({ cell }) => cell.current);
  if (currentPlace >= 12) {
    console.log("       ...");
    rankLine(ranked[currentPlace], currentPlace + 1);
  } else if (currentPlace < 0 && cells.some((cell) => cell.current)) {
    console.log(`       current setting: fewer than ${minTrades} trades without the ~0.50 prints, not ranked`);
  }
  if (ranked.length) console.log(`       ${ranked.length} cell(s) ranked`);
  if (!ranked.length) console.log(`      no cell has ${minTrades}+ trades without the ~0.50 prints`);
  return { tag, cells, ranked, days };
}

function spanDays(trades) {
  const times = trades.map(({ row }) => Date.parse(String(row?.resolvedAt || ""))).filter(Number.isFinite);
  if (times.length < 2) return null;
  const days = (Math.max(...times) - Math.min(...times)) / 86400000;
  return days > 0 ? days : null;
}

const f = (value, places = 1, width = 6) => (value == null ? "-".padStart(width) : value.toFixed(places).padStart(width));

function line(label, stats, days) {
  const perMonth = days ? (stats.trades / days) * 30 : null;
  const ci = stats.trades ? `[${f(stats.winPctLow, 0, 3)}-${f(stats.winPctHigh, 0, 3)}]` : "";
  console.log(`   ${label.padEnd(26)} ${String(stats.trades).padStart(5)}  ${f(perMonth, 1, 6)}  ${f(stats.winPct)} ${ci.padEnd(9)}`
    + ` ${f(stats.meanPricePct)}  ${f(stats.edgePoints)}  ${f(stats.pnlUsdc, 2, 9)}  ${f(stats.roiPct, 1, 7)}`);
}

function header(label = "") {
  return `   ${label.padEnd(26)} ${"n".padStart(5)}  ${"/month".padStart(6)}  ${"win%".padStart(6)} ${"[95% CI]".padEnd(9)}`
    + ` ${"price%".padStart(6)}  ${"edge".padStart(6)}  ${"P/L".padStart(9)}  ${"ROI%".padStart(7)}`;
}

async function json(path) {
  const response = await fetch(`${HOST}/${path}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

async function loadRows(tag) {
  const response = await fetch(`${HOST}/data/dip-backtest-${tag}-cache.json`, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  return cacheRows(await response.json());
}

function override(name, value) {
  const raw = process.env[name];
  return raw == null || raw === "" ? value : probability(raw);
}

async function main() {
  const wanted = String(process.env.DIP_SETUP_PORTFOLIO || "dip 70+ -> 45-56 live");
  const tags = String(process.env.DIP_SETUP_TAGS || "tennis,esports,counter-strike-2,soccer,sports")
    .split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  console.log(`Dip setup backtest at ${new Date().toISOString()}`);
  console.log("Read-only: public config and published caches. No CLOB, no database, no writes.\n");

  const config = (await json("api.php?action=portfolio-config"))?.config || {};
  const found = findPortfolio(portfolioRows(config), wanted);
  if (!found) {
    console.log(`No portfolio matches "${wanted}". Dip portfolios in the config:`);
    for (const entry of portfolioRows(config).filter((item) => item.row.dipEntryEnabled)) {
      console.log(`   ${entry.id.padEnd(34)} ${entry.row.displayName || ""}`);
    }
    process.exitCode = 1;
    return;
  }
  const configured = dipRuleOf(found.row);
  const rule = {
    ...configured,
    openMin: override("DIP_SETUP_OPEN_MIN", configured.openMin),
    openMax: override("DIP_SETUP_OPEN_MAX", configured.openMax),
    buyMin: override("DIP_SETUP_BUY_MIN", configured.buyMin),
    buyMax: override("DIP_SETUP_BUY_MAX", configured.buyMax),
  };
  if (process.env.DIP_SETUP_EXCLUDED_SHAPES != null && process.env.DIP_SETUP_EXCLUDED_SHAPES !== "") {
    rule.excludedShapes = list(process.env.DIP_SETUP_EXCLUDED_SHAPES.split(","));
  }
  console.log(`Portfolio: ${found.row.displayName || found.id}  (${found.id})`);
  console.log(`   dipEntryEnabled ${found.row.dipEntryEnabled}   archived ${found.row.archived === true}`);
  console.log(`   opening ${f(rule.openMin * 100, 1, 0)}-${f(rule.openMax * 100, 1, 0)}%   buy ${f(rule.buyMin * 100, 1, 0)}-${f(rule.buyMax * 100, 1, 0)}%`
    + `   stake ${rule.stakeUsdc ?? CACHE_STAKE_USDC} USDC`);
  console.log(`   excluded shapes   [${rule.excludedShapes.join(", ")}]`);
  console.log(`   include only tags [${rule.includeOnlyTags.join(", ")}]   excluded tags [${rule.excludedTags.join(", ")}]`);
  if (![rule.openMin, rule.openMax, rule.buyMin, rule.buyMax].every((value) => value != null)) {
    console.log("\nThe portfolio has no complete dip rule; nothing to replay.");
    process.exitCode = 1;
    return;
  }
  if (rule.openMax > 0.99) console.log("   (the cache only priced openings up to 99%, so the band is read as ending there)");

  const stake = rule.stakeUsdc ?? CACHE_STAKE_USDC;
  const summary = [];
  const loaded = new Map();
  for (const tag of tags) {
    const rows = await loadRows(tag);
    console.log(`\n=== ${tag} ===`);
    if (!rows) {
      console.log("   no published cache");
      continue;
    }
    loaded.set(tag, rows);
    const versions = new Map();
    for (const row of rows) versions.set(ruleVersion(row), (versions.get(ruleVersion(row)) || 0) + 1);
    const hourlyRows = [...versions].filter(([version]) => !(version >= MINUTE_IN_PLAY_VERSION)).reduce((sum, [, n]) => sum + n, 0);
    console.log(`   cached rows by rule version: ${[...versions].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0)).map(([version, n]) => `v${version ?? "?"} ${n}`).join(", ")}`
      + (hourlyRows ? `  -- ${hourlyRows} simulated on HOURLY in-play points: biased toward winners until re-run` : ""));
    const trades = setupTrades(rows, rule);
    const days = spanDays(trades);
    const clean = trades.filter(({ entry }) => !nearHalf(entry.entryPrice));
    const half = trades.filter(({ entry }) => nearHalf(entry.entryPrice));
    const onTheHour = trades.filter(({ entry }) => new Date(entry.enteredAt).getUTCMinutes() === 0).length;
    console.log(`   ${rows.length} cached market(s)${days ? `, trades spanning ${days.toFixed(0)} day(s)` : ""};`
      + ` ${trades.length ? ((onTheHour / trades.length) * 100).toFixed(0) : 0}% of entries fall on a whole hour`);
    console.log(header());
    line("all entries", setupStats(trades, stake), days);
    line(`without ${NEAR_HALF[0]}-${NEAR_HALF[1]} prints`, setupStats(clean, stake), days);
    line(`only ${NEAR_HALF[0]}-${NEAR_HALF[1]} prints`, setupStats(half, stake), days);
    // One span for both variants: dividing the clean subset by its own, shorter span made the
    // clean rule look as if it fired MORE often than the rule it is a subset of.
    summary.push({ tag, all: setupStats(trades, stake), clean: setupStats(clean, stake), days });

    const byShape = new Map();
    for (const trade of clean) byShape.set(trade.shape, [...(byShape.get(trade.shape) || []), trade]);
    console.log("   -- by shape, without the ~0.50 prints");
    for (const [shape, group] of [...byShape].sort((a, b) => b[1].length - a[1].length)) line(`   ${shape}`, setupStats(group, stake), days);

    const byPrefix = new Map();
    for (const trade of clean) {
      const key = slugPrefix(trade.row);
      byPrefix.set(key, [...(byPrefix.get(key) || []), trade]);
    }
    console.log("   -- by slug prefix (league / game), without the ~0.50 prints, 5+ trades");
    for (const [prefix, group] of [...byPrefix].filter(([, group]) => group.length >= 5).sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      line(`   ${prefix}`, setupStats(group, stake), days);
    }

    const sampleLimit = Math.max(0, Math.min(40, Number(process.env.DIP_SETUP_SAMPLE ?? 8)));
    if (sampleLimit) {
      console.log(`   -- first ${sampleLimit} trade(s)`);
      for (const { row, entry, shape } of trades.slice(0, sampleLimit)) {
        console.log(`      ${String(row.question || "").slice(0, 60).padEnd(60)} side ${String(row.outcome || "-").padEnd(8)}`
          + ` ${shape.padEnd(12)} open ${f(num(row.openingPrice), 3, 5)} -> ${f(num(entry.entryPrice), 3, 5)}`
          + ` ${entry.enteredAt} ${entry.outcome}`);
      }
    }
  }

  console.log("\n\n=== summary: this rule, per tag ===");
  console.log(header("tag                variant"));
  for (const { tag, all, clean, days } of summary) {
    line(`${tag.padEnd(18)} all`, all, days);
    line(`${tag.padEnd(18)} clean`, clean, days);
  }
  console.log("\n   clean = without entries priced", `${NEAR_HALF[0]}-${NEAR_HALF[1]}.`,
    "price% is the mean entry price; edge is win% minus it.");

  if (!/^(1|true|yes|on)$/i.test(String(process.env.DIP_SETUP_GRID || "").trim())) return;
  const openBands = parseBands(process.env.DIP_SETUP_GRID_OPEN, GRID_OPEN_BANDS);
  const buyBands = parseBands(process.env.DIP_SETUP_GRID_BUY, GRID_BUY_BANDS);
  const minTrades = Math.max(1, Number(process.env.DIP_SETUP_GRID_MIN_TRADES) || 10);
  const grids = [];
  for (const [tag, rows] of loaded) grids.push(printGrid(tag, rows, rule, { stake, openBands, buyBands, minTrades }));

  // Last, so a log read from the end starts with the answer.
  console.log(`\n\n=== grid summary: the current setting beside the best cell per tag (by P/L without the ~0.50 prints, ${minTrades}+ trades) ===`);
  console.log(`   ${"tag".padEnd(18)} ${"current".padEnd(17)} ${"n".padStart(4)} ${"P/L".padStart(8)} ${"ROI%".padStart(6)}   |  `
    + `${"best".padEnd(17)} ${"n".padStart(4)} ${"win%".padStart(5)} ${"edge lo".padStart(7)} ${"P/L".padStart(8)} ${"ROI%".padStart(6)}`);
  for (const { tag, cells, ranked } of grids) {
    const current = cells.find((cell) => cell.current);
    const now = current ? setupStats(current.clean, stake) : null;
    const best = ranked[0];
    const nowText = current
      ? `${`${bandLabel(current.open)} ${bandLabel(current.buy)}`.padEnd(17)} ${String(now.trades).padStart(4)} ${f(now.pnlUsdc, 2, 8)} ${f(now.roiPct, 1, 6)}`
      : `${"(not in grid)".padEnd(17)} ${"".padStart(4)} ${"".padStart(8)} ${"".padStart(6)}`;
    const bestText = best
      ? `${`${bandLabel(best.cell.open)} ${bandLabel(best.cell.buy)}`.padEnd(17)} ${String(best.clean.trades).padStart(4)}`
        + ` ${f(best.clean.winPct, 1, 5)} ${f(edgeLow(best.clean), 1, 7)} ${f(best.clean.pnlUsdc, 2, 8)} ${f(best.clean.roiPct, 1, 6)}`
      : `no cell with ${minTrades}+ trades`;
    console.log(`   ${tag.padEnd(18)} ${nowText}   |  ${bestText}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Setup backtest failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
