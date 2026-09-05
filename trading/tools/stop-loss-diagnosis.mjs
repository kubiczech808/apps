// Read-only diagnostic. Writes nothing, places nothing.
//
// Reported: in one portfolio's closed trades the two most recent losers sit in LOST with
// no stop loss ever applied. A stop that is armed and then simply not used is worse than
// no stop, so this prints, newest first, every closed row with the fields that decide
// whether a stop could have run: whether protection was on, what floor was derived, what
// the last mark before the close was, and which status the row ended in.
//
// The comparison that matters is lastMark against floor. A position that resolves to zero
// has to travel there, so a last mark above the floor means the market crossed the floor
// on the way down -- a resting sell at the floor would have been taken out by that
// crossing -- and a row like that ending in LOST at full cost is a stop that never ran.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";
// Accepts an id OR a displayed label, because a portfolio gets reported by the name on the
// dashboard ("80-90 sl") and that is not what the config is keyed by.
const STRATEGY_ID = process.env.PAPER_DIAGNOSIS_STRATEGY_ID || "ewportfolio2";
const LIMIT = Math.max(1, Number(process.env.PAPER_DIAGNOSIS_LIMIT || 14));

const looseLabel = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Which portfolio the caller meant: exact id, then exact label, then a loose match that
// ignores spacing and punctuation.
function resolveStrategyId(paperConfig = {}, requested = "") {
  const ids = Object.keys(paperConfig);
  if (paperConfig[requested]) return { id: requested, how: "id" };
  const wanted = looseLabel(requested);
  if (!wanted) return { id: requested, how: "unmatched", ids };
  const byLabel = ids.find((id) => looseLabel(paperConfig[id]?.label) === wanted
    || looseLabel(paperConfig[id]?.displayName) === wanted);
  if (byLabel) return { id: byLabel, how: "label" };
  const contains = ids.find((id) => looseLabel(paperConfig[id]?.label).includes(wanted)
    || looseLabel(paperConfig[id]?.displayName).includes(wanted)
    || looseLabel(id).includes(wanted));
  if (contains) return { id: contains, how: "partial label" };
  return { id: requested, how: "unmatched", ids };
}

async function fetchJson(url, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      const text = await response.text();
      try {
        return { ok: response.ok, status: response.status, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: response.status, error: text.slice(0, 200) };
      }
    } catch (error) {
      if (attempt < attempts) continue;
      return { ok: false, status: 0, error: `read failed: ${error?.message || error}` };
    }
  }
  return { ok: false, status: 0, error: "read failed" };
}

const CLOSED_STATUSES = new Set(["WON", "LOST", "STOP_LOSS", "ROTATED_OUT", "LIMIT_ORDER_EXPIRED", "VOID"]);
const num = (value, digits = 4) => (value == null || value === "" || !Number.isFinite(Number(value))
  ? "-"
  : Number(value).toFixed(digits));

async function main() {
  console.log(`Stop-loss diagnosis for "${STRATEGY_ID}" at ${new Date().toISOString()}\n`);

  const config = await fetchJson(`${HOST}/api.php?action=portfolio-config`);
  const paperConfig = config.ok ? (config.body?.config?.paper || {}) : {};
  const resolved = resolveStrategyId(paperConfig, STRATEGY_ID);
  const strategyId = resolved.id;
  if (resolved.how === "unmatched") {
    console.log(`!! "${STRATEGY_ID}" matched no portfolio id or label.`);
    if (resolved.ids?.length) {
      console.log(`   known: ${resolved.ids.map((id) => `${id} ("${paperConfig[id]?.label ?? "-"}")`).join(", ")}`);
    }
  } else if (resolved.how !== "id") {
    console.log(`   resolved by ${resolved.how} to id "${strategyId}"\n`);
  }
  const row = paperConfig[strategyId] || null;
  if (!row) {
    console.log(`!! ${strategyId} is not in the served portfolio config`);
  } else {
    console.log(`-- configuration --`);
    console.log(`   label / displayName  : ${row.label ?? "-"} / ${row.displayName ?? "-"}`);
    console.log(`   stopLossEnabled      : ${row.stopLossEnabled ?? "-"}`);
    console.log(`   stopLossRiskMultiplier: ${row.stopLossRiskMultiplier ?? "-"}`);
    // The second half of what was asked about: after a stop, open the opposite outcome.
    console.log(`   reverseOnStopLoss    : ${row.reverseOnStopLoss ?? "-"}`);
    console.log(`   useLimitOrders       : ${row.useLimitOrders ?? "-"}`);
    console.log(`   executionTrigger     : ${row.executionTrigger ?? "-"} cronMinutes=${row.executionCronMinutes ?? "-"}`);
  }

  const served = await fetchJson(
    `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(strategyId)}`,
  );
  if (!served.ok) {
    console.log(`\n!! could not read the served state: HTTP ${served.status} ${served.error || ""}`);
    return;
  }
  const entry = (served.body?.paperPortfolios || {})[strategyId];
  if (!entry) {
    console.log(`\n!! ${strategyId} is missing from the served payload`);
    return;
  }
  const trades = Array.isArray(entry.trades) ? entry.trades : [];
  const closed = trades
    .filter((trade) => CLOSED_STATUSES.has(String(trade?.status || "")))
    .sort((a, b) => Date.parse(b?.resolvedAt || b?.closedAt || b?.lastCheckedAt || 0)
      - Date.parse(a?.resolvedAt || a?.closedAt || a?.lastCheckedAt || 0));

  // How the whole closed history splits by status and stop status: a single LOST row is an
  // anecdote, a column of them beside an armed stop is the finding.
  {
    const counts = new Map();
    for (const trade of closed) {
      const key = `${trade.status} / stopLossStatus=${trade.stopLossStatus ?? "-"}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    console.log(`\n-- ${closed.length} closed rows by status --`);
    for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${key.padEnd(46)} ${String(count).padStart(4)}`);
    }
  }

  console.log(`\n-- newest ${Math.min(LIMIT, closed.length)} closed rows --`);
  for (const trade of closed.slice(0, LIMIT)) {
    const floor = Number(trade.stopLossPrice);
    const lastMark = Number(trade.currentPrice);
    // The crossing test. Only meaningful for a loss on a position that had a floor.
    const crossable = Number.isFinite(floor) && Number.isFinite(lastMark) && lastMark > floor;
    const verdict = trade.status !== "LOST"
      ? ""
      : !trade.equalRiskProtection
        ? "  <- no stop protection on this row"
        : !Number.isFinite(floor)
          ? "  <- protection on but no floor was ever derived"
          : crossable
            ? "  <- STOP SHOULD HAVE FILLED: last mark is above the floor"
            : "  <- last mark already at or below the floor";
    console.log(`\n   ${trade.status.padEnd(10)} ${String(trade.resolvedAt || trade.closedAt || "-").slice(0, 19)}`
      + ` ${String(trade.question || "").slice(0, 60)}${verdict}`);
    console.log(`      outcome=${String(trade.outcome || "-").padEnd(10)}`
      + ` entry=${num(trade.entryPrice)} lastMark=${num(trade.currentPrice)}`
      + ` lastLiveBid=${num(trade.lastLiveBid)}`
      + ` final=${num(trade.finalOutcomePrice)}`);
    console.log(`      protection=${String(trade.equalRiskProtection ?? "-").padEnd(5)}`
      + ` floor=${num(trade.stopLossPrice)} riskTarget=${num(trade.riskTargetUsdc, 2)}`
      + ` multiplier=${num(trade.stopLossRiskMultiplier, 2)}`
      + ` stopStatus=${trade.stopLossStatus ?? "-"}`);
    console.log(`      cost=${num(trade.maxLossUsdc ?? trade.stakeUsdc, 2)}`
      + ` realized=${num(trade.realizedPnlUsdc, 4)}`
      + ` capBreach=${num(trade.stopLossCapBreachUsdc, 4)}`
      + ` triggeredAt=${String(trade.stopLossTriggeredAt || "-").slice(0, 19)}`);
    console.log(`      marketClosed=${trade.marketClosed ?? "-"}`
      + ` accepting=${trade.acceptingOrders ?? "-"}`
      + ` lastCheckedAt=${String(trade.lastCheckedAt || "-").slice(0, 19)}`
      + ` closedTime=${String(trade.closedTime || "-").slice(0, 19)}`);
  }

  // The population-level version of the same test: every LOST row that had a floor and a
  // last mark above it. If that set is large, the stop is not occasionally missed -- it is
  // systematically bypassed whenever the market closes between two looks.
  {
    const armed = closed.filter((trade) => trade.status === "LOST" && trade.equalRiskProtection
      && Number.isFinite(Number(trade.stopLossPrice)));
    const shouldHaveFilled = armed.filter((trade) => Number(trade.currentPrice) > Number(trade.stopLossPrice));
    const fullCost = shouldHaveFilled.filter((trade) => {
      const cost = Number(trade.maxLossUsdc ?? trade.stakeUsdc);
      return Number.isFinite(cost) && Math.abs(Number(trade.realizedPnlUsdc) + cost) < 0.01;
    });
    console.log(`\n-- LOST rows that had an armed floor --`);
    console.log(`   with a derived floor                      : ${armed.length}`);
    console.log(`   last mark above the floor (crossed it)    : ${shouldHaveFilled.length}`);
    console.log(`   ... and booked at the full cost anyway    : ${fullCost.length}`);
    const wasted = fullCost.reduce((sum, trade) => {
      const cost = Number(trade.maxLossUsdc ?? trade.stakeUsdc) || 0;
      const target = Number(trade.riskTargetUsdc) || 0;
      return sum + Math.max(0, cost - target);
    }, 0);
    console.log(`   loss beyond the planned target, summed    : ${wasted.toFixed(2)} USDC`);
  }

  // The other half of what was reported: after a stop fills, the opposite outcome is
  // supposed to be opened. That entry is a MARKET order, so barring a market that has
  // genuinely stopped accepting orders it should always produce a position -- a SKIPPED
  // row is therefore a finding, not an outcome, and the reason on it says which.
  {
    const stopped = closed.filter((trade) => String(trade.status || "") === "STOP_LOSS");
    const byStatus = new Map();
    for (const trade of stopped) {
      byStatus.set(trade.stopLossReversalStatus ?? "(never attempted)",
        (byStatus.get(trade.stopLossReversalStatus ?? "(never attempted)") || 0) + 1);
    }
    console.log(`\n-- what happened after each of the ${stopped.length} stops --`);
    if (row?.reverseOnStopLoss !== true) {
      console.log(`   reverseOnStopLoss is ${row?.reverseOnStopLoss ?? "-"} for this portfolio, so no`);
      console.log(`   opposite position is expected. The counts below are history.`);
    }
    for (const [status, count] of [...byStatus].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${String(status).padEnd(24)} ${String(count).padStart(4)}`);
    }
    // "never attempted" means one of two very different things, and only the dates tell
    // them apart: stops that closed before the reverse rule existed (history, nothing to
    // fix) versus stops since then that the rule simply did not reach (a live gap).
    const closedAtOf = (trade) => Date.parse(trade.closedAt || trade.resolvedAt || "") || 0;
    const attempted = stopped.filter((trade) => trade.stopLossReversalAttemptedAt);
    const never = stopped.filter((trade) => !trade.stopLossReversalAttemptedAt);
    if (never.length && attempted.length) {
      const firstAttempt = Math.min(...attempted.map((trade) => closedAtOf(trade)).filter(Boolean));
      const neverSince = never.filter((trade) => closedAtOf(trade) > firstAttempt);
      console.log(`   earliest stop that DID attempt a reverse : ${new Date(firstAttempt).toISOString().slice(0, 19)}`);
      console.log(`   never-attempted stops older than that    : ${never.length - neverSince.length}  (history, before the rule ran)`);
      console.log(`   never-attempted stops NEWER than that    : ${neverSince.length}`
        + `${neverSince.length ? "  <- the rule did not reach these" : ""}`);
      for (const trade of neverSince.slice(0, 5)) {
        console.log(`      ${String(trade.closedAt || trade.resolvedAt || "-").slice(0, 19)}`
          + ` "${String(trade.question || "").slice(0, 46)}" [${trade.outcome}]`);
      }
    }
    // Did the reversal it claims to have opened actually end up in the book of trades?
    // "OPENED" is written next to the source trade; the position is a separate row.
    const byId = new Map(trades.map((trade) => [String(trade.id), trade]));
    const claimed = stopped.filter((trade) => trade.stopLossReversalStatus === "OPENED");
    const missing = claimed.filter((trade) => !byId.has(String(trade.stopLossReversalTradeId || "")));
    console.log(`   reversals recorded as OPENED             : ${claimed.length}`);
    console.log(`   ... whose position is actually present   : ${claimed.length - missing.length}`);
    if (missing.length) {
      console.log(`   ... MISSING from the trade list          : ${missing.length}  <- recorded but never stored`);
    }
    const skipped = stopped.filter((trade) => trade.stopLossReversalStatus === "SKIPPED");
    if (skipped.length) {
      const reasons = new Map();
      for (const trade of skipped) {
        const shape = String(trade.stopLossReversalReason || "-").replace(/-?\d[\d.,]*/g, "N");
        reasons.set(shape, (reasons.get(shape) || 0) + 1);
      }
      console.log(`\n   why the opposite position was not opened:`);
      for (const [shape, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
        console.log(`   ${String(count).padStart(5)}  ${shape.slice(0, 96)}`);
      }
      console.log(`\n   Each of these was attempted once, on the single pass the stop filled, and`);
      console.log(`   never again -- stopLossReversalAttemptedAt blocks any retry. A reason that`);
      console.log(`   was momentary (a quote gap, a fetch error, capital busy for one pass) is`);
      console.log(`   therefore permanent.`);
      for (const trade of skipped.slice(0, 6)) {
        console.log(`      ${String(trade.closedAt || trade.resolvedAt || "-").slice(0, 19)}`
          + ` "${String(trade.question || "").slice(0, 44)}" [${trade.outcome}]`);
        console.log(`        attemptedAt=${String(trade.stopLossReversalAttemptedAt || "-").slice(0, 19)}`
          + `  reason: ${String(trade.stopLossReversalReason || "-").slice(0, 90)}`);
      }
    }
  }
}

main().catch((error) => {
  console.log(`\n!! diagnosis stopped early: ${error?.message || error}`);
  process.exitCode = 1;
});
