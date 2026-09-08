// Read-only diagnostic. Places no orders, writes nothing, needs no secrets.
//
// Asked, against a recommended parameter set: are 70% and 71% entries actually profitable,
// or does positive P/L only start at 72%? Is a 48-hour resolution horizon really better
// than a shorter one, given a shorter one turns the capital over faster? Does excluding
// market shapes mean anything once the stop loss is off, since the shape filter existed to
// protect a stop that cannot reach a jump? And what does the data say about both-teams,
// which the recommendation simply omitted?
//
// Every one of those is a question about a PARAMETER, not about a portfolio, so every one is
// answered by pooling the closed trades of every paper portfolio and cutting them by that
// parameter. Pooling is the point: a single portfolio has 2 or 4 both-teams trades, which is
// nothing, while the price buckets only separate at all with a few hundred rows behind them.
// Per-portfolio results stay in the stop-loss tuning report; this one is deliberately the
// other view, and it prints the n behind every cell so a two-row bucket cannot be read as a
// finding.
//
// The bar each bucket has to clear is its own entry price. Buying a share at p and holding
// it to settlement breaks even at a win rate of exactly p, so a bucket around 0.71 needs
// 71% and a bucket around 0.85 needs 85%. Comparing a bucket's win rate to the pooled
// average instead is how buying favourites gets mistaken for an edge.
import { pathToFileURL } from "node:url";
import { marketShape } from "./paper-trading-bot.mjs";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
const PRICE_STEP = Number(process.env.PRICE_BUCKET_STEP || 0.02);

async function fetchJson(url, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000 * (2 ** (attempt - 1))));
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const pct = (value) => (value == null ? "     -" : `${(value * 100).toFixed(1).padStart(5)}%`);
const usd = (value) => (value == null ? "      -" : `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2).padStart(6)}`);
const pad = (value, width) => String(value ?? "").padEnd(width);

// One standard error on a proportion, so a bucket's gap over its own break-even can be read
// as signal or as noise instead of by eye.
function sigma(won, total, bar) {
  if (!(total > 0) || !(bar > 0) || !(bar < 1)) return null;
  const se = Math.sqrt(bar * (1 - bar) / total);
  return se > 0 ? ((won / total) - bar) / se : null;
}

function summarize(rows) {
  const decided = rows.filter((row) => row.won != null);
  const won = decided.filter((row) => row.won).length;
  const pnl = rows.reduce((sum, row) => sum + (row.pnl || 0), 0);
  const stake = rows.reduce((sum, row) => sum + (row.stake || 0), 0);
  // Capital-turnover view: what the same dollar earns per DAY it is tied up, not per trade.
  // A portfolio making 4% on trades that settle in two hours beats one making 8% on trades
  // that take two days, and no per-trade number can say that.
  const held = rows.map((row) => row.hoursHeld).filter((hours) => hours != null && hours > 0);
  const meanHours = held.length ? held.reduce((sum, hours) => sum + hours, 0) / held.length : null;
  const roi = stake > 0 ? pnl / stake : null;
  return {
    n: rows.length,
    decided: decided.length,
    won,
    pnl,
    stake,
    roi,
    meanEntry: (() => {
      const entries = rows.map((row) => row.entry).filter((entry) => entry != null);
      return entries.length ? entries.reduce((sum, entry) => sum + entry, 0) / entries.length : null;
    })(),
    meanHours,
    roiPerDay: roi != null && meanHours != null && meanHours > 0 ? roi / (meanHours / 24) : null,
    fullStakeLosses: rows.filter((row) => row.stake != null && row.pnl != null
      && row.pnl <= -(row.stake - 0.01)).length,
  };
}

function table(title, buckets, { bar = null, note = null } = {}) {
  console.log(`\n${title}`);
  if (note) console.log(note);
  console.log("   bucket           n  decided   won   win%   break-even  sigma"
    + "     total P/L    staked     ROI    mean hold   ROI/day  full-stake");
  for (const [label, rows] of buckets) {
    if (!rows.length) continue;
    const stats = summarize(rows);
    // Either the bucket's own price (for a price cut) or the pooled mean entry (for every
    // other cut, where the bar is whatever those trades were actually bought at).
    const level = bar === "self" ? stats.meanEntry : bar;
    const s = level == null ? null : sigma(stats.won, stats.decided, level);
    console.log(`   ${pad(label, 14)} ${String(stats.n).padStart(4)}`
      + ` ${String(stats.decided).padStart(8)} ${String(stats.won).padStart(5)}`
      + `  ${pct(stats.decided ? stats.won / stats.decided : null)}`
      + `      ${level == null ? "    -" : (level * 100).toFixed(1).padStart(5)}`
      + `  ${s == null ? "    -" : s.toFixed(2).padStart(5)}`
      + `    ${usd(stats.pnl)}  ${stats.stake.toFixed(2).padStart(8)}`
      + `  ${pct(stats.roi)}`
      + `  ${stats.meanHours == null ? "      -" : `${stats.meanHours.toFixed(1).padStart(6)}h`}`
      + `  ${pct(stats.roiPerDay)}`
      + `  ${String(stats.fullStakeLosses).padStart(6)}`);
  }
}

// Running totals from the cheapest entries upward, which is the only way to answer "where
// should the minimum be" -- a single bucket at 0.70 says whether 0.70 pays, and this says
// whether ADDING it to everything above it pays.
function cumulativeFromBelow(rows, edges) {
  console.log("\n   and cumulatively, which is what a minProbability setting actually buys:");
  console.log("   minProbability      n  decided   won   win%   break-even  sigma     total P/L    staked     ROI");
  for (const edge of edges) {
    const kept = rows.filter((row) => row.entry != null && row.entry >= edge - 1e-9);
    if (kept.length < 10) continue;
    const stats = summarize(kept);
    const s = stats.meanEntry == null ? null : sigma(stats.won, stats.decided, stats.meanEntry);
    console.log(`   >= ${edge.toFixed(2)}       ${String(stats.n).padStart(6)}`
      + ` ${String(stats.decided).padStart(8)} ${String(stats.won).padStart(5)}`
      + `  ${pct(stats.decided ? stats.won / stats.decided : null)}`
      + `      ${stats.meanEntry == null ? "    -" : (stats.meanEntry * 100).toFixed(1).padStart(5)}`
      + `  ${s == null ? "    -" : s.toFixed(2).padStart(5)}`
      + `    ${usd(stats.pnl)}  ${stats.stake.toFixed(2).padStart(8)}  ${pct(stats.roi)}`);
  }
}

async function main() {
  console.log(`Portfolio parameter evidence at ${new Date().toISOString()}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.\n");

  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};
  const overviewPayload = await fetchJson(
    `${HOST}/api.php?action=state&target=paper&summary=portfolio-overview&t=${Date.now()}`,
  );
  const overview = overviewPayload?.botState || overviewPayload?.state || overviewPayload || {};

  const rows = [];
  const perPortfolio = [];
  for (const [id, configRow] of Object.entries(config.paper || {})) {
    if (!configRow || typeof configRow !== "object") continue;
    let trades = Array.isArray(overview?.paperPortfolios?.[id]?.trades)
      ? overview.paperPortfolios[id].trades : null;
    if (!trades) {
      try {
        const payload = await fetchJson(
          `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}&t=${Date.now()}`,
        );
        const state = payload?.botState || payload?.state || payload || {};
        trades = Array.isArray(state?.paperPortfolios?.[id]?.trades) ? state.paperPortfolios[id].trades : [];
      } catch (error) {
        console.log(`   !! could not read ${id}: ${error?.message || error}`);
        trades = [];
      }
    }
    const own = [];
    for (const trade of trades) {
      const status = String(trade?.status || "").toUpperCase();
      // Only settled rows. An unfilled limit order never held anything and would drag the
      // P/L of a bucket it never traded in.
      if (["OPEN", "PENDING", "PENDING_FILL", "UNFILLED", "CANCELLED", "LIMIT_ORDER_WAITING",
        "LIMIT_ORDER_EXPIRED", "LIVE_LIMIT_ORDER_UNFILLED"].includes(status)) continue;
      const pnl = num(trade?.realizedPnlUsdc ?? trade?.pnlUsdc);
      if (pnl == null) continue;
      const stake = num(trade?.totalCostUsdc ?? trade?.stakeUsdc);
      const shares = num(trade?.shares ?? trade?.size);
      const entry = num(trade?.entryPrice) ?? (stake != null && shares > 0 ? stake / shares : null);
      const openedAt = Date.parse(trade?.openedAt || trade?.date || "");
      const closedAt = Date.parse(trade?.closedAt || trade?.resolvedAt || "");
      const exitPrice = num(trade?.exitPrice ?? trade?.finalOutcomePrice);
      // The market's own verdict where it exists, then the status, then the P/L sign. The
      // order matters: a position sold early at a loss on a market that resolved our way is
      // not a lost market, and scoring it as one is how the exits get blamed on the picks.
      const won = exitPrice != null && (exitPrice >= 0.99 || exitPrice <= 0.01)
        ? exitPrice >= 0.99
        : (status === "WON" ? true : (status === "LOST" ? false : (pnl > 0.005 ? true : (pnl < -0.005 ? false : null))));
      const row = {
        portfolio: String(configRow.displayName || id),
        entry,
        stake,
        pnl,
        won,
        shape: marketShape(trade),
        hoursHeld: Number.isFinite(openedAt) && Number.isFinite(closedAt) && closedAt > openedAt
          ? (closedAt - openedAt) / 3600000
          : null,
        stopped: configRow.stopLossRiskMultiplier > 0 || configRow.stopLossProbabilityFloor > 0,
      };
      rows.push(row);
      own.push(row);
    }
    if (own.length) {
      perPortfolio.push([`${String(configRow.displayName || id).slice(0, 22)}`, own]);
    }
  }

  console.log(`Pooled ${rows.length} settled paper trade(s) across ${perPortfolio.length} portfolio(s).`);
  console.log("Every table below cuts the SAME pool by one parameter. n is printed because a");
  console.log("two-row bucket is not evidence, whatever its ROI says.\n");
  console.log("=".repeat(112));

  // ---------------------------------------------------------------------------------
  // 1. Entry price. "Is 70% profitable, or does positive P/L only start at 72%?"
  const priced = rows.filter((row) => row.entry != null && row.entry > 0 && row.entry < 1);
  const priceBuckets = [];
  for (let low = 0.5; low < 1; low += PRICE_STEP) {
    const high = low + PRICE_STEP;
    priceBuckets.push([
      `${low.toFixed(2)}-${high.toFixed(2)}`,
      priced.filter((row) => row.entry >= low - 1e-9 && row.entry < high - 1e-9),
    ]);
  }
  table("== 1. by ENTRY PRICE -- each bucket against its own break-even, which is its own price",
    priceBuckets, {
      bar: "self",
      note: "   A bucket clears its bar when win% beats break-even. Positive ROI and a positive\n"
        + "   sigma are the same statement; ROI is the money and sigma is whether to believe it.",
    });
  cumulativeFromBelow(priced, [0.60, 0.65, 0.68, 0.70, 0.72, 0.74, 0.75, 0.78, 0.80, 0.85, 0.90]);

  // ---------------------------------------------------------------------------------
  // 2. Holding period. Raised against the 48-hour horizon: a shorter one turns the capital
  // over faster, so a lower per-trade ROI can still be the better setting.
  console.log(`\n${"=".repeat(112)}`);
  const holdBuckets = [
    ["< 2h", (hours) => hours < 2],
    ["2-6h", (hours) => hours >= 2 && hours < 6],
    ["6-12h", (hours) => hours >= 6 && hours < 12],
    ["12-24h", (hours) => hours >= 12 && hours < 24],
    ["24-48h", (hours) => hours >= 24 && hours < 48],
    ["48-96h", (hours) => hours >= 48 && hours < 96],
    ["> 96h", (hours) => hours >= 96],
  ].map(([label, test]) => [label, rows.filter((row) => row.hoursHeld != null && test(row.hoursHeld))]);
  table("== 2. by HOW LONG THE CAPITAL WAS TIED UP -- ROI/day is the column that decides a horizon",
    holdBuckets, {
      bar: "self",
      note: "   ROI per trade rewards a long hold for no reason: the same dollar could have been\n"
        + "   turned over twice. ROI/day is that dollar's actual rate, and it is what a\n"
        + "   maxResolutionHours setting is really choosing between.",
    });

  // ---------------------------------------------------------------------------------
  // 3. Market shape, split by whether a stop loss was in force. This is the question the
  // shape filter turns on: it exists because a stop cannot reach a market that jumps, so
  // with the stop OFF the filter has to justify itself on P/L alone.
  console.log(`\n${"=".repeat(112)}`);
  const shapeIds = [...new Set(rows.map((row) => row.shape))].sort();
  table("== 3a. by MARKET SHAPE, portfolios running a STOP LOSS -- where the filter's reason applies",
    shapeIds.map((shape) => [shape, rows.filter((row) => row.stopped && row.shape === shape)]),
    { bar: "self" });
  table("== 3b. by MARKET SHAPE, portfolios with NO STOP LOSS -- the filter has to pay for itself here",
    shapeIds.map((shape) => [shape, rows.filter((row) => !row.stopped && row.shape === shape)]),
    {
      bar: "self",
      note: "   The shape filter was added because a stop loss cannot reach a market that settles\n"
        + "   in one jump. Switch the stop off and that reason is gone, so a shape is worth\n"
        + "   excluding here only if it loses money on its own -- which is a much weaker claim\n"
        + "   and needs far more rows than most of these shapes have.",
    });

  // ---------------------------------------------------------------------------------
  console.log(`\n${"=".repeat(112)}`);
  table("== 4. per portfolio, for orientation only -- these differ in every parameter at once",
    perPortfolio, { bar: "self" });

  console.log("\nDone. Nothing was written.");
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
