// Runs offline: no secrets, no network, no hosting access.
// Deterministic portfolio constants must be set before the module is imported,
// because the bot reads them from the environment at import time.
process.env.PAPER_PORTFOLIO_USDC = "100";
process.env.PAPER_MAX_FRACTION = "0.05";
process.env.PAPER_MIN_ANNUALIZATION_DAYS = String(1 / 24);
process.env.PAPER_FULL_CADENCE_MINUTES = "55";
process.env.PAPER_REPORT_CADENCE_MINUTES = "55";

import assert from "node:assert/strict";
import test from "node:test";

const bot = await import("../tools/paper-trading-bot.mjs");

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

test("economics: taker fee follows shares * rate * price * (1 - price)", () => {
  const fee = bot.takerFeeForFills([{ size: 10, price: 0.9 }], 0.02);
  // 10 * 0.02 * 0.9 * 0.1 = 0.018
  assert.equal(fee, 0.018);
  assert.equal(bot.takerFeeForFills([{ size: 10, price: 0.9 }], 0), 0, "no fee when the market has no fee rate");
  assert.equal(bot.takerFeeForFills([{ size: 10, price: 0.9 }], -1), 0, "a negative rate must never credit the trade");
});

test("economics: net yield is measured against the real stake, not the target win", () => {
  // $0.30 net gain on a $5 stake is a 6% yield, not a 300% one.
  assert.equal(bot.netYieldAfterFees({ netGainIfWinUsdc: 0.3, stakeUsdc: 5 }), 0.06);
  assert.equal(
    bot.netYieldAfterFees({ netGainIfWinUsdc: 0.3, totalCostUsdc: 5, stakeUsdc: 1 }),
    0.06,
    "total cost wins over a bare stake because it already includes fees",
  );
  assert.equal(bot.netYieldAfterFees({ netGainIfWinUsdc: 0.3, stakeUsdc: 0 }), null, "a zero stake has no yield");
  assert.equal(bot.netYieldAfterFees({}), null);
  assert.equal(bot.netYieldAfterFees({ netYield: 0.04, netGainIfWinUsdc: 99, stakeUsdc: 1 }), 0.04, "stored yield is authoritative");
});

test("economics: stake sizing uses the deposit, never the potential win", () => {
  assert.equal(bot.totalCost({ totalCostUsdc: 5.02, maxLossUsdc: 5, stakeUsdc: 5 }), 5.02);
  assert.equal(bot.totalCost({ maxLossUsdc: 5, stakeUsdc: 4 }), 5);
  assert.equal(bot.totalCost({ stakeUsdc: 5 }), 5);
  assert.equal(bot.totalCost({}), 0);
  // A "Win @ $5" figure must never be mistaken for the order size.
  assert.equal(bot.totalCost({ potentialWinUsdc: 5 }), 0);
});

test("economics: a 0.0 day horizon is floored at one hour, not left unbounded", () => {
  const hour = 1 / 24;
  assert.equal(bot.annualizationDays(0), hour, "the horizon is floored at one hour");
  assert.equal(bot.annualizationDays(0.0001), hour);
  assert.equal(bot.annualizationDays(7), 7);
  assert.equal(bot.annualizationDays("nonsense"), null);

  const potential = bot.annualizedPotentialReturn(0.01, 0);
  assert.equal(potential, 0.01 * (365 / hour));
  assert.ok(Number.isFinite(potential), "a zero horizon must never divide by zero");
});

test("economics: same-day horizons rank apart instead of collapsing", () => {
  // The reason the floor moved from a day to an hour: the strategy targets markets
  // resolving today or already running, and a one-day floor gave every one of them
  // the same potential p.a., so a live event could not outrank one hours away.
  const netYield = 0.111121;
  const pa = (days) => bot.annualizedPotentialReturn(netYield, days);

  assert.ok(pa(0.1) > pa(0.3), "a market two hours out must outrank one seven hours out");
  assert.ok(pa(0.3) > pa(0.5), "and that ordering must hold across the whole day");
  assert.ok(pa(0.02) === pa(0.04), "below one hour they still share the floor");
  assert.equal(pa(1 / 24), netYield * 365 * 24, "one hour is the first horizon reported directly");
});

test("economics: potential P.A. scales with the remaining horizon", () => {
  assert.equal(bot.annualizeReturn(0.01, 7), 0.01 * (365 / 7));
  assert.equal(bot.annualizeReturn(0.01, 365), 0.01);
  assert.equal(bot.annualizeReturn(null, 7), null);
  assert.ok(
    bot.annualizedPotentialReturn(0.01, 3) > bot.annualizedPotentialReturn(0.01, 30),
    "a nearer resolution must rank higher for the same yield",
  );
});

test("economics: percentages never divide by a zero or negative basis", () => {
  assert.equal(bot.pnlPercent(5, 100), 0.05);
  assert.equal(bot.pnlPercent(5, 0), null);
  assert.equal(bot.pnlPercent(5, -100), null);
  assert.equal(bot.pnlPercent(0, 100), 0);
});

test("economics: a market buy prices through the book, not at the best ask", () => {
  const fill = bot.simulateMarketBuy(
    [{ price: 0.9, size: 2 }, { price: 0.95, size: 100 }],
    5,
  );
  // The first level only holds 0.9 * 2 = $1.80, so the rest fills at 0.95.
  assert.ok(fill.avgPrice > fill.bestAsk, "average execution price must include slippage");
  assert.equal(fill.bestAsk, 0.9);
  assert.ok(fill.slippage > 0);
  assert.equal(fill.filledUsdc, 5);
  assert.equal(fill.fillable, true);

  const thin = bot.simulateMarketBuy([{ price: 0.9, size: 1 }], 5);
  assert.equal(thin.fillable, false, "a book that cannot absorb the stake is not fillable");
});

test("portfolio: equity is initial capital plus realized and open P/L", () => {
  const portfolioState = {
    id: "conservative",
    label: "Paper - Conservative",
    trades: [
      { status: "WON", realizedPnlUsdc: 0.25, stakeUsdc: 5 },
      { status: "LOST", realizedPnlUsdc: -5, stakeUsdc: 5 },
      { status: "OPEN", unrealizedPnlUsdc: 0.1, stakeUsdc: 5, maxLossUsdc: 5 },
    ],
    portfolio: {},
  };
  bot.updatePaperPortfolio(portfolioState);
  const result = portfolioState.portfolio;

  assert.equal(result.realizedPnlUsdc, -4.75, "realized P/L sums every booked trade");
  assert.equal(result.openPnlUsdc, 0.1, "open P/L only marks positions that are still open");
  assert.equal(result.equityUsdc, 100 - 4.75 + 0.1);
  assert.equal(result.totalPnlUsdc, -4.65);
  assert.equal(result.totalPnlPct, bot.pnlPercent(-4.65, 100), "total P/L % is measured against original value");
});

test("portfolio: cash reserved by an open position is not free capital", () => {
  const withOpen = {
    id: "conservative",
    trades: [{ status: "OPEN", stakeUsdc: 5, maxLossUsdc: 5 }],
    portfolio: {},
  };
  bot.updatePaperPortfolio(withOpen);
  assert.equal(withOpen.portfolio.openRiskUsdc, 5);
  assert.equal(withOpen.portfolio.freeCapitalUsdc, 95, "the $5 at risk is not available for a new trade");

  // A position awaiting resolution still ties up capital.
  assert.equal(bot.openRisk([{ status: "PENDING_RESOLUTION", stakeUsdc: 5 }]), 5);
  assert.equal(bot.openRisk([{ status: "MARKET_NOT_FOUND", stakeUsdc: 5 }]), 5);
  // Closed trades release it.
  assert.equal(bot.openRisk([{ status: "WON", stakeUsdc: 5 }]), 0);
  assert.equal(bot.openRisk([{ status: "LOST", stakeUsdc: 5 }]), 0);
});

test("portfolio: an empty portfolio reports original value and full free capital", () => {
  const empty = { id: "conservative", trades: [], portfolio: {} };
  bot.updatePaperPortfolio(empty);
  assert.equal(empty.portfolio.equityUsdc, 100);
  assert.equal(empty.portfolio.realizedPnlUsdc, 0);
  assert.equal(empty.portfolio.freeCapitalUsdc, 100);
  assert.equal(empty.portfolio.openRiskUsdc, 0);
});

test("portfolio: persisting a state must not strip the computed aggregates", () => {
  // The reported dashboard bug. writeState() normalizes right before writing, and
  // normalizePaperPortfolio rebuilt `portfolio` from a configuration-only
  // whitelist, so equity and P/L never reached the published file. The frontend
  // then fell back to initialUsdc / 0 and showed "$100.00, +$0.00, $0.00 risk"
  // forever. Shape and numbers below mirror the live conservative portfolio
  // measured in production: 9 trades, 4 WON, realized 0.734, unrealized 0.079.
  const live = {
    paperPortfolios: {
      conservative: {
        trades: [
          { id: "w1", status: "WON", realizedPnlUsdc: 0.184, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "w2", status: "WON", realizedPnlUsdc: 0.18, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "w3", status: "WON", realizedPnlUsdc: 0.19, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "w4", status: "WON", realizedPnlUsdc: 0.18, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "o1", status: "OPEN", unrealizedPnlUsdc: 0.04, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "o2", status: "OPEN", unrealizedPnlUsdc: 0.039, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "p1", status: "PENDING_RESOLUTION", unrealizedPnlUsdc: 0, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "p2", status: "PENDING_RESOLUTION", unrealizedPnlUsdc: 0, stakeUsdc: 5, maxLossUsdc: 5 },
          { id: "p3", status: "PENDING_RESOLUTION", unrealizedPnlUsdc: 0, stakeUsdc: 5.16, maxLossUsdc: 5.16 },
        ],
        portfolio: {},
      },
    },
  };

  const persisted = bot.normalizeState(live);
  const conservative = persisted.paperPortfolios.conservative.portfolio;

  for (const field of [
    "equityUsdc", "realizedPnlUsdc", "realizedPnlPct", "openPnlUsdc",
    "openPnlPct", "totalPnlUsdc", "totalPnlPct", "openRiskUsdc", "freeCapitalUsdc",
  ]) {
    assert.ok(
      conservative[field] !== undefined,
      `${field} must survive normalization, otherwise the dashboard tile renders a default`,
    );
  }

  assert.equal(conservative.realizedPnlUsdc, 0.734, "the four settled wins must be booked");
  assert.ok(conservative.equityUsdc > 100, `equity must exceed the opening balance, got ${conservative.equityUsdc}`);
  assert.ok(conservative.openRiskUsdc > 0, "five open or pending positions still tie up capital");
  assert.ok(conservative.freeCapitalUsdc < 100, "free capital cannot still be the full opening balance");
  // The exact symptom, asserted so it can never silently return.
  assert.notEqual(conservative.equityUsdc, 100);
  assert.notEqual(conservative.totalPnlUsdc, 0);
});

test("portfolio: aggregates survive a repeated normalize round-trip", () => {
  const state = {
    paperPortfolios: {
      conservative: {
        trades: [{ id: "w1", status: "WON", realizedPnlUsdc: 0.25, stakeUsdc: 5, maxLossUsdc: 5 }],
        portfolio: {},
      },
    },
  };
  const once = bot.normalizeState(state);
  const twice = bot.normalizeState(once);
  assert.equal(
    twice.paperPortfolios.conservative.portfolio.equityUsdc,
    once.paperPortfolios.conservative.portfolio.equityUsdc,
  );
  assert.equal(twice.paperPortfolios.conservative.portfolio.realizedPnlUsdc, 0.25);
});

test("portfolio: normalization keeps the per-portfolio stake fraction", () => {
  // portfolio-config is the source of truth; the global fraction must not win.
  const portfolioState = {
    id: "highReward",
    maxFraction: 0.12,
    trades: [],
    portfolio: {},
  };
  bot.updatePaperPortfolio(portfolioState);
  assert.equal(portfolioState.portfolio.maxFraction, 0.12);
  assert.equal(portfolioState.portfolio.maxStakeUsdc, Number((100 * 0.12).toFixed(2)));
});

test("portfolio: closed trades with no booked P/L cannot invent equity", () => {
  // The counterpart guard: aggregates are derived, never fabricated.
  const unbooked = {
    id: "conservative",
    trades: [
      { status: "RESOLVED", finalOutcomePrice: 1, stakeUsdc: 5 },
      { status: "RESOLVED", finalOutcomePrice: 1, stakeUsdc: 5 },
    ],
    portfolio: {},
  };
  bot.updatePaperPortfolio(unbooked);
  assert.equal(unbooked.portfolio.equityUsdc, 100);
  assert.equal(unbooked.portfolio.realizedPnlUsdc, 0);
  assert.equal(unbooked.portfolio.openRiskUsdc, 0, "RESOLVED releases the reserved cash");
});

test("bootstrap: only the multi-portfolio schema may ever restore production", () => {
  assert.equal(bot.stateHasCurrentSchema({ paperPortfolios: { conservative: {} } }), true);
  // The legacy single-portfolio shape, which is what the old repository seed uses.
  assert.equal(bot.stateHasCurrentSchema({ portfolio: {}, trades: [], runLog: [] }), false);
  assert.equal(bot.stateHasCurrentSchema({ paperPortfolios: [] }), false, "an array is not the keyed schema");
  assert.equal(bot.stateHasCurrentSchema({}), false);
  assert.equal(bot.stateHasCurrentSchema(null), false);
  assert.equal(bot.stateHasCurrentSchema(undefined), false);
});

test("bootstrap: normalizing a legacy snapshot still yields all three portfolios", () => {
  const migrated = bot.normalizeState({
    portfolio: { initialUsdc: 100 },
    trades: [{ id: "t1", status: "WON", realizedPnlUsdc: 0.2, stakeUsdc: 5 }],
    runLog: [],
  });
  assert.deepEqual(
    Object.keys(migrated.paperPortfolios).sort(),
    ["conservative", "highReward", "moreProbable"],
  );
  assert.equal(migrated.paperPortfolios.conservative.trades.length, 1);
  // Migration is for reading, and does not license republishing the seed.
  assert.equal(bot.stateHasCurrentSchema({ portfolio: {}, trades: [] }), false);
});

test("cadence: a cold state runs the full portfolio pass", () => {
  assert.equal(bot.resolveScheduledCadence({}).stage, "full");
  assert.equal(bot.resolveScheduledCadence({ cadence: {} }).stage, "full");
});

test("cadence: frequent scans must not starve an overdue portfolio pass", () => {
  // The reported regression: scans kept running while portfolios stood still.
  const starved = { cadence: { lastScanAt: minutesAgo(2), lastReportAt: minutesAgo(2), lastFullAt: minutesAgo(180) } };
  assert.equal(bot.resolveScheduledCadence(starved).stage, "full");
});

test("cadence: a completed pass is not immediately repeated", () => {
  const state = { generatedAt: new Date().toISOString(), cadence: {} };
  bot.markCadenceStage(state, "full");
  assert.equal(bot.resolveScheduledCadence(state).stage, "scan", "a full pass also satisfies the report cadence");

  const boundary = { cadence: { lastFullAt: minutesAgo(54), lastReportAt: minutesAgo(1) } };
  assert.equal(bot.resolveScheduledCadence(boundary).stage, "scan");
  const due = { cadence: { lastFullAt: minutesAgo(55), lastReportAt: minutesAgo(1) } };
  assert.equal(bot.resolveScheduledCadence(due).stage, "full");
});

test("cadence: a scan never satisfies the portfolio pass", () => {
  const state = { generatedAt: new Date().toISOString(), cadence: { lastFullAt: minutesAgo(200) } };
  bot.markCadenceStage(state, "scan");
  assert.equal(bot.resolveScheduledCadence(state).stage, "full");
});

test("cadence: an overdue report runs once the full pass is current", () => {
  const state = { cadence: { lastFullAt: minutesAgo(10), lastReportAt: minutesAgo(90) } };
  assert.equal(bot.resolveScheduledCadence(state).stage, "report");
});

test("cadence: a stale snapshot can never rewind the clocks", () => {
  const merged = bot.mergeCadence(
    { lastFullAt: minutesAgo(10), lastReportAt: minutesAgo(10), lastRunAt: minutesAgo(10), lastStage: "full" },
    { lastFullAt: minutesAgo(30000), lastReportAt: minutesAgo(30000), lastRunAt: minutesAgo(30000), lastStage: "full" },
  );
  assert.equal(bot.resolveScheduledCadence({ cadence: merged }).stage, "scan");
  assert.equal(merged.lastFullAt, minutesAgo(10).slice(0, 16) + merged.lastFullAt.slice(16));
  assert.ok(Date.parse(merged.lastFullAt) > Date.parse(minutesAgo(20)), "the later timestamp wins");
});

test("cadence: unparseable timestamps are treated as never, not as recent", () => {
  assert.equal(bot.resolveScheduledCadence({ cadence: { lastFullAt: "not-a-date" } }).stage, "full");
  assert.equal(bot.normalizeCadence({ lastFullAt: "nope" }).lastFullAt, null);
  assert.equal(bot.minutesSinceIso(""), Infinity);
  assert.equal(bot.minutesSinceIso(undefined), Infinity);
});

test("cadence is persisted through normalizeState", () => {
  const state = { generatedAt: new Date().toISOString(), cadence: {} };
  bot.markCadenceStage(state, "full");
  const persisted = bot.normalizeState(state);
  assert.equal(persisted.cadence.lastFullAt, state.cadence.lastFullAt);
  assert.equal(persisted.cadence.lastStage, "full");
});

test("risk: two markets on the same event share a risk key", () => {
  // Diversification is enforced by key overlap, so two different questions about
  // one Fed meeting must collide rather than both becoming candidates.
  const cut = bot.riskProfile({
    question: "Will the Fed cut rates at the September meeting?",
    slug: "fed-cut-september",
    eventSlug: "fed-september-decision",
    outcome: "Yes",
    tags: ["fed"],
  });
  const hold = bot.riskProfile({
    question: "Will the Fed hold rates at the September meeting?",
    slug: "fed-hold-september",
    eventSlug: "fed-september-decision",
    outcome: "Yes",
    tags: ["fed"],
  });
  assert.ok(cut.keys.length > 0, "a market must expose risk keys");
  const shared = cut.keys.filter((key) => hold.keys.includes(key));
  assert.ok(shared.length > 0, `same-event markets must overlap, got ${JSON.stringify(cut.keys)} vs ${JSON.stringify(hold.keys)}`);

  // A genuinely unrelated market must not collide with it.
  const unrelated = bot.riskProfile({
    question: "Will Real Madrid beat Barcelona?",
    slug: "real-madrid-barcelona",
    eventSlug: "laliga-clasico",
    outcome: "Yes",
    tags: ["sports"],
  });
  assert.equal(
    cut.keys.filter((key) => unrelated.keys.includes(key)).length,
    0,
    "unrelated markets must not block each other",
  );
});

test("risk: both sides of one football match collide", () => {
  const home = bot.riskProfile({
    question: "Will Arsenal beat Chelsea?",
    slug: "arsenal-chelsea",
    eventSlug: "arsenal-vs-chelsea",
    outcome: "Yes",
    tags: ["sports"],
  });
  const away = bot.riskProfile({
    question: "Will Chelsea beat Arsenal?",
    slug: "chelsea-arsenal",
    eventSlug: "arsenal-vs-chelsea",
    outcome: "Yes",
    tags: ["sports"],
  });
  assert.ok(
    home.keys.filter((key) => away.keys.includes(key)).length > 0,
    "the same fixture must be one risk group regardless of which side is quoted",
  );
});

test("fixture: the committed paper fixture matches the current schema", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8");
  const fixture = JSON.parse(raw);

  assert.equal(bot.stateHasCurrentSchema(fixture), true, "the fixture must never regress to the legacy schema");
  assert.deepEqual(
    Object.keys(fixture.paperPortfolios).sort(),
    ["conservative", "highReward", "moreProbable"],
    "all three paper portfolios must be present",
  );

  for (const [name, portfolio] of Object.entries(fixture.paperPortfolios)) {
    assert.ok(portfolio.trades.length > 0, `${name} must carry trades`);
    for (const field of ["equityUsdc", "realizedPnlUsdc", "openPnlUsdc", "openRiskUsdc", "freeCapitalUsdc", "totalPnlUsdc"]) {
      assert.equal(typeof portfolio.portfolio[field], "number", `${name}.${field} must be a number`);
    }
    assert.notEqual(portfolio.portfolio.equityUsdc, 100, `${name} equity must be realistic, not the bare opening balance`);
    assert.ok(portfolio.portfolio.openRiskUsdc > 0, `${name} must hold capital at risk`);
    assert.ok(portfolio.portfolio.freeCapitalUsdc < 100, `${name} free capital must reflect the reserved cash`);
    assert.ok(portfolio.runLog.length > 0, `${name} must carry a run log`);
  }

  // A losing portfolio and a winning one, so P/L formatting is exercised both ways.
  assert.ok(fixture.paperPortfolios.highReward.portfolio.realizedPnlUsdc < 0);
  assert.ok(fixture.paperPortfolios.conservative.portfolio.realizedPnlUsdc > 0);

  const statuses = new Set(
    Object.values(fixture.paperPortfolios).flatMap((p) => p.trades.map((t) => t.status)),
  );
  for (const expected of ["OPEN", "WON", "LOST", "PENDING_RESOLUTION"]) {
    assert.ok(statuses.has(expected), `the fixture must include a ${expected} trade`);
  }

  assert.ok(fixture.marketObservations.length > 0, "scraped opportunities must be present");
  assert.ok(fixture.evaluations.length > 0, "evaluated opportunities must be present");
  assert.ok(fixture.marketScanHistory.length > 0, "a scan log must be present");

  // Only the four global statuses are allowed on opportunities.
  const allowed = new Set(["SCRAPED", "EVALUATED", "RESOLVED", "ERROR"]);
  for (const row of [...fixture.marketObservations, ...fixture.evaluations]) {
    assert.ok(allowed.has(String(row.status)), `unexpected opportunity status ${row.status}`);
  }

  // Anonymized: no real wallet, order or account identifiers.
  assert.ok(!/0x[a-fA-F0-9]{40}/.test(raw), "the fixture must not contain any wallet address");
});

test("fixture: normalizing the fixture is a no-op for its aggregates", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8"));
  const renormalized = bot.normalizeState(fixture);
  for (const name of ["conservative", "highReward", "moreProbable"]) {
    assert.equal(
      renormalized.paperPortfolios[name].portfolio.equityUsdc,
      fixture.paperPortfolios[name].portfolio.equityUsdc,
      `${name} equity must be stable across a normalize round-trip`,
    );
  }
});

test("candidates: the precheck column has no WAITING state", async () => {
  // The precheck column is informational. Execution revalidates every shortlisted
  // candidate from scratch and the shortlist is dispatched without consulting the
  // column, so a retryable verdict from a previous run is not a gate. Guarding the
  // vocabulary here keeps WAITING from silently returning as a pseudo-state.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const precheckLine = app.split("\n").find((line) => line.includes("const precheck ="));
  assert.ok(precheckLine, "the precheck label assignment must exist");
  assert.match(precheckLine, /"EXCLUDED"/);
  assert.match(precheckLine, /"RISK-BLOCKED"/);
  assert.match(precheckLine, /"READY"/);
  assert.doesNotMatch(precheckLine, /WAITING/, "a retryable verdict must not render as its own precheck state");

  // The retention rule must survive: a temporary block keeps the row in the
  // shortlist so the next run can retry it, while a permanent failure drops it.
  assert.ok(
    app.includes("!executionCheck.retryable"),
    "retryable revalidation verdicts must still keep the candidate in the shortlist",
  );

  // The dispatched shortlist must not be filtered by the precheck column.
  const payload = app.slice(app.indexOf("function liveWorkflowPayload"), app.indexOf("async function fetchFreshState"));
  assert.doesNotMatch(payload, /precheck|retryable|RISK-BLOCKED/, "the shortlist dispatch must not depend on precheck state");
});

test("annualization: the reported shortlist figures came from the old one-day floor", () => {
  // Kept as the record of the diagnosis: 0.111121 * 365 / 1 day = 4,055.9%, which is
  // why six candidates between 0.1 and 0.5 days all reported the same number. With
  // the one-hour floor those same rows now differ.
  const netYield = 0.111121;
  const oldFloorPa = (days) => Number((netYield * 365 / Math.max(1, days) * 100).toFixed(1));
  assert.equal(oldFloorPa(0.1), 4055.9);
  assert.equal(oldFloorPa(0.5), 4055.9);

  const now = (days) => Number((bot.annualizedPotentialReturn(netYield, days) * 100).toFixed(1));
  assert.notEqual(now(0.1), now(0.5), "the same two rows must no longer tie");
  assert.ok(now(0.1) > now(0.5));
});

test("annualization: the floor is what keeps a 0.0 day horizon finite", () => {
  assert.equal(bot.annualizationDays(0), 1 / 24);
  const withFloor = bot.annualizedPotentialReturn(0.111121, 0);
  assert.ok(Number.isFinite(withFloor), "a zero horizon must stay finite");
  assert.equal(withFloor, 0.111121 * 365 * 24, "a zero horizon reports the one-hour figure");
});

test("annualization: the floor is identical in the bot, the executor and the UI", async () => {
  // Three independent copies of this constant exist. If they drift, the shortlist
  // the browser ranks stops matching the shortlist the executor trades.
  const { readFile } = await import("node:fs/promises");
  const [app, executor] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
  ]);

  assert.equal(bot.annualizationDays(0.3), 0.3, "a horizon above the floor is used as-is");
  assert.equal(bot.annualizationDays(0), 1 / 24, "bot floor is one hour");
  assert.match(app, /const MIN_ANNUALIZATION_DAYS = 1 \/ 24;/, "UI floor must stay one hour");
  assert.match(
    executor,
    /MIN_ANNUALIZATION_DAYS = Math\.max\(ONE_HOUR_IN_DAYS, envNumber\("LIVE_MIN_ANNUALIZATION_DAYS", ONE_HOUR_IN_DAYS\)\)/,
    "executor floor must stay one hour and must never fall below it",
  );

  // The UI must annualize with the same formula, otherwise the displayed ranking
  // metric is not the one execution uses.
  assert.match(app, /value \* \(365 \/ horizon\)/);
});

test("resolved observations: the last live quote survives settlement", () => {
  // A settled book prints 0 or 1. Without a preserved value every resolved row in
  // the scraped list would read 0% or 100% instead of the probability the market
  // carried while it was tradable.
  const live = bot.withLastLiveMarketProbability({ status: "SCRAPED", marketProbability: 0.93 });
  assert.equal(live.lastLiveMarketProbability, 0.93);

  // While tradable it tracks the current quote, it does not freeze on the first one.
  const moved = bot.withLastLiveMarketProbability({ ...live, marketProbability: 0.97 });
  assert.equal(moved.lastLiveMarketProbability, 0.97);

  // Once resolved it freezes, whatever the book now says.
  const settled = bot.withLastLiveMarketProbability({ ...moved, status: "RESOLVED", marketProbability: 1 });
  assert.equal(settled.lastLiveMarketProbability, 0.97, "settlement must not overwrite the last live quote");
  const again = bot.withLastLiveMarketProbability({ ...settled, marketProbability: 0 });
  assert.equal(again.lastLiveMarketProbability, 0.97, "a later resolution update must not move it either");

  // Resolving while the book still quotes normally captures that quote.
  const captured = bot.withLastLiveMarketProbability({ status: "RESOLVED", marketProbability: 0.88 });
  assert.equal(captured.lastLiveMarketProbability, 0.88);

  // A row that is already settled and never had a live quote stays untouched.
  const noQuote = bot.withLastLiveMarketProbability({ status: "RESOLVED", marketProbability: 1 });
  assert.equal(noQuote.lastLiveMarketProbability, undefined);

  // marketClosed / acceptingOrders count as resolved even without the status.
  const closed = bot.withLastLiveMarketProbability({ marketProbability: 0.91, marketClosed: true });
  assert.equal(closed.lastLiveMarketProbability, 0.91);
  const frozenByClose = bot.withLastLiveMarketProbability({ ...closed, marketProbability: 1, marketClosed: true });
  assert.equal(frozenByClose.lastLiveMarketProbability, 0.91);
});

test("resolved observations: the scraped view surfaces them without a days filter", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, api] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../api.php", import.meta.url), "utf8"),
  ]);

  // The backend must send resolved rows, otherwise the tab can never list or count them.
  assert.match(api, /function is_resolved_scraped_market_observation/);
  assert.match(api, /\$active = array_merge\(\$active, \$resolved\);/);
  // And the fields the tab needs must survive compaction.
  for (const field of ["'lastLiveMarketProbability'", "'finalOutcomePrice'", "'marketClosed'", "'acceptingOrders'"]) {
    assert.ok(api.includes(field), `compact_market_observation must keep ${field}`);
  }

  // No tradability filter may apply to a resolved row, and all of them are hidden there.
  assert.match(app, /if \(scrapedObservationStatus\(item\) === "RESOLVED"\) return true;/);
  assert.match(app, /function tradabilityFiltersAreIrrelevant/);
  assert.match(app, /element\.hidden = scanLog \|\| tradabilityFiltersAreIrrelevant\(\);/);
  // The markup must mark every one of them, or a leftover value silently empties the tab.
  const marked = (await readFile(new URL("../index.html", import.meta.url), "utf8"))
    .split("\n").filter((line) => line.includes("data-tradability-filter"));
  assert.equal(marked.length, 3, "days left, net yield and liquidity must all be marked");
  for (const needle of ["evaluation-days-control", "evaluation-net-yield-control", "evaluation-liquidity-control"]) {
    assert.ok(marked.some((line) => line.includes(needle)), `${needle} must be a tradability filter`);
  }

  // The asset cache-busting version must be stamped at deploy time. A hand-written
  // tag that nobody bumps ships new JS that every browser ignores.
  const deploy = await readFile(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");
  assert.match(deploy, /Stamp asset cache-busting versions/);
  assert.match(deploy, /ASSET_VERSION: \$\{\{ github\.sha \}\}/);
  // The displayed probability goes through the preserving helper.
  assert.match(app, /function scrapedDisplayProbability/);
  assert.match(app, /probability\(Number\(scrapedDisplayProbability\(item\)\)\)/);
});

test("fixture: resolved observations carry a preserved live probability", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8"));
  const resolved = fixture.marketObservations.filter((row) => String(row.status).toUpperCase() === "RESOLVED");
  assert.ok(resolved.length >= 2, "the fixture must exercise the Resolved tab");

  for (const row of resolved) {
    const preserved = Number(row.lastLiveMarketProbability);
    assert.ok(preserved > 0 && preserved < 1, `${row.id} must keep a live probability, got ${preserved}`);
    assert.equal(row.finalOutcomePrice, 1, `${row.id} must report its settlement outcome separately`);
  }

  // The already-settled row proves the settled book did not overwrite the quote.
  const settled = resolved.find((row) => Number(row.marketProbability) >= 1);
  assert.ok(settled, "one resolved row must already show a settled book");
  assert.equal(settled.lastLiveMarketProbability, 0.96);
});

test("manual scan: publication is confirmed against the runner, not the browser clock", async () => {
  // The reported failure: the scan workflow succeeded and its run really was in the
  // published state (id scan-2026-08-04T20:27:55.054Z, uploaded at 20:28:00), yet the
  // UI reported the data as unpublished. The old check compared the runner's
  // timestamps against `new Date()` in the browser, so a clock a few minutes off
  // rejected a publication that had plainly landed.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const fn = app.slice(
    app.indexOf("function scrapedScanWasPublishedAfter"),
    app.indexOf("function loadScrapeRunHistory"),
  );
  assert.ok(fn.length > 0, "the publication check must exist");
  assert.doesNotMatch(fn, /startedAt/, "the check must not depend on a browser timestamp");
  assert.doesNotMatch(fn, /Date\.now\(\)/, "nor on the browser clock at all");
  assert.match(fn, /baseline\.newestScanTime/, "it compares against the pre-dispatch snapshot");

  // A successful workflow must never be reported as an error just because the
  // publication was not observed within the wait.
  assert.match(app, /return \{ state: lastState, confirmed: false \};/);
  assert.doesNotMatch(app, /its new scraped data has not been published yet/);
  assert.match(app, /Scan completed\. Its results are still being published/);
});

test("closed trades: the Resolution column shows Polymarket's date, not our close time", async () => {
  // Reported bug: every closed live row repeated its own Closed timestamp in the
  // Resolution column, because the date accessor fell back to closedTime and then
  // resolvedAt whenever Polymarket's endDate was absent.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const accessor = app.slice(
    app.indexOf("function tradeResolutionDate"),
    app.indexOf("function resolutionCell"),
  );
  assert.ok(accessor.length > 0, "a dedicated Polymarket-date accessor must exist");
  assert.doesNotMatch(accessor, /closedTime/, "the resolution date must never come from our close time");
  assert.doesNotMatch(accessor, /resolvedAt/, "nor from when we booked the result");
  assert.match(accessor, /trade\?\.endDate/, "it reads Polymarket's end date");

  // The cell must render that accessor, not the fallback-bearing one.
  const cell = app.slice(app.indexOf("function resolutionCell"), app.indexOf("function holdingCell"));
  assert.match(cell, /escapeHtml\(resolutionDate \? formatDate\(resolutionDate\) : "-"\)/);
  // The horizon maths keeps its own fallback, so days-left behaviour is untouched.
  assert.match(cell, /const endDate = tradeEndDate\(trade\);/);
});

test("scraping: a market that already reads 100% is not stored", () => {
  // Reported gap: resolved rows often showed 100% market probability. A quote of
  // 0.9996 displays as 100.0% but passed the bare `>= 1` test, so it was scraped with
  // no upside left. Anything that rounds to 100.0% now counts as settled.
  const market = (yesPrice) => ({
    conditionId: "0xfixture",
    question: "Fixture market",
    slug: "fixture-market",
    active: true,
    closed: false,
    acceptingOrders: true,
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify([String(yesPrice), String(1 - yesPrice)]),
    clobTokenIds: JSON.stringify(["1000000000000000001", "1000000000000000002"]),
    endDate: new Date(Date.now() + 2 * 86400000).toISOString(),
  });

  assert.equal(bot.marketScanRetentionReason(market(0.9996)), "settled_outcome_probability",
    "a quote that displays as 100.0% must not be stored");
  assert.equal(bot.marketScanRetentionReason(market(1)), "settled_outcome_probability");
  assert.equal(bot.marketScanRetentionReason(market(0.0004)), "settled_outcome_probability",
    "the settled side is symmetric");

  // A genuinely tradable quote is still retained.
  assert.equal(bot.marketScanRetentionReason(market(0.95)), null);
  assert.equal(bot.marketScanRetentionReason(market(0.99)), null);

  // The threshold is exactly the rounding boundary, shared with the executor.
  assert.equal(bot.EFFECTIVELY_CERTAIN_MARKET_PROBABILITY, 0.9995);
});

test("state segments: the core file never carries the heavy collections", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // The fixture has to actually exercise every segment, or this proves nothing.
  assert.ok(state.marketObservations.length > 0, "fixture must have market observations");
  assert.ok(state.evaluations.length > 0, "fixture must have evaluations");
  assert.ok(state.marketScanHistory.length > 0, "fixture must have scan history");
  const isResolved = (item) => String(item?.status || item?.selectionStatus || "").toUpperCase() === "RESOLVED";
  const resolvedRows = state.marketObservations.filter(isResolved);
  const activeRows = state.marketObservations.filter((item) => !isResolved(item));
  assert.ok(resolvedRows.length > 0, "fixture must have resolved observations");
  assert.ok(activeRows.length > 0, "fixture must have active observations");

  const { core, segments } = bot.splitStateIntoSegments(state);
  assert.deepEqual(Object.keys(segments).sort(), ["evaluations", "observations", "resolvedObservations", "scanHistory"]);

  // The whole point is that a reader of the core file decodes none of the catalogue.
  assert.deepEqual(core.marketObservations, []);
  assert.deepEqual(core.evaluations, []);
  assert.deepEqual(core.marketScanHistory, []);
  assert.deepEqual(core.marketScan, {});
  // Portfolio numbers stay in the core: they are what the dashboard renders.
  assert.equal(core.paperPortfolios.conservative.portfolio.equityUsdc, state.paperPortfolios.conservative.portfolio.equityUsdc);
  assert.ok(Array.isArray(core.trades), "trades stay in the core so the shape check still passes");

  // Resolved history is archived apart from the active catalogue. That separation is
  // what lets it accumulate instead of competing for one retention budget, and it
  // keeps the execution view from ever decoding it.
  assert.deepEqual(segments.observations.marketObservations, activeRows,
    "the observations segment carries only tradable rows");
  assert.deepEqual(segments.resolvedObservations.resolvedMarketObservations, resolvedRows,
    "resolved rows are archived in their own segment");

  // The manifest is the signal that empty collections mean "segmented", not "no data".
  assert.equal(core.stateSegments.observations.file, "paper-state.observations.json");
  assert.equal(core.stateSegments.evaluations.file, "paper-state.evaluations.json");
  assert.equal(core.stateSegments.scanHistory.file, "paper-state.scanHistory.json");
  assert.equal(core.stateSegments.resolvedObservations.file, "paper-state.resolvedObservations.json");
  assert.equal(core.stateSegments.observations.counts.marketObservations, activeRows.length);
  assert.equal(core.stateSegments.resolvedObservations.counts.resolvedMarketObservations, resolvedRows.length);
  assert.equal(core.stateSegments.evaluations.counts.evaluations, state.evaluations.length);
  assert.equal(core.stateSegments.scanHistory.counts.marketScanHistory, state.marketScanHistory.length);

  // Splitting must be lossless, or publishing it destroys retained history.
  let rebuilt = { ...core };
  for (const payload of Object.values(segments)) rebuilt = bot.mergeStateSegment(rebuilt, payload);
  delete rebuilt.stateSegments;
  // The combined list is active-then-resolved; order within each group is preserved.
  assert.deepEqual(rebuilt.marketObservations, [...activeRows, ...resolvedRows]);
  assert.deepEqual(
    { ...rebuilt, marketObservations: state.marketObservations },
    state,
    "everything other than observation ordering must round-trip exactly",
  );
  assert.equal(rebuilt.marketObservations.length, state.marketObservations.length, "no row may be lost");
});

test("state segments: resolved history is retained far beyond the old cap", () => {
  // The reported symptom was the counts in the scraped tabs going down instead of up.
  // Resolved rows shared the active catalogue's budget and were capped at 1000, so
  // the archive churned. They now have their own file and a much larger budget.
  const resolvedLimit = bot.MARKET_OBSERVATION_RESOLVED_RETAIN_LIMIT;
  assert.ok(resolvedLimit >= 3000, `resolved retention must accumulate, got ${resolvedLimit}`);
  // Bounded by what one scraped response can carry, not by storage: measured on a
  // 5000-row active catalogue that summary peaks at ~66 MB with 3000 resolved rows and
  // ~111 MB with 8000, and a 128 MB host answers 500 before that. Raising this further
  // requires serving the archive in pages first.
  assert.ok(resolvedLimit <= 5000, `serving ${resolvedLimit} resolved rows at once would risk a 500`);

  // And retention must keep the newest resolved rows rather than an arbitrary slice.
  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `resolved-${index}`,
    tokenId: String(900000000000 + index),
    status: "RESOLVED",
    updatedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  }));
  const state = bot.normalizeState({ marketObservations: rows });
  assert.equal(state.marketObservations.length, 12, "nothing near the cap may be dropped");
});

test("state segments: writeState publishes siblings that readState reassembles", async () => {
  const { mkdtemp, readFile, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "paper-state-segments-"));

  // A fresh module instance is needed because OUTPUT_PATH is read at import time.
  const previous = process.env.PAPER_STATE_PATH;
  process.env.PAPER_STATE_PATH = join(dir, "paper-state.json");
  process.env.PAPER_STATE_URL = "";
  try {
    const scoped = await import(`../tools/paper-trading-bot.mjs?segments=${Date.now()}`);
    const source = scoped.normalizeState(
      JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
    );
    await scoped.writeState(source);

    const published = (await readdir(dir)).sort();
    assert.deepEqual(published, [
      "paper-state.evaluations.json",
      "paper-state.json",
      "paper-state.observations.json",
      "paper-state.resolvedObservations.json",
      "paper-state.scanHistory.json",
    ]);

    // The published core must be small: that is the property that stops PHP 500s.
    const coreRaw = await readFile(join(dir, "paper-state.json"), "utf8");
    const catalogueRaw = await readFile(join(dir, "paper-state.observations.json"), "utf8");
    assert.ok(!coreRaw.includes(source.marketObservations[0].tokenId),
      "no observation may leak into the core file");
    assert.ok(catalogueRaw.includes(source.marketObservations[0].tokenId),
      "the observation segment must carry them instead");

    // And reading it back has to restore everything the bot needs to keep merging.
    const restored = await scoped.readState();
    assert.equal(restored.marketObservations.length, source.marketObservations.length);
    assert.equal(restored.evaluations.length, source.evaluations.length);
    assert.equal(restored.marketScanHistory.length, source.marketScanHistory.length);
    assert.deepEqual(restored.marketScan, source.marketScan);
  } finally {
    if (previous === undefined) delete process.env.PAPER_STATE_PATH;
    else process.env.PAPER_STATE_PATH = previous;
  }
});

test("state segments: api.php loads only the segments a summary reads", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // The segment field map has to match the bot's, or a published field is never served.
  assert.match(api, /'observations' => \['marketObservations', 'marketScan'\]/);
  assert.match(api, /'evaluations' => \['evaluations'\]/);
  assert.match(api, /'scanHistory' => \['marketScanHistory'\]/);

  // Every state read must declare its segments; an undeclared one decodes the lot.
  // Comments and the compact_state_payload() helper are not call sites.
  const reads = (api.match(/(?<![\w])state_payload\([^;\n]*/g) || [])
    .filter((call) => !/^state_payload\((?:\)|string)/.test(call));
  assert.ok(reads.length >= 3, `expected at least three state reads, found ${reads.length}: ${reads.join(" | ")}`);
  for (const call of reads) {
    assert.match(call, /,\s*(\[|state_segments_for_summary)/, `${call} must declare which segments it needs`);
  }

  // The two reads that made PHP decode everything must now decode nothing heavy.
  assert.match(api, /case 'dashboard':\s*\n\s*return \[\];/);
  assert.match(api, /case 'refresh':(?:\s*\n\s*\/\/[^\n]*)+\s*\n\s*return \[\];/);
  // The audit endpoints only ever needed the scan history.
  assert.equal((api.match(/state_payload\('paper', \['scanHistory'\]\)/g) || []).length, 2);

  // A state published before segmentation has no manifest and must still serve whole.
  assert.match(api, /if \(\$manifest === \[\]\) \{\s*\n\s*\/\/[^\n]*\n\s*return \$data;/);
  // A segment file name arrives as file content, so it stays a plain sibling name.
  assert.match(api, /preg_match\('\/\^\[A-Za-z0-9\._-\]\+\\\.json\$\/', \$file\)/);
});

test("state segments: every state-writing workflow publishes them", async () => {
  const { readFile } = await import("node:fs/promises");
  // Three workflows write paper state. One that uploads only the core would leave
  // the hosting advertising the previous run's catalogue, so they all publish
  // through the shared script.
  const writers = ["trading-paper-bot", "trading-market-scan", "trading-paper-evaluation"];
  const suffixes = new Set();
  for (const name of writers) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /run: python3 trading\/tools\/publish-paper-state\.py/,
      `${name} must publish through the shared script`);
    assert.ok(!/STOR paper-state\.json/.test(workflow),
      `${name} must not upload the core state inline`);
    const suffix = workflow.match(/PAPER_UPLOAD_SUFFIX: (\S+)/)?.[1];
    assert.ok(suffix, `${name} must set its own upload suffix`);
    // A shared temp name would let two concurrent runs overwrite each other's upload.
    assert.ok(!suffixes.has(suffix), `${name} reuses upload suffix ${suffix}`);
    suffixes.add(suffix);
  }

  // The publisher must send the core last, or the manifest points at files that
  // are not there yet.
  const publisher = await readFile(new URL("../tools/publish-paper-state.py", import.meta.url), "utf8");
  assert.match(publisher, /uploads = declared_segments\(state_file\) \+ \[state_file\]/);
  // And a manifest naming a file that was never written has to fail the run.
  assert.match(publisher, /was not generated/);
});

test("state segments: the publisher refuses to write outside the trading tree", async () => {
  const { readFile } = await import("node:fs/promises");
  const publisher = await readFile(new URL("../tools/publish-paper-state.py", import.meta.url), "utf8");
  // The remote directory arrives from the environment and this script writes over
  // FTP, so it must not be able to reach anything but /www/trading/.
  assert.match(publisher, /if not remote_dir\.startswith\("www\/trading\/"\) or "\.\." in remote_dir:/);
  assert.match(publisher, /Refusing to publish outside \/www\/trading\//);
  // Nothing read from the environment may be echoed into the log.
  for (const secret of ["HOSTING_FTP_PASSWORD", "HOSTING_FTP_USERNAME"]) {
    assert.ok(!new RegExp(`print\\([^)]*${secret}`).test(publisher), `${secret} must never be printed`);
  }
});

// Pulls a named top-level function out of the browser bundle so its behaviour can
// be exercised directly instead of only pattern-matched. Brace counting starts
// after the parameter list so default values containing braces cannot end it early.
function extractAppFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} was not found in app.js`);
  let index = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = index; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced in app.js`);
}

async function loadExecutionSummary() {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const names = [
    "money", "probability", "percent", "signedPercent", "compactDays",
    "executionCandidateEconomics", "executionPositionEconomics", "liveExecutionSummary",
  ];
  const source = names.map((name) => extractAppFunction(app, name)).join("\n");
  return new Function(`${source}\nreturn { liveExecutionSummary, executionCandidateEconomics, executionPositionEconomics };`)();
}

test("execution popup: the result names the candidate and the numbers behind it", async () => {
  const { liveExecutionSummary } = await loadExecutionSummary();
  const summary = liveExecutionSummary({
    action: "SUBMIT",
    reason: "candidate passed revalidation",
    selected: {
      question: "Will Team A win?",
      outcome: "Yes",
      potentialAnnualizedReturn: 4.0559,
      netYield: 0.0333,
      daysToResolution: 0.3,
      netGainIfWinUsdc: 0.1665,
      orderNotionalUsdc: 5,
      marketProbability: 0.967,
      orderType: "GTC",
      orderSize: 5.17,
      orderPrice: 0.967,
    },
    response: { orderID: "0xabc", status: "matched" },
  });

  // The point of the change: the popup must state which candidate and on what basis.
  assert.match(summary, /Selected: Will Team A win\? \/ Yes/);
  assert.match(summary, /potential p\.a\. 405\.6%/);
  assert.match(summary, /net yield 3\.3%/);
  assert.match(summary, /0\.3 d left/);
  assert.match(summary, /win \$0\.17/);
  assert.match(summary, /stake \$5\.00/);
  assert.match(summary, /mkt 96\.7%/);
  assert.match(summary, /Order ID: 0xabc/);
});

test("execution popup: a rotation names the position it gives up and its P/L", async () => {
  const { liveExecutionSummary } = await loadExecutionSummary();
  const summary = liveExecutionSummary({
    action: "ROTATION_EXIT_SUBMITTED",
    reason: "a weaker live position is being replaced",
    selected: { question: "Will Team B win?", outcome: "No", potentialAnnualizedReturn: 9.5, daysToResolution: 0.2 },
    batchLog: {
      humanReason: "Replace X (120.0% p.a., 3.0 d) with Y (950.0% p.a., 0.2 d); expected P/L changes by 0.4000 USDC.",
      rotationExit: {
        position: {
          question: "Will Team X win?",
          outcome: "Yes",
          holdAnnualizedReturn: 1.2,
          currentSellPnlUsdc: 0.21,
          unrealizedPnlUsdc: 0.25,
          remainingPotentialGainUsdc: 0.09,
          potentialWinIfHeldUsdc: 0.3,
        },
      },
    },
  });

  // Which position is being given up, and what it costs to give it up.
  assert.match(summary, /Replacing: Will Team X win\? \/ Yes/);
  assert.match(summary, /potential p\.a\. 120\.0%/);
  assert.match(summary, /P\/L on close \$0\.21/);
  assert.match(summary, /open P\/L \$0\.25/);
  assert.match(summary, /\$0\.09 still to collect/);
  // The runner's own sentence is surfaced rather than re-derived in the browser.
  assert.match(summary, /Decision: Replace X .* expected P\/L changes by 0\.4000 USDC\./);
});

test("execution popup: with no candidate it explains what was considered", async () => {
  const { liveExecutionSummary } = await loadExecutionSummary();
  const summary = liveExecutionSummary({
    action: "SKIP",
    reason: "no candidate passed revalidation",
    batchLog: {
      counts: {
        scannedCandidates: 42,
        revalidatedCandidates: 40,
        eligibleCandidates: 0,
        positionsReviewedForRotation: 3,
      },
    },
  });
  assert.match(summary, /Considered: 42 scanned \/ 40 revalidated \/ 0 eligible \/ 3 positions reviewed for rotation/);
  assert.ok(!summary.includes("Selected:"), "there is no selected candidate to name");
});

test("execution run-once: a missing result state is waited out, not reported as failure", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const waiter = extractAppFunction(app, "waitForExecutionResult");

  // The reported bug: the first poll can land before the runner has published its
  // state, and an unguarded read turned that into "Execution failed / State file is
  // not available yet". Each attempt must absorb its own error and keep polling.
  assert.match(waiter, /try \{\s*\n\s*payload = await fetchApiJson/);
  assert.match(waiter, /catch \(error\) \{\s*\n\s*lastError = error;\s*\n\s*await sleep\(3000\);\s*\n\s*continue;/);
  // And the loop must never rethrow, or the outer catch reports a failed execution.
  assert.ok(!/throw /.test(waiter), "waitForExecutionResult must not throw");
  // The final message must not claim the execution failed.
  assert.match(waiter, /The workflow conclusion above is authoritative/);

  // The status poll has the same hazard and the same fix.
  const runWaiter = extractAppFunction(app, "waitForWorkflowRun");
  assert.match(runWaiter, /catch \(error\) \{/);
  assert.ok(!/throw /.test(runWaiter), "waitForWorkflowRun must not throw");
  // Polling every 4s must update one line instead of appending an identical entry.
  assert.match(runWaiter, /upsertExecutionStep\(steps, "Workflow status"/);
  assert.ok(!/addExecutionStep\(steps, attempt === 0/.test(runWaiter), "the per-poll append is what spammed the popup");
});

test("state segments: a missing segment does not read as a missing state", async () => {
  // The production failure. A scan published core + segments; the site deploy then
  // deleted every data file it did not recognise, including the segments; the next
  // run fetched a manifest pointing at 404s, classified that as "published state is
  // missing (HTTP 404)", fell through to the repository snapshot and aborted with
  // "obsolete schema". Portfolios and trades live in the core file and were never
  // lost, so the run must continue with them.
  const http = await import("node:http");
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const source = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  const { core } = bot.splitStateIntoSegments(source);

  let segmentStatus = 404;
  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] === "/paper-state.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(core));
      return;
    }
    res.writeHead(segmentStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "unavailable" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const previous = {
    path: process.env.PAPER_STATE_PATH,
    url: process.env.PAPER_STATE_URL,
    staticUrl: process.env.PAPER_STATIC_STATE_URL,
  };
  try {
    process.env.PAPER_STATE_PATH = join(await mkdtemp(join(tmpdir(), "paper-missing-segment-")), "paper-state.json");
    process.env.PAPER_STATE_URL = `${base}/paper-state.json`;
    process.env.PAPER_STATIC_STATE_URL = `${base}/paper-state.json`;
    const scoped = await import(`../tools/paper-trading-bot.mjs?missingSegment=${Date.now()}`);

    const restored = await scoped.readState();
    assert.equal(restored.trades.length, source.trades.length, "trades live in the core and must survive");
    assert.equal(
      restored.paperPortfolios.conservative.portfolio.equityUsdc,
      source.paperPortfolios.conservative.portfolio.equityUsdc,
      "portfolio aggregates must survive a deleted segment",
    );
    // The catalogue is rebuilt by scanning, so an empty one is the correct outcome.
    assert.deepEqual(restored.marketObservations, []);
    assert.deepEqual(restored.evaluations, []);

    // A transient failure is the opposite case: the data is probably still there, so
    // continuing would overwrite it with empty collections.
    segmentStatus = 500;
    const failing = await import(`../tools/paper-trading-bot.mjs?failingSegment=${Date.now()}`);
    await assert.rejects(
      () => failing.readState(),
      /segment could not be read|paper state is unavailable/,
      "a 500 on a segment must fail closed instead of publishing an empty catalogue",
    );
  } finally {
    server.close();
    for (const [key, value] of [["PAPER_STATE_PATH", previous.path], ["PAPER_STATE_URL", previous.url], ["PAPER_STATIC_STATE_URL", previous.staticUrl]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("state segments: the site deploy never deletes published segments", async () => {
  const { readFile } = await import("node:fs/promises");
  const deploy = await readFile(new URL("../../.github/workflows/trading-deploy.yml", import.meta.url), "utf8");

  // The deploy wipes data/ of anything it does not recognise. Listing only the core
  // state file there is what deleted every segment and broke the next scan.
  assert.match(deploy, /def is_runtime_data\(name\):/);
  assert.match(deploy, /name\.startswith\("paper-state\."\) and name\.endswith\("\.json"\)/,
    "the rule must cover any segment the bot adds later, not a fixed list");
  assert.match(deploy, /if is_runtime_data\(child\):/);
  // The old literal set must be gone, or a stale copy could still win.
  assert.ok(!/keep = \{"paper-state\.json"/.test(deploy), "the old literal keep-set must not remain");
});

test("state segments: segments can be merged in any order", async () => {
  // Active rows and the resolved archive land in the same array from two different
  // files. An assign-based merge let whichever arrived second erase the other, which
  // silently halved the catalogue depending on read order.
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  const { core, segments } = bot.splitStateIntoSegments(state);
  const names = Object.keys(segments);
  const expected = state.marketObservations.length;

  // Every ordering of the segment files must reconstruct the same row count.
  const permute = (list) => (list.length <= 1 ? [list] : list.flatMap((item, index) =>
    permute([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])));
  let checked = 0;
  for (const order of permute(names)) {
    let merged = { ...core };
    for (const name of order) merged = bot.mergeStateSegment(merged, segments[name]);
    assert.equal(merged.marketObservations.length, expected, `order ${order.join(",")} lost rows`);
    checked += 1;
  }
  assert.equal(checked, 24, "all four segment orderings must be covered");
});

test("state segments: retention is not silently throttled by workflow env", async () => {
  // The resolved cap that made the counts churn was pinned in the workflow env, so
  // raising the default in the bot changed nothing in production. Any workflow that
  // overrides these must agree with what the response sizing allows.
  const { readFile } = await import("node:fs/promises");
  for (const name of ["trading-paper-bot", "trading-market-scan"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    const active = Number(workflow.match(/PAPER_MARKET_OBSERVATION_RETAIN_LIMIT: "(\d+)"/)?.[1]);
    const resolved = Number(workflow.match(/PAPER_MARKET_OBSERVATION_RESOLVED_RETAIN_LIMIT: "(\d+)"/)?.[1]);
    if (Number.isFinite(active)) {
      assert.ok(active >= 5000, `${name} throttles the active catalogue to ${active}`);
    }
    if (Number.isFinite(resolved)) {
      assert.ok(resolved >= 3000, `${name} throttles resolved history to ${resolved}, so it cannot accumulate`);
      assert.ok(resolved <= 5000, `${name} would serve ${resolved} resolved rows at once and risk a 500`);
    }
  }
});

test("category performance: the report carries the decision-relevant columns", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // Tags arrive from four places and in two shapes; the report used to read one.
  state.marketObservations = state.marketObservations.map((row, index) => ({
    ...row,
    firstDaysToResolution: 4,
    daysToResolution: 4,
    firstLiquidity: 52000,
    polymarketTags: index % 2 ? [{ slug: "nba" }, { label: "Sports" }] : ["crypto"],
    riskGroupLabels: ["entity:acme"],
  }));

  const rows = bot.buildCalculationReport(state).categorySummaries;
  const labels = rows.map((row) => row.label);
  for (const expected of ["nba", "sports", "crypto", "entity:acme"]) {
    assert.ok(labels.includes(expected), `${expected} must appear as a tag row`);
  }
  assert.ok(rows.some((row) => row.kind === "category"), "categories are still grouped");

  const resolvedGroup = rows.find((row) => row.resolved > 0);
  assert.ok(resolvedGroup, "the fixture must resolve at least one trade");
  for (const field of ["pnlPerTradeUsdc", "annualizedRoi", "avgNetYield", "avgDaysToResolution", "lastResolvedAt"]) {
    assert.ok(resolvedGroup[field] != null, `${field} must be reported`);
  }
  // ROI p.a. must be ROI over the group's own horizon, not over a default.
  assert.ok(
    Math.abs(resolvedGroup.annualizedRoi - resolvedGroup.roi * (365 / resolvedGroup.avgDaysToResolution)) < 0.01,
    "ROI p.a. must annualize over the measured horizon",
  );
});

test("category performance: an unknown horizon reports no p.a. at all", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // annualizationDays(null) coerces to 0 and is floored to one hour, which turned a
  // group with no measured horizon into a confident four-figure p.a.
  state.marketObservations = state.marketObservations.map((row) => {
    const stripped = { ...row };
    delete stripped.daysToResolution;
    delete stripped.firstDaysToResolution;
    delete stripped.endDate;
    delete stripped.resolutionEndDate;
    delete stripped.scheduledEventDate;
    return stripped;
  });

  const rows = bot.buildCalculationReport(state).categorySummaries;
  for (const row of rows) {
    if (row.avgDaysToResolution == null) {
      assert.equal(row.annualizedRoi, null,
        `${row.label} has no horizon, so it must not report ${row.annualizedRoi} p.a.`);
    }
  }
});

test("category performance: the table sorts independently and is bounded", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Both tables share one container, so each needs its own sort state and attribute;
  // one shared state made clicking either scramble the other.
  assert.match(app, /categorySort: \{/);
  assert.match(app, /data-category-sort="\$\{key\}"/);
  assert.match(app, /const categoryButton = event\.target\.closest\("\[data-category-sort\]"\);/);
  assert.match(app, /const button = event\.target\.closest\("\[data-calculation-sort\]"\);/);
  // Every column must be sortable, which is what was asked for.
  const sorted = [...app.matchAll(/categoryHeader\("([a-zA-Z]+)"/g)].map((match) => match[1]);
  for (const key of ["kind", "label", "trades", "resolved", "accuracy", "pnl", "pnlPerTradeUsdc",
    "roi", "annualizedRoi", "avgNetYield", "avgDaysToResolution", "avgProbability", "avgLiquidity", "lastResolvedAt"]) {
    assert.ok(sorted.includes(key), `${key} column must be sortable`);
  }
  // The header count must match the colspan on the empty row, or the layout breaks.
  assert.match(app, /colspan="14"/);
  assert.equal(sorted.length, 14);
  // The filter must use the segmented control this panel already uses.
  assert.match(app, /class="segment-button\$\{state\.categoryKind === value \? " active" : ""\}"/);

  // The report is stored in the core state file, so its row count must be bounded.
  const botSource = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(botSource, /SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT/);
  assert.match(botSource, /return rows\.slice\(0, SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT\);/);
  assert.match(botSource, /if \(tags\.length >= SCRAPED_SIMULATION_TAGS_PER_TRADE\) return tags;/);
});

test("live events: the scan asks Gamma only for what was measured to work", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Every parameter here was verified against the live API by tools/gamma-live-probe.mjs
  // rather than assumed. live=true is a real server-side filter (the same sports query
  // returned 100 events with 1 live, and 2 events both live with the filter), and
  // end_date_min is honoured. start_date_max is silently ignored and must not be used.
  assert.match(source, /live: "true"/, "the live scope must use the server-side filter");
  // Check code, not the comment that explains why the parameter is avoided.
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/start_date_max/.test(code), "start_date_max is ignored by Gamma and must not be sent");

  // The lower bound is the fix for pages that started on months-old closed events.
  const params = bot.scanEventRequestParams({ tag_id: "1", order: "endDate", ascending: "true" });
  assert.ok(params.end_date_min, "every scan request needs a lower end-date bound");
  const graceHours = (Date.now() - Date.parse(params.end_date_min)) / 3600000;
  assert.ok(graceHours > 0, "the bound must sit in the past so just-ended tradable markets survive");
  assert.ok(graceHours <= 24, `the grace window is too wide at ${graceHours}h`);
  // A caller with its own window must keep it.
  const windowed = bot.scanEventRequestParams({ tag_id: "1", end_date_max: "2026-08-05T20:00:00.000Z" });
  assert.equal(windowed.end_date_max, "2026-08-05T20:00:00.000Z");

  // Exactly the two tags behind polymarket.com/sports/live and /esports/live.
  assert.deepEqual(bot.marketScanLiveTags().map((tag) => tag.slug), ["sports", "esports"]);
  assert.deepEqual(bot.marketScanLiveTags().map((tag) => tag.id), ["1", "64"]);

  // A live-scan failure must never take the catalogue scan down with it: the rotating
  // scope is the job that has to keep working.
  assert.match(source, /Live event scan failed \(\$\{liveScanError\}\); continuing with the rotating scope only\./);
  assert.match(source, /const fetchedMarkets = \[\.\.\.liveMarkets, \.\.\.diversifyMarketScanOrder\(batch\)\];/,
    "live rows go first so bounded downstream steps keep them");

  // normalizeMarketScan is a whitelist; unlisted fields never reach the published state.
  for (const field of ["liveScanEnabled", "liveScanWindowHours", "liveScanCount", "liveScanCounts", "liveScanError", "endDateGraceHours"]) {
    assert.ok(
      new RegExp(`${field}: `).test(source.slice(source.indexOf("function normalizeMarketScan"), source.indexOf("function normalizeMarketScanHistory"))),
      `${field} must be whitelisted in normalizeMarketScan or it is silently dropped`,
    );
  }
  const scan = bot.normalizeState({ marketScan: { liveScanCount: 7, liveScanCounts: { sports: 5, esports: 2 } } }).marketScan;
  assert.equal(scan.liveScanCount, 7);
  assert.deepEqual(scan.liveScanCounts, { sports: 5, esports: 2 });
});

test("live events: the probe that justified this stays read-only", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/trading-gamma-live-probe.yml", import.meta.url), "utf8");
  const body = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  // It reaches a third-party API from a runner, so it must stay unable to touch anything.
  for (const forbidden of ["secrets.", "ftplib", "storbinary", "HOSTING_", "upload-artifact"]) {
    assert.ok(!body.includes(forbidden), `the probe must not use ${forbidden}`);
  }
  assert.match(body, /permissions:\n\s+contents: read/);
  assert.match(body, /on:\n\s+workflow_dispatch:/);
});
