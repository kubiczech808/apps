// Read-only. For every live portfolio that is not archived: its rule, and how many DISTINCT
// markets back that exact rule. Places no orders, writes nothing, uses no credentials.
//
// Asked for: "prover na dostupnych datech vsechna soucasna aktivni live portfolia a dej mi
// strucne odpoved, zda je jejich nastaveni nyni optimalni nebo jake doporucujes u kazdeho z
// nich upravy. sve doporuceni dave pouze zda mas k tomu dost dat ktera tvoje tvrzeni podlozi
// alespon 50 trhu s presne danym nastavenim."
//
// "Exactly the given setting" is taken literally, three ways:
//   * live: the portfolio's own resolved trades opened AFTER the last change to any field
//     that decides which markets it buys or how it exits (portfolio-config-history). A trade
//     taken under last week's band says nothing about this week's.
//   * paper: portfolios whose rule is IDENTICAL field for field (stake, name and the
//     automation switch aside), again counted only since their own last rule change.
//   * backtest (dip rules only): the rule replayed on the per-tag caches.
// Every count is of distinct markets, because one market bought by three paper twins is one
// outcome, not three.

import { distinctMarkets, summarise } from "./dip-outcome-analysis.mjs";
import { cacheRows } from "./dip-combination-sweep.mjs";
import { dipRuleOf, gridCells, nearHalf, setupStats, setupTrades } from "./dip-setup-backtest.mjs";

const HOST = (process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading").replace(/\/+$/, "");
export const MIN_MARKETS = Math.max(1, Number(process.env.REVIEW_MIN_MARKETS) || 50);
const CLOSED = new Set(["CLOSED", "WON", "LOST", "REDEEMED", "RESOLVED", "SETTLED", "STOP_LOSS_SOLD"]);

// The fields that decide which markets a portfolio buys and how it leaves them. Everything
// portfolio_config_history_fields() records except the name, the money and the on/off
// switches: two portfolios that differ only in stake run the same rule.
export const RULE_FIELDS = [
  "minProbability", "maxProbability", "maxResolutionHours", "liveEventMode", "requireEventStarted",
  "settlementCloseBid", "selectionOrder", "marketType", "excludedMarketShapes", "probabilitySource",
  "minLiquidityUsdc", "minNetYield", "executionTrigger", "executionCronMinutes", "useLimitOrders",
  "autoRotatePositions", "stopLossRiskMultiplier", "reverseOnStopLoss", "includeOnlyMarketTags",
  "excludedMarketTags", "dipEntryEnabled", "dipEntryOpenMin", "dipEntryOpenMax",
];
// History records name the day-based field too; a change to either is a change of the rule.
const HISTORY_RULE_FIELDS = new Set([...RULE_FIELDS, "maxResolutionDays"]);
const SET_FIELDS = new Set(["excludedMarketShapes", "includeOnlyMarketTags", "excludedMarketTags"]);

const num = (value) => (value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value));
const fraction = (value) => {
  const parsed = num(value);
  return parsed == null ? null : (parsed > 1 ? parsed / 100 : parsed);
};
const lowerList = (value) => (Array.isArray(value) ? value : [])
  .map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean);

// One comparable value per rule field. Probabilities as fractions, sets sorted, the legacy
// over-under switch folded into the excluded shapes, days converted to hours -- so two rows
// saved by different versions of the form compare equal when they run the same rule.
export function ruleSignature(row = {}) {
  const signature = {};
  for (const field of RULE_FIELDS) {
    let value = row?.[field];
    if (value === "") value = null;
    if (field === "maxResolutionHours") {
      value = num(row?.maxResolutionHours) ?? (num(row?.maxResolutionDays) == null ? null : num(row.maxResolutionDays) * 24);
    } else if (SET_FIELDS.has(field)) {
      const items = new Set(lowerList(value));
      if (field === "excludedMarketShapes" && row?.excludeOverUnderMarkets === true) items.add("over-under");
      value = [...items].sort();
    } else if (["minProbability", "maxProbability", "dipEntryOpenMin", "dipEntryOpenMax", "settlementCloseBid"].includes(field)) {
      value = fraction(value);
    } else if (typeof value === "boolean" || value == null) {
      value = value ?? null;
    } else if (num(value) != null && typeof value !== "string") {
      value = num(value);
    } else if (num(value) != null && /^-?\d+(\.\d+)?$/.test(String(value).trim())) {
      value = num(value);
    } else {
      value = String(value);
    }
    signature[field] = value;
  }
  // The dip switch decides what kind of rule this is; "off" and "missing" are the same rule.
  signature.dipEntryEnabled = signature.dipEntryEnabled === true;
  if (!signature.dipEntryEnabled) {
    signature.dipEntryOpenMin = null;
    signature.dipEntryOpenMax = null;
  }
  return signature;
}

export function signatureDiff(left, right) {
  return RULE_FIELDS.filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]));
}

// Every live portfolio the config holds, archived ones left out. The built-in accounts are
// included when the config carries them, under the ids their history and trades use.
export function liveCandidates(config = {}) {
  const out = [];
  for (const [id, row] of Object.entries(config?.livePortfolios || {})) {
    if (!row || typeof row !== "object" || row.archived === true) continue;
    out.push({ mode: `live-custom-${id}`, historyId: `live-custom-${id}`, configId: id, row });
  }
  for (const [key, mode] of [["live", "live"], ["live5050", "live-5050"]]) {
    const row = config?.[key];
    if (!row || typeof row !== "object" || Array.isArray(row) || row.archived === true) continue;
    out.push({ mode, historyId: key, configId: key, row });
  }
  return out;
}

// When did this strategy's rule last change? Only rule fields count: renaming a portfolio or
// pausing it does not reset its evidence. With no rule change in the retained history, the
// rule has held at least since the oldest retained record -- a lower bound, said as one.
export function settingsSince(records = [], strategyId) {
  let latest = null;
  let oldest = null;
  const fields = new Set();
  for (const record of records) {
    const at = String(record?.changedAt || "");
    if (!at) continue;
    if (!oldest || at < oldest) oldest = at;
    for (const change of Array.isArray(record?.changes) ? record.changes : []) {
      if (String(change?.strategyId || "") !== strategyId || !HISTORY_RULE_FIELDS.has(String(change?.field || ""))) continue;
      if (!latest || at > latest.at) latest = { at, fields: new Set() };
      if (at === latest.at) latest.fields.add(String(change.field));
    }
  }
  if (latest) {
    for (const field of latest.fields) fields.add(field);
    return { since: latest.at, lowerBound: false, fields: [...fields].sort() };
  }
  return { since: oldest, lowerBound: true, fields: [] };
}

export function resolvedRows(rows = []) {
  return rows.filter((row) => CLOSED.has(String(row?.status || "").toUpperCase()) && num(row?.realizedPnlUsdc ?? row?.pnlUsdc) != null)
    .map((row) => (row.realizedPnlUsdc == null ? { ...row, realizedPnlUsdc: num(row.pnlUsdc) } : row));
}

// Trades opened at or after `since`. A trade with no opening time cannot be placed after the
// change, so it is not counted as evidence for the current rule.
export function openedSince(rows = [], since = null) {
  if (!since) return rows;
  const floor = Date.parse(since);
  return rows.filter((row) => {
    const at = Date.parse(String(row?.openedAt || row?.date || ""));
    return Number.isFinite(at) && at >= floor;
  });
}

// One line of evidence: distinct markets, wins, P/L, P/L per dollar.
export function evidence(rows = []) {
  const markets = distinctMarkets(rows);
  const s = summarise(markets);
  return { rows: rows.length, markets: markets.length, wins: s.wins, winRate: s.winRate, pnl: s.pnl, perDollar: s.perDollar };
}

// Paper portfolios running the identical rule, and the near ones (at most `maxDiff` fields
// apart) that may show what a different setting would have done.
export function rulePeers(liveRow, paperConfig = {}, maxDiff = 3) {
  const target = ruleSignature(liveRow);
  const exact = [];
  const near = [];
  for (const [id, row] of Object.entries(paperConfig || {})) {
    if (!row || typeof row !== "object") continue;
    const signature = ruleSignature(row);
    if (signature.dipEntryEnabled !== target.dipEntryEnabled) continue;
    const diff = signatureDiff(target, signature);
    if (!diff.length) exact.push({ id, row, diff });
    else if (diff.length <= maxDiff) near.push({ id, row, diff });
  }
  return { exact, near };
}

const pct = (value) => (value == null ? "   -  " : `${(value * 100).toFixed(1)}%`.padStart(6));
const money = (value) => (value == null ? "     -" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`.padStart(8));
const band = (low, high) => `${low == null ? "?" : (low * 100).toFixed(1).replace(/\.0$/, "")}-${high == null ? "?" : (high * 100).toFixed(1).replace(/\.0$/, "")}%`;

export function describeRule(row = {}) {
  const s = ruleSignature(row);
  const parts = [];
  if (s.dipEntryEnabled) parts.push(`DIP open ${band(s.dipEntryOpenMin, s.dipEntryOpenMax)} buy ${band(s.minProbability, s.maxProbability)}`);
  else parts.push(`buy ${band(s.minProbability, s.maxProbability)}`);
  if (s.liveEventMode) parts.push(`event ${s.liveEventMode}`);
  if (s.requireEventStarted === true) parts.push("started only");
  if (s.maxResolutionHours != null) parts.push(`<=${s.maxResolutionHours}h to resolution`);
  if (s.excludedMarketShapes.length) parts.push(`shapes excl [${s.excludedMarketShapes.join(", ")}]`);
  if (s.includeOnlyMarketTags.length) parts.push(`tags only [${s.includeOnlyMarketTags.join(", ")}]`);
  if (s.excludedMarketTags.length) parts.push(`tags excl [${s.excludedMarketTags.join(", ")}]`);
  if (s.minLiquidityUsdc != null) parts.push(`liq>=${s.minLiquidityUsdc}`);
  if (s.minNetYield != null) parts.push(`yield>=${s.minNetYield}`);
  if (s.stopLossRiskMultiplier != null) parts.push(`SLx${s.stopLossRiskMultiplier}`);
  if (s.reverseOnStopLoss === true) parts.push("reverse on SL");
  if (s.marketType) parts.push(`market ${s.marketType}`);
  if (s.selectionOrder) parts.push(`order ${s.selectionOrder}`);
  return parts.join(" | ");
}

// A backtest stats block read as one line of evidence.
export function asEvidence(stats) {
  return {
    markets: stats.trades,
    winRate: stats.winPct == null ? null : stats.winPct / 100,
    pnl: stats.pnlUsdc,
    perDollar: stats.roiPct == null ? null : stats.roiPct / 100,
  };
}

function line(label, item) {
  const verdict = item.markets >= MIN_MARKETS ? "ENOUGH" : "too few";
  return `   ${label.padEnd(34)} ${String(item.markets).padStart(4)} markets  won ${pct(item.winRate)}`
    + `  P/L ${money(item.pnl)}  per $ ${pct(item.perDollar)}   [${verdict} for ${MIN_MARKETS}]`;
}

async function fetchJson(url, label) {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "LivePortfolioReview/1.0" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

async function paperTrades(id) {
  const state = await fetchJson(`${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}`, `paper ${id}`);
  const held = ((state?.state || state)?.paperPortfolios || {})[id] || {};
  return [...(Array.isArray(held.trades) ? held.trades : []), ...(Array.isArray(held.closedTrades) ? held.closedTrades : [])]
    .map((trade) => ({ ...trade, portfolioId: id }));
}

async function cacheFor(tag) {
  try {
    return cacheRows(await fetchJson(`${HOST}/data/dip-backtest-${tag}-cache.json`, `cache ${tag}`));
  } catch {
    return null;
  }
}

// The dip rule replayed on the caches of the tags it may trade, and the best alternative band
// pair that clears the market minimum. Markets are deduplicated across caches by token.
export function dipBacktest(rowsByTag, row, stake = 5) {
  const rule = dipRuleOf(row);
  rule.openMax = Math.min(rule.openMax ?? 0.99, 0.99);
  const seen = new Map();
  for (const rows of rowsByTag.values()) for (const item of rows || []) seen.set(String(item.tokenId || item.question), item);
  const rows = [...seen.values()];
  const trades = setupTrades(rows, rule);
  const clean = trades.filter(({ entry }) => !nearHalf(entry.entryPrice));
  const cells = gridCells(rows, rule).map((cell) => ({ ...cell, stats: setupStats(cell.clean, stake) }));
  // On a tie the current setting wins: a change that earns nothing more is not a recommendation.
  const qualifying = cells.filter((cell) => cell.stats.trades >= MIN_MARKETS)
    .sort((left, right) => (Math.abs(right.stats.pnlUsdc - left.stats.pnlUsdc) > 1e-9
      ? right.stats.pnlUsdc - left.stats.pnlUsdc
      : Number(right.current) - Number(left.current)));
  return {
    rule,
    all: setupStats(trades, stake),
    clean: setupStats(clean, stake),
    best: qualifying[0] || null,
    current: cells.find((cell) => cell.current) || null,
    qualifyingCells: qualifying.length,
  };
}

async function main() {
  console.log(`Live portfolio review at ${new Date().toISOString()}`);
  console.log(`Read-only. Evidence threshold: ${MIN_MARKETS} distinct markets with exactly the rule in question.\n`);
  const config = (await fetchJson(`${HOST}/api.php?action=portfolio-config`, "portfolio config"))?.config || {};
  const history = (await fetchJson(`${HOST}/api.php?action=portfolio-config-history`, "config history").catch(() => ({})))?.records || [];
  const oldestHistory = history.reduce((min, record) => (!min || String(record?.changedAt || "") < min ? String(record?.changedAt || "") : min), null);
  console.log(`config history: ${history.length} record(s) retained, oldest ${oldestHistory || "-"}`);
  const live = await fetchJson(`${HOST}/api.php?action=state&target=live`, "live state");
  const liveState = live?.state || live || {};
  const closed = resolvedRows(Array.isArray(liveState.closedTrades) ? liveState.closedTrades : []);
  const owners = new Map();
  for (const row of closed) owners.set(String(row.portfolioId || "(unattributed)"), (owners.get(String(row.portfolioId || "(unattributed)")) || 0) + 1);
  console.log(`live closed rows: ${closed.length} resolved; by owner: ${[...owners].map(([owner, n]) => `${owner} ${n}`).join(", ")}`);

  const candidates = liveCandidates(config);
  console.log(`live portfolios not archived: ${candidates.length}\n`);
  const paperConfig = config?.paper || {};
  const paperCache = new Map();
  const tradesOf = async (id) => {
    if (!paperCache.has(id)) paperCache.set(id, await paperTrades(id).catch(() => []));
    return paperCache.get(id);
  };
  const tagCaches = new Map();
  const summary = [];

  for (const candidate of candidates) {
    const { mode, historyId, row } = candidate;
    const since = settingsSince(history, historyId);
    console.log(`== ${mode} "${row.displayName || candidate.configId}"   automation ${row.automationEnabled === false ? "PAUSED" : "on"}   stake ${row.stakeUsdc ?? "-"}`);
    console.log(`   rule: ${describeRule(row)}`);
    console.log(`   rule unchanged since ${since.since || "-"}${since.lowerBound ? " (at least; no change retained)" : ` (changed: ${since.fields.join(", ")})`}`);

    const own = closed.filter((trade) => String(trade.portfolioId || "") === mode);
    const ownNow = evidence(openedSince(own, since.since));
    console.log(line("live, all time (any rule)", evidence(own)));
    console.log(line("live, under this exact rule", ownNow));

    const peers = rulePeers(row, paperConfig);
    const twinRows = [];
    for (const twin of peers.exact) {
      const twinSince = settingsSince(history, twin.id);
      const rows = openedSince(resolvedRows(await tradesOf(twin.id)), twinSince.since);
      twinRows.push(...rows);
      console.log(line(`paper twin ${twin.id}${twin.row.archived ? " (archived)" : ""}`, evidence(rows)));
    }
    const realNow = evidence([...openedSince(own, since.since), ...twinRows]);
    console.log(line("REAL, this rule (live + twins)", realNow));
    if (!peers.exact.length) console.log("   (no paper portfolio runs this exact rule)");

    let backtest = null;
    if (ruleSignature(row).dipEntryEnabled) {
      const tags = lowerList(row.includeOnlyMarketTags);
      const wanted = tags.length ? tags : ["tennis", "esports", "counter-strike-2", "soccer", "sports"];
      const rowsByTag = new Map();
      for (const tag of wanted) {
        if (!tagCaches.has(tag)) tagCaches.set(tag, await cacheFor(tag));
        if (tagCaches.get(tag)) rowsByTag.set(tag, tagCaches.get(tag));
      }
      if (rowsByTag.size) {
        backtest = dipBacktest(rowsByTag, row, num(row.stakeUsdc) || 5);
        const label = `backtest [${[...rowsByTag.keys()].join(",")}]${tags.length ? "" : " (no tag filter: partial)"}`;
        console.log(line(`${label}, all`, asEvidence(backtest.all)));
        console.log(line("backtest, without ~0.50 prints", asEvidence(backtest.clean)));
        if (lowerList(row.excludedMarketTags).length) console.log("   (cache rows carry no tags, so the excluded tags are not applied to the backtest)");
        if (backtest.best) {
          const b = backtest.best;
          console.log(`   best band pair with ${MIN_MARKETS}+ clean markets: open ${band(b.open[0], b.open[1])} buy ${band(b.buy[0], b.buy[1])}`
            + `  n ${b.stats.trades}  won ${b.stats.winPct.toFixed(1)}% [${b.stats.winPctLow.toFixed(0)}-${b.stats.winPctHigh.toFixed(0)}]`
            + `  price ${b.stats.meanPricePct.toFixed(1)}%  P/L ${money(b.stats.pnlUsdc)}  ROI ${b.stats.roiPct.toFixed(1)}%${b.current ? "  <- current" : ""}`);
        } else {
          console.log(`   no band pair in the grid reaches ${MIN_MARKETS} clean markets`);
        }
      } else {
        console.log("   backtest: no published cache for the tags this rule trades");
      }
    }
    for (const near of peers.near.slice(0, 6)) {
      const nearSince = settingsSince(history, near.id);
      const item = evidence(openedSince(resolvedRows(await tradesOf(near.id)), nearSince.since));
      if (!item.markets) continue;
      console.log(line(`near: paper ${near.id} [${near.diff.join(",")}]`, item));
      for (const field of near.diff) console.log(`        ${field}: live ${JSON.stringify(ruleSignature(row)[field])}  paper ${JSON.stringify(ruleSignature(near.row)[field])}`);
    }
    console.log("");
    summary.push({ mode, name: row.displayName || candidate.configId, ownNow, realNow, backtest });
  }

  // Last, so a log read from the end starts with the answer.
  console.log(`\n=== summary: distinct markets behind each live portfolio's CURRENT rule (threshold ${MIN_MARKETS}) ===`);
  for (const item of summary) {
    const bt = item.backtest ? `backtest clean ${item.backtest.clean.trades} (${money(item.backtest.clean.pnlUsdc)})` : "backtest n/a";
    const best = item.backtest?.best
      ? `best ${MIN_MARKETS}+ cell open ${band(item.backtest.best.open[0], item.backtest.best.open[1])} buy ${band(item.backtest.best.buy[0], item.backtest.best.buy[1])} n ${item.backtest.best.stats.trades} ${money(item.backtest.best.stats.pnlUsdc)}`
      : "";
    console.log(`   ${item.mode.padEnd(34)} real ${String(item.realNow.markets).padStart(4)} (${money(item.realNow.pnl)})   ${bt}   ${best}`);
    console.log(`      ${item.name}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Live portfolio review failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
