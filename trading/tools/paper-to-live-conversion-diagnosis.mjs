// Read-only diagnostic. Places no orders, writes nothing, needs no secrets.
//
// Asked for: "if I set up a new live portfolio with the remaining balance, configured
// identically to a paper portfolio that is winning, will the total P/L grow?"
//
// The paper result cannot answer that on its own, and the reason is not a bug anywhere.
// The paper bot fills every candidate it selects, at the price it was shown, for free:
// slippage 0, taker fee 0, totalCostUsdc == stake. Live has to find a counterparty. So a
// live portfolio does not trade the paper portfolio's trades -- it trades the SUBSET of
// them that somebody was willing to take the other side of, and the paper P/L is only a
// forecast for live if that subset is a fair sample of the whole.
//
// It may not be. Whoever sells us a share at 0.78 chooses to, and if they are better
// informed about that market than we are, the orders that fill are the ones we should not
// want and the orders that go unfilled are the ones we should. That is adverse selection,
// and it would explain "paper wins, live bleeds" completely, with no defect in either
// codebase -- which is exactly why it has to be measured rather than assumed. The
// alternative explanations (fees, the minimum-order floor, the spread) are all small and
// all already measured; this one is not bounded by anything.
//
// So: every order the live portfolios ever placed, split by whether it filled, scored
// against how that market actually resolved. The resolution is a fact about the market,
// not about who traded it, so it can be read from ANY portfolio's history -- the account's
// own closed trades, or any paper portfolio's row for the same token. That is what makes
// an UNFILLED order scoreable at all, and it is the whole trick here.
//
// What this cannot do: an unfilled order whose token nothing else ever resolved stays
// unscored, and that shrinks the sample. The coverage is printed rather than hidden,
// because a win rate over 9 of 300 orders is not a finding.
import { pathToFileURL } from "node:url";

const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

// Sequential and retried, never concurrent: a 128 MB shared host answers 500 when several
// state payloads decode at once, which reads as a broken endpoint rather than as too much
// asked for at once.
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

const num = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const pct = (value) => (value == null ? "    - " : `${(value * 100).toFixed(1).padStart(5)}%`);
const usd = (value) => (value == null ? "     -" : `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2).padStart(6)}`);
const clip = (value, width) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, width).padEnd(width);

// How a market resolved, per token. A token is one outcome of one market, so "this token
// paid out" is a property of the market and whoever holds it -- paper or live -- observes
// the same thing. Deliberately keyed by token and not by question: matching on the
// question would pair our YES against somebody else's NO and score it backwards.
// Three tiers of evidence, and the difference between them decides the whole report.
//
// SETTLED  the row carries a settlement price at 0 or 1: the market itself said so.
// STATUS   the row says WON or LOST.
// PNL      neither, so only the sign of the P/L is left.
//
// PNL is the weak one and it is weak in a specific, dangerous direction: a position SOLD
// EARLY at a loss on a market that went on to resolve in our favour reads as a loss there.
// The live account is full of exactly those -- 115 of its closed rows are early sales -- so
// scoring live orders off the P/L sign measures "the exits gave money back", and reporting
// that as "the picks were bad" is the one way to get this backwards.
//
// So the best evidence anywhere wins, not the first source read. This was first-writer-wins
// and the live account is read first, which handed every early sale a PNL verdict even when
// a paper portfolio held the same token to settlement and knew the real answer.
const EVIDENCE_RANK = { settled: 3, status: 2, pnl: 1 };

export function outcomeByToken(sources) {
  const outcomes = new Map();
  for (const { label, trades } of sources) {
    for (const row of trades) {
      const tokenId = String(row?.tokenId || row?.assetId || "");
      if (!tokenId) continue;
      const status = String(row?.status || "").toUpperCase();
      // An expired resting bid never held the token, so it says nothing about the
      // resolution. Neither does a row still open.
      if (["OPEN", "PENDING", "PENDING_FILL", "UNFILLED", "CANCELLED", "LIMIT_ORDER_WAITING",
        "LIMIT_ORDER_EXPIRED", "LIVE_LIMIT_ORDER_UNFILLED"].includes(status)) continue;
      const exitPrice = num(row?.exitPrice ?? row?.finalOutcomePrice);
      const pnl = num(row?.realizedPnlUsdc ?? row?.pnlUsdc);
      let won = null;
      let evidence = null;
      if (exitPrice != null && (exitPrice >= 0.99 || exitPrice <= 0.01)) {
        won = exitPrice >= 0.99;
        evidence = "settled";
      } else if (status === "WON" || status === "LOST") {
        won = status === "WON";
        evidence = "status";
      } else if (pnl != null) {
        won = pnl > 0;
        evidence = "pnl";
      }
      if (won == null) continue;
      const existing = outcomes.get(tokenId);
      if (existing && EVIDENCE_RANK[existing.evidence] >= EVIDENCE_RANK[evidence]) continue;
      outcomes.set(tokenId, { won, via: label, exitPrice, evidence });
    }
  }
  return outcomes;
}

// Which entry attempts a live portfolio's run log records, and what became of each. One
// row per (token, price, time): the same token ordered twice is two attempts, because the
// question is about orders and not about markets.
export function liveOrderAttempts(executionState) {
  const attempts = [];
  const records = [executionState, ...(Array.isArray(executionState?.runLog) ? executionState.runLog : [])]
    .filter((record) => record && typeof record === "object");
  for (const record of records) {
    const at = String(record.generatedAt || record.runAt || "");
    const rows = Array.isArray(record.attempts) ? record.attempts : [];
    for (const row of rows) {
      const action = String(row?.action || "").toUpperCase();
      if (action.startsWith("DRY_RUN")) continue;
      const tokenId = String(row?.tokenId || "");
      if (!tokenId) continue;
      attempts.push({
        tokenId,
        at,
        action,
        orderPrice: num(row?.orderPrice),
        shares: num(row?.orderSize ?? row?.shares),
        status: String(row?.responseStatus ?? "").toLowerCase(),
        question: row?.question || record?.selected?.question || "",
      });
    }
  }
  return attempts;
}

// Did this order end up as shares in the account?
//
// The exchange's answer is not enough by itself and this is the whole reason the fate
// diagnosis exists: `matched` is a fill, `live` is a resting order, `unmatched` did not
// execute, and `delayed` is a queued match that usually -- but not always -- becomes one.
// The account is the second witness and it outranks the response: if the token is in the
// positions or the closed history, it filled, whatever the response said at the time.
export function attemptFilled(attempt, { heldTokens, closedTokens }) {
  if (heldTokens.has(attempt.tokenId) || closedTokens.has(attempt.tokenId)) {
    return { filled: true, via: "account" };
  }
  if (attempt.status === "matched") return { filled: true, via: "response" };
  if (attempt.action.includes("REJECT")) return { filled: false, via: "rejected" };
  if (!attempt.status) return { filled: false, via: "never-submitted" };
  // Accepted by the exchange and yet nothing is held: a fill-and-kill order that was
  // killed, or a resting order that was cancelled or expired.
  return { filled: false, via: attempt.status };
}

function rate(won, total) {
  return total > 0 ? won / total : null;
}

// One standard error on a win rate, so the two groups can be compared honestly rather than
// by eye. A ten-point difference over 30 orders is noise and has to read as noise.
function sigmaOfDifference(a, b) {
  if (!a.total || !b.total) return null;
  const pa = a.won / a.total;
  const pb = b.won / b.total;
  const pooled = (a.won + b.won) / (a.total + b.total);
  const variance = pooled * (1 - pooled) * (1 / a.total + 1 / b.total);
  if (!(variance > 0)) return null;
  return (pa - pb) / Math.sqrt(variance);
}

async function main() {
  console.log(`Paper-to-live conversion diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: no order is placed, nothing is written, no credentials are used.\n");

  const configPayload = await fetchJson(`${HOST}/api.php?action=portfolio-config&t=${Date.now()}`);
  const config = configPayload?.config || configPayload || {};
  const livePayload = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const live = livePayload?.liveState || livePayload?.state || livePayload || {};

  const liveClosed = [
    ...(Array.isArray(live.closedTrades) ? live.closedTrades : []),
    ...(Array.isArray(live.trades?.closed) ? live.trades.closed : []),
  ];
  const heldTokens = new Set((Array.isArray(live.positions) ? live.positions : [])
    .map((row) => String(row?.tokenId || row?.assetId || "")).filter(Boolean));
  const closedTokens = new Set(liveClosed
    .map((row) => String(row?.tokenId || row?.assetId || "")).filter(Boolean));

  // Every paper portfolio's settled history, which is where most of the resolutions come
  // from: the paper bot trades the same candidate pool the live one does, so it has an
  // opinion on far more tokens than the account ever held.
  const overviewPayload = await fetchJson(
    `${HOST}/api.php?action=state&target=paper&summary=portfolio-overview&t=${Date.now()}`,
  );
  const overview = overviewPayload?.botState || overviewPayload?.state || overviewPayload || {};
  const paperIds = Object.keys(config.paper || {});
  const resolutionSources = [{ label: "live account", trades: liveClosed }];
  for (const id of paperIds) {
    let trades = Array.isArray(overview?.paperPortfolios?.[id]?.trades)
      ? overview.paperPortfolios[id].trades : null;
    if (!trades) {
      // The unnamed paper summary decodes the whole evaluation archive and answers 500 on
      // this host, so each portfolio is asked for by strategy_id instead.
      try {
        const payload = await fetchJson(
          `${HOST}/api.php?action=state&target=paper&summary=dashboard&strategy_id=${encodeURIComponent(id)}&t=${Date.now()}`,
        );
        const state = payload?.botState || payload?.state || payload || {};
        trades = Array.isArray(state?.paperPortfolios?.[id]?.trades) ? state.paperPortfolios[id].trades : [];
      } catch (error) {
        console.log(`   !! could not read paper portfolio ${id}: ${error?.message || error}`);
        trades = [];
      }
    }
    resolutionSources.push({ label: `paper:${id}`, trades });
  }
  const outcomes = outcomeByToken(resolutionSources);
  console.log("== 0. where a market's resolution can be looked up");
  for (const source of resolutionSources) {
    const withToken = source.trades.filter((row) => String(row?.tokenId || row?.assetId || "")).length;
    console.log(`   ${clip(source.label, 22)} ${String(source.trades.length).padStart(5)} settled row(s),`
      + ` ${String(withToken).padStart(5)} carry a tokenId`);
  }
  const tiers = new Map();
  for (const outcome of outcomes.values()) tiers.set(outcome.evidence, (tiers.get(outcome.evidence) || 0) + 1);
  console.log(`   -> ${outcomes.size} token(s) with a known resolution, by strength of evidence:`);
  for (const tier of ["settled", "status", "pnl"]) {
    if (!tiers.get(tier)) continue;
    const note = tier === "settled" ? "settlement price at 0 or 1 -- the market said so"
      : tier === "status" ? "the row says WON or LOST"
        : "only the P/L sign, so an early sale at a loss reads as a loss";
    console.log(`      ${String(tiers.get(tier)).padStart(5)}  ${tier.padEnd(8)} ${note}`);
  }
  console.log("");

  const liveIds = [
    ...(config.live && typeof config.live === "object" ? [["live", config.live, "live-execution"]] : []),
    ...(config.live5050 && typeof config.live5050 === "object"
      ? [["live5050", config.live5050, "live-5050-execution"]] : []),
    ...Object.entries(config.livePortfolios || {})
      .filter(([, row]) => row && typeof row === "object")
      .map(([id, row]) => [`live-custom-${id}`, row, `live-custom-${id}-execution`]),
  ];

  const pooled = { filled: { won: 0, total: 0 }, unfilled: { won: 0, total: 0 } };
  const pooledHard = { filled: { won: 0, total: 0 }, unfilled: { won: 0, total: 0 } };
  const pooledPrices = [];

  for (const [id, row, target] of liveIds) {
    const name = String(row.displayName || id);
    console.log(`${"=".repeat(88)}`);
    console.log(`${id}  "${name}"  automation ${row.automationEnabled === true ? "ON" : "off"}`);
    console.log("=".repeat(88));

    let execution = null;
    try {
      const payload = await fetchJson(`${HOST}/api.php?action=state&target=${target}&t=${Date.now()}`);
      execution = payload?.state || payload || null;
    } catch (error) {
      console.log(`   !! could not read ${target}: ${error?.message || error}\n`);
      continue;
    }
    const attempts = liveOrderAttempts(execution);
    if (!attempts.length) {
      console.log("   no entry attempt in the retained run log\n");
      continue;
    }
    const runs = 1 + (Array.isArray(execution?.runLog) ? execution.runLog.length : 0);
    console.log(`   ${attempts.length} entry attempt(s) across ${runs} retained run(s)`);

    // ------------------------------------------------------------------------------
    console.log("\n   1. the fill funnel: what the exchange said, and what the account holds");
    const byStatus = new Map();
    for (const attempt of attempts) {
      const verdict = attemptFilled(attempt, { heldTokens, closedTokens });
      attempt.fill = verdict;
      const key = `${attempt.status || "(no response)"}`;
      const bucket = byStatus.get(key) || { total: 0, filled: 0 };
      bucket.total += 1;
      if (verdict.filled) bucket.filled += 1;
      byStatus.set(key, bucket);
    }
    console.log("      response       attempts   became shares   fill rate");
    for (const [status, bucket] of [...byStatus].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`      ${clip(status, 14)} ${String(bucket.total).padStart(8)}`
        + `   ${String(bucket.filled).padStart(13)}   ${pct(rate(bucket.filled, bucket.total))}`);
    }
    const filledAll = attempts.filter((attempt) => attempt.fill.filled);
    console.log(`      ${clip("TOTAL", 14)} ${String(attempts.length).padStart(8)}`
      + `   ${String(filledAll.length).padStart(13)}   ${pct(rate(filledAll.length, attempts.length))}`);
    console.log("      A paper portfolio's fill rate is 100% by construction, so this is the first");
    console.log("      thing that does not carry over: the live portfolio trades this fraction of the");
    console.log("      candidates its paper twin would have traded.");

    // ------------------------------------------------------------------------------
    console.log("\n   2. adverse selection: did the orders that DIDN'T fill resolve better?");
    console.log("      If they did, the counterparty was choosing which of our orders to take, and");
    console.log("      the paper P/L is not a forecast for live at any setting -- the fills are a");
    console.log("      biased sample of the selections, not a smaller one.");
    const groups = { filled: { won: 0, total: 0 }, unfilled: { won: 0, total: 0 } };
    const prices = { filled: [], unfilled: [] };
    // The same split again over the two strong evidence tiers only. If the weak tier is
    // what drags the win rate down, the picks were fine and the EXITS gave the money back,
    // which is a completely different problem with a completely different fix.
    const hard = { filled: { won: 0, total: 0 }, unfilled: { won: 0, total: 0 } };
    const filledPrices = { won: [], lost: [] };
    let unscored = 0;
    for (const attempt of attempts) {
      const outcome = outcomes.get(attempt.tokenId);
      const group = attempt.fill.filled ? "filled" : "unfilled";
      if (attempt.orderPrice != null) prices[group].push(attempt.orderPrice);
      if (!outcome) {
        unscored += 1;
        continue;
      }
      groups[group].total += 1;
      if (outcome.won) groups[group].won += 1;
      pooled[group].total += 1;
      if (outcome.won) pooled[group].won += 1;
      if (outcome.evidence !== "pnl") {
        hard[group].total += 1;
        if (outcome.won) hard[group].won += 1;
        pooledHard[group].total += 1;
        if (outcome.won) pooledHard[group].won += 1;
      }
      if (group === "filled" && attempt.orderPrice != null) {
        filledPrices[outcome.won ? "won" : "lost"].push(attempt.orderPrice);
        pooledPrices.push(attempt.orderPrice);
      }
    }
    const mean = (values) => (values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
    console.log("\n      group      scored   won   win rate   mean order price   unscored");
    for (const group of ["filled", "unfilled"]) {
      console.log(`      ${clip(group, 9)} ${String(groups[group].total).padStart(7)}`
        + ` ${String(groups[group].won).padStart(5)}   ${pct(rate(groups[group].won, groups[group].total))}`
        + `   ${(mean(prices[group]) ?? 0).toFixed(4).padStart(16)}`
        + `   ${String(prices[group].length - groups[group].total).padStart(8)}`);
    }
    console.log("      the same rows, counting only settlement-price and WON/LOST evidence:");
    for (const group of ["filled", "unfilled"]) {
      console.log(`      ${clip(group, 9)} ${String(hard[group].total).padStart(7)}`
        + ` ${String(hard[group].won).padStart(5)}   ${pct(rate(hard[group].won, hard[group].total))}`);
    }

    // The bar the picks have to clear. Buying a share at p and holding it to settlement
    // breaks even at a win rate of exactly p, so the mean order price IS the break-even
    // win rate -- and comparing the two is the only way to tell an edge from a habit of
    // buying favourites. A portfolio can win 87% of its trades and still lose money.
    const meanFilled = mean(prices.filled);
    if (meanFilled != null && groups.filled.total > 0) {
      const observed = rate(groups.filled.won, groups.filled.total);
      const se = Math.sqrt(meanFilled * (1 - meanFilled) / groups.filled.total);
      console.log(`\n      mean price paid ${meanFilled.toFixed(4)} => break-even win rate ${pct(meanFilled)};`
        + ` observed ${pct(observed)}`);
      console.log(`      edge ${observed - meanFilled >= 0 ? "+" : ""}${((observed - meanFilled) * 100).toFixed(1)} pts`
        + `  (${se > 0 ? ((observed - meanFilled) / se).toFixed(2) : "-"} sigma on ${groups.filled.total} order(s))`);
      console.log(`      mean price of the ones that won ${(mean(filledPrices.won) ?? 0).toFixed(4)},`
        + ` of the ones that lost ${(mean(filledPrices.lost) ?? 0).toFixed(4)}`);
    }
    const sigma = sigmaOfDifference(groups.filled, groups.unfilled);
    console.log(`      ${unscored} attempt(s) had no resolvable outcome and are excluded above`);
    if (sigma == null) {
      console.log("      -> not enough scored orders on both sides to compare");
    } else {
      console.log(`      -> filled minus unfilled win rate = ${((rate(groups.filled.won, groups.filled.total) || 0)
        - (rate(groups.unfilled.won, groups.unfilled.total) || 0) >= 0 ? "+" : "")}`
        + `${(((rate(groups.filled.won, groups.filled.total) || 0)
          - (rate(groups.unfilled.won, groups.unfilled.total) || 0)) * 100).toFixed(1)} pts`
        + `  (${sigma.toFixed(2)} sigma)`);
      console.log(`      ${Math.abs(sigma) < 2
        ? "Below 2 sigma: consistent with the fills being a FAIR sample. Not proof of one."
        : sigma < 0
          ? "The unfilled orders resolved BETTER. That is adverse selection, and it is the answer."
          : "The filled orders resolved better, which is the opposite of adverse selection."}`);
    }

    // ------------------------------------------------------------------------------
    console.log("\n   3. what the filled orders actually earned, per the account");
    const ownClosed = liveClosed.filter((closed) => attempts
      .some((attempt) => attempt.tokenId === String(closed?.tokenId || closed?.assetId || "")
        && attempt.orderPrice != null
        && Math.abs(num(closed?.entryPrice ?? closed?.avgPrice, NaN) - attempt.orderPrice) < 0.02));
    const realized = ownClosed.reduce((sum, closed) => sum + (num(closed?.realizedPnlUsdc ?? closed?.pnlUsdc) || 0), 0);
    const invested = ownClosed.reduce((sum, closed) => sum + (num(closed?.totalCostUsdc ?? closed?.stakeUsdc) || 0), 0);
    console.log(`      ${ownClosed.length} closed row(s) matched to this log by token and price`);
    console.log(`      realized ${usd(realized)} on ${invested.toFixed(2)} invested = ${pct(invested > 0 ? realized / invested : null)}`);
    console.log("");
  }

  console.log("=".repeat(88));
  console.log("POOLED across every live portfolio");
  console.log("=".repeat(88));
  for (const group of ["filled", "unfilled"]) {
    console.log(`   ${clip(group, 9)} ${String(pooled[group].total).padStart(5)} scored`
      + ` ${String(pooled[group].won).padStart(5)} won   ${pct(rate(pooled[group].won, pooled[group].total))}`
      + `   |  strong evidence only: ${String(pooledHard[group].total).padStart(4)} scored`
      + ` ${String(pooledHard[group].won).padStart(4)} won   ${pct(rate(pooledHard[group].won, pooledHard[group].total))}`);
  }

  // Question one, and the one this report can actually answer: did the orders that DID
  // fill clear the bar the price they were bought at sets?
  const meanPooled = pooledPrices.length
    ? pooledPrices.reduce((sum, value) => sum + value, 0) / pooledPrices.length : null;
  if (meanPooled != null && pooled.filled.total > 0) {
    for (const [label, group] of [["all evidence", pooled.filled], ["strong evidence only", pooledHard.filled]]) {
      if (!group.total) continue;
      const observed = group.won / group.total;
      const se = Math.sqrt(meanPooled * (1 - meanPooled) / group.total);
      console.log(`\n   ${label}: mean price paid ${meanPooled.toFixed(4)}, so break-even is`
        + ` ${pct(meanPooled)}; observed ${pct(observed)}`);
      console.log(`      edge ${observed - meanPooled >= 0 ? "+" : ""}${((observed - meanPooled) * 100).toFixed(1)} pts`
        + `  (${se > 0 ? ((observed - meanPooled) / se).toFixed(2) : "-"} sigma on ${group.total} order(s))`);
    }

    // The gap between those two lines IS the finding, and neither line alone is the answer,
    // so the report says so itself rather than leaving the reader to pick the flattering one.
    //
    // Every order in the weak tier is a position SOLD BEFORE RESOLUTION. Its market's real
    // outcome is recorded nowhere -- we stopped holding the token, so the account never
    // learned how it settled, and no paper portfolio held that exact token either. Scoring
    // it by the P/L sign is therefore an assumption, not a measurement: it assumes every
    // position we sold at a loss was one that would have lost anyway.
    const weak = pooled.filled.total - pooledHard.filled.total;
    const weakWins = pooled.filled.won - pooledHard.filled.won;
    if (weak > 0) {
      console.log(`\n   ${weak} of the ${pooled.filled.total} scored order(s) rest on the P/L sign alone`
        + ` (${weakWins} of them counted as wins).`);
      console.log("   Every one is a position sold before its market resolved, so its true outcome is");
      console.log("   recorded nowhere. That makes the two lines above a LOWER and an UPPER bound:");
      console.log(`      lower ${pct(pooled.filled.won / pooled.filled.total)}`
        + " -- assumes every position sold at a loss was a market that would have lost anyway");
      console.log(`      upper ${pct(pooledHard.filled.won / pooledHard.filled.total)}`
        + " -- counts only the markets that actually reached settlement");
      console.log("   The truth is between them, and which end decides whether the ENTRIES or the");
      console.log("   EXITS are what costs this account money. If the upper bound clears break-even");
      console.log("   and the lower does not, the picks are paying and the exit policy is not.");
    }
  }

  // Question two, which needs unfilled orders to be scoreable at all. It usually is not:
  // an unfilled order's token only has a resolution if some paper portfolio happened to
  // hold that exact token, and mostly none did. Reported as unanswered rather than as no.
  const pooledSigma = sigmaOfDifference(pooled.filled, pooled.unfilled);
  console.log("");
  if (pooledSigma == null) {
    console.log("   ADVERSE SELECTION: UNANSWERED. No unfilled order has a resolvable outcome, so");
    console.log("   whether the counterparty was picking which of our orders to take cannot be");
    console.log("   measured from this data -- neither confirmed nor ruled out. Answering it needs");
    console.log("   the resolution of the markets we did NOT end up holding, which nothing records.");
  } else {
    const gap = (rate(pooled.filled.won, pooled.filled.total) || 0)
      - (rate(pooled.unfilled.won, pooled.unfilled.total) || 0);
    console.log(`   ADVERSE SELECTION: filled minus unfilled = ${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)} pts`
      + ` (${pooledSigma.toFixed(2)} sigma)`);
    console.log(Math.abs(pooledSigma) < 2
      ? "   Below 2 sigma: consistent with the fills being a fair sample. Not proof of one."
      : pooledSigma < 0
        ? "   The unfilled orders resolved BETTER. Cloning a winning paper config to live cannot\n"
          + "   be expected to reproduce its P/L."
        : "   The filled orders resolved better, which is the opposite of adverse selection.");
  }
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
