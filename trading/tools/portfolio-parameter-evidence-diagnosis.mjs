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

// A trade's tag slugs. The paper bot's rowTagSlugs is not exported and this needs only the
// same fields, so it reads them directly rather than reaching into the module -- the fields
// are the market's own, carried on the stored row precisely so a re-quote cannot lose them.
const TAG_FIELDS = ["polymarketTags", "tags", "firstPolymarketTags", "firstTags"];
const TAG_CATEGORY_FIELDS = ["riskCategory", "category", "firstCategory"];

function tradeTags(trade) {
  const slugify = (value) => String(value ?? "")
    .trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const tags = new Set();
  for (const field of TAG_FIELDS) {
    for (const raw of (Array.isArray(trade?.[field]) ? trade[field] : [])) {
      const tag = slugify(raw && typeof raw === "object" ? (raw.slug || raw.label || raw.name || "") : raw);
      if (tag) tags.add(tag);
    }
  }
  for (const field of TAG_CATEGORY_FIELDS) {
    const tag = slugify(trade?.[field]);
    if (tag) tags.add(tag);
  }
  return tags;
}

// One standard error on a proportion. Valid ONLY inside a narrow price bucket, because it
// compares the win rate to the MEAN price, and a mean is not a break-even once the prices
// in the bucket differ: a pool of 0.60 and 0.98 trades has two different bars, not one at
// 0.79. The first run of this report reported -18 sigma on a pool whose ROI was -0.6%,
// which is that approximation breaking, not a finding. Kept for the price buckets, where
// the spread inside a bucket is two cents.
function sigma(won, total, bar) {
  if (!(total > 0) || !(bar > 0) || !(bar < 1)) return null;
  const se = Math.sqrt(bar * (1 - bar) / total);
  return se > 0 ? ((won / total) - bar) / se : null;
}

// The significance test that works at ANY price mix, and the one every table below the
// price buckets needs.
//
// Under "the market priced it fairly", a share bought at p for stake S pays S(1-p)/p with
// probability p and -S otherwise, so its expected P/L is exactly zero and its variance is
// S^2(1-p)/p. Expectations and variances add, so the whole pool's expected P/L is zero and
// z is just the realized total over the root of the summed variance. No mean price, no
// single break-even win rate, nothing to break when the prices differ.
//
// It is conservative where a stop loss was in force: a capped loss is smaller than -S, so
// the real variance is below this and the real z above it. Erring that way is the right
// direction for a number a decision rests on.
function poolZ(rows) {
  let total = 0;
  let variance = 0;
  for (const row of rows) {
    if (row.pnl == null) continue;
    total += row.pnl;
    const stake = row.stake;
    const price = row.entry;
    if (stake == null || price == null || !(price > 0) || !(price < 1)) continue;
    variance += (stake * stake) * (1 - price) / price;
  }
  return variance > 0 ? total / Math.sqrt(variance) : null;
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

// showEmpty matters where the emptiness IS the finding. The stacked-filter section asked
// for five combinations and printed one, because the other four matched nothing and this
// skipped them -- so a filter that selects zero trades read as a filter that was never
// asked about. Same class of fault as a report pooling zero trades and saying "Done".
function table(title, buckets, { bar = null, note = null, showEmpty = false } = {}) {
  console.log(`\n${title}`);
  if (note) console.log(note);
  console.log("   bucket           n  decided   won   win%   break-even  sigma"
    + "     total P/L    staked     ROI       z    mean hold   ROI/day  full-stake");
  for (const [label, rows] of buckets) {
    if (!rows.length) {
      if (showEmpty) console.log(`   ${pad(label, 14)}    0   -- no trade matches this combination --`);
      continue;
    }
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
      + `  ${(() => { const z = poolZ(rows); return z == null ? "      -" : z.toFixed(2).padStart(6); })()}`
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
  // No win%-vs-mean-price sigma here on purpose: these pools span 0.60 to 1.00, where a
  // mean price is not a break-even and that statistic is meaningless. z is the valid one.
  console.log("   minProbability      n  decided   won   win%   mean price     total P/L    staked     ROI       z");
  for (const edge of edges) {
    const kept = rows.filter((row) => row.entry != null && row.entry >= edge - 1e-9);
    if (kept.length < 10) continue;
    const stats = summarize(kept);
    const z = poolZ(kept);
    console.log(`   >= ${edge.toFixed(2)}       ${String(stats.n).padStart(6)}`
      + ` ${String(stats.decided).padStart(8)} ${String(stats.won).padStart(5)}`
      + `  ${pct(stats.decided ? stats.won / stats.decided : null)}`
      + `        ${stats.meanEntry == null ? "    -" : (stats.meanEntry * 100).toFixed(1).padStart(5)}`
      + `    ${usd(stats.pnl)}  ${stats.stake.toFixed(2).padStart(8)}  ${pct(stats.roi)}`
      + `  ${z == null ? "      -" : z.toFixed(2).padStart(6)}`);
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
    // `!trades` alone was the whole bug in the first run: the overview summary is trimmed
    // and carries an EMPTY trades array, an empty array is truthy, so the per-portfolio
    // fetch below never fired and the report pooled 0 trades across 0 portfolios while
    // saying nothing was wrong. Length, not existence, is the question being asked.
    if (!trades || !trades.length) {
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
      // How far away the market's resolution was WHEN WE BOUGHT, which is the quantity
      // maxResolutionHours actually filters on -- and a different thing from how long the
      // position was then held. A leg entered while the match is running and a leg entered
      // two days before kick-off are the same SHAPE and completely different bets, and only
      // this number tells them apart.
      const endDate = Date.parse(trade?.endDate || trade?.resolutionEndDate || "");
      const storedDays = num(trade?.firstDaysToResolution ?? trade?.daysToResolution);
      const horizonHours = Number.isFinite(endDate) && Number.isFinite(openedAt) && endDate > openedAt
        ? (endDate - openedAt) / 3600000
        : (storedDays != null && storedDays >= 0 ? storedDays * 24 : null);
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
        horizonHours,
        tags: tradeTags(trade),
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
  if (!rows.length) {
    // The first run printed every table empty and said "Done", which reads as "the data
    // says nothing" rather than "the data never arrived". A report cannot be allowed to
    // fail quietly when its whole purpose is to answer a question from evidence.
    console.log(`   !! nothing to analyse. ${Object.keys(config.paper || {}).length} paper portfolio(s)`
      + " in the config; every one returned no settled trade.");
    process.exitCode = 1;
    return;
  }
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
  // The horizon AT ENTRY, which is what maxResolutionHours sets -- as opposed to section 2,
  // which is how long the position turned out to be held. Asked directly: does in-event-leg
  // still look good when the bet can be placed 48 hours before the event?
  console.log(`\n${"=".repeat(112)}`);
  const horizonBands = [
    ["< 3h", (hours) => hours < 3],
    ["3-12h", (hours) => hours >= 3 && hours < 12],
    ["12-24h", (hours) => hours >= 12 && hours < 24],
    ["24-48h", (hours) => hours >= 24 && hours < 48],
    ["48-96h", (hours) => hours >= 48 && hours < 96],
    ["> 96h", (hours) => hours >= 96],
  ];
  const withHorizon = rows.filter((row) => row.horizonHours != null);
  console.log(`   ${withHorizon.length} of ${rows.length} row(s) carry a resolution date, so the rest are absent below.`);
  table("== 5. by HOW FAR AWAY RESOLUTION WAS WHEN WE BOUGHT -- this is the maxResolutionHours setting",
    horizonBands.map(([label, test]) => [label, withHorizon.filter((row) => test(row.horizonHours))]),
    { bar: "self" });

  // And the cross-tab that is the actual question. A shape's pooled ROI is an average over
  // whatever horizons it happened to be bought at; if the good rows are all short-horizon,
  // then raising maxResolutionHours admits a population the number says nothing about.
  console.log(`\n${"=".repeat(112)}`);
  console.log("== 6. SHAPE x HORIZON. A shape's headline ROI is an average over the horizons it");
  console.log("   happened to be bought at. If its winners are all short-horizon, a 48h setting");
  console.log("   lets in trades the headline number has no evidence about.");
  for (const shape of shapeIds) {
    const shapeRows = withHorizon.filter((row) => row.shape === shape);
    if (shapeRows.length < 20) continue;
    table(`   -- ${shape} (${shapeRows.length} row(s) with a resolution date)`,
      horizonBands.map(([label, test]) => [label, shapeRows.filter((row) => test(row.horizonHours))]),
      { bar: "self" });
  }

  // ---------------------------------------------------------------------------------
  // A stacked config is not the intersection of two headline numbers, it is its own much
  // smaller sample. "esports" scored well and "in-event-leg" scored well, and the portfolio
  // set to BOTH trades neither of those populations -- it trades the overlap, and the only
  // honest thing to report about the overlap is how many rows are in it.
  console.log(`\n${"=".repeat(112)}`);
  const tagged = rows.filter((row) => row.tags && row.tags.size);
  console.log(`== 7. STACKED FILTERS -- ${tagged.length} of ${rows.length} row(s) carry any tag at all`);
  if (!tagged.length) {
    console.log("   No settled trade carries a tag, so nothing below can be cut by one. The tag");
    console.log("   fields live on the market rather than the quote; if they are absent here they");
    console.log("   were absent from the stored row, and a tag-filtered result cannot be checked.");
  } else {
    const esports = tagged.filter((row) => [...row.tags].some((tag) => /esport|counter-strike|league-of-legends|dota|valorant|cs2|csgo/.test(tag)));
    const combos = [
      ["esports, any shape", esports],
      ["esports + in-event-leg", esports.filter((row) => row.shape === "in-event-leg")],
      ["esports + outright", esports.filter((row) => row.shape === "outright")],
      ["esports 0.70-0.80", esports.filter((row) => row.entry != null && row.entry >= 0.70 && row.entry < 0.80)],
      ["esports 0.70-0.80 + leg", esports.filter((row) => row.entry != null && row.entry >= 0.70
        && row.entry < 0.80 && row.shape === "in-event-leg")],
      ["everything, any tag", tagged],
    ];
    table("   the combination as configured, and each filter on its own for comparison",
      combos, { bar: "self", showEmpty: true });
    console.log(`   tags actually present, most common first: ${(() => {
      const counts = new Map();
      for (const row of tagged) for (const tag of row.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14)
        .map(([tag, count]) => `${tag}(${count})`).join(" ");
    })()}`);
    console.log("   That list is printed because a combination matching nothing is far more often a");
    console.log("   filter written against tags the stored rows do not carry than a real absence.");
    console.log("   Read the n column first. A row with fewer than ~50 trades cannot distinguish a");
    console.log("   real edge from noise at any ROI, and stacking two filters is how a few hundred");
    console.log("   rows becomes a few dozen.");
  }

  // ---------------------------------------------------------------------------------
  console.log(`\n${"=".repeat(112)}`);
  table("== 8. per portfolio, for orientation only -- these differ in every parameter at once",
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
