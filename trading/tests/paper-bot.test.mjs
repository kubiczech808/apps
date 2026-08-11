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
import { readFileSync } from "node:fs";

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

test("paper cadence: deployable capital brings the execution pass forward", () => {
  // Only a full pass executes a portfolio, so capital that became free right after one
  // sat idle for the rest of the 55-minute cadence even though it had somewhere to go.
  const at = (minutesAgoValue) => new Date(Date.now() - minutesAgoValue * 60000).toISOString();
  const withCapital = (free, stake) => ({
    paperPortfolios: { conservative: { portfolio: { freeCapitalUsdc: free, maxStakeUsdc: stake } } },
  });
  const stage = (free, stake, lastFullMinutes) => bot.resolveScheduledCadence({
    ...withCapital(free, stake),
    cadence: { lastFullAt: at(lastFullMinutes), lastReportAt: at(1) },
  });

  // Fundable capital forces the pass on the next scheduled tick.
  const forced = stage(5, 5, 12);
  assert.equal(forced.stage, "full");
  assert.equal(forced.broughtForwardByCapital, true);
  assert.deepEqual(forced.capitalReadyPortfolios, ["conservative"]);

  // But not immediately after a pass: otherwise a portfolio that stays funded because
  // nothing is eligible turns every tick into the expensive stage.
  const tooSoon = stage(5, 5, 4);
  assert.equal(tooSoon.stage, "scan");
  assert.ok(!tooSoon.broughtForwardByCapital);

  // Capital short of a whole stake must not force anything: executePortfolio would report
  // insufficient capital and the pass would buy nothing.
  assert.equal(stage(2, 5, 12).stage, "scan");
  assert.equal(stage(4.99, 5, 12).stage, "scan");

  // The normal cadence still fires on its own, and is not mislabelled as capital-driven.
  const normal = stage(0, 5, 60);
  assert.equal(normal.stage, "full");
  assert.ok(!normal.broughtForwardByCapital);

  // The predicate itself, including the degenerate stake.
  assert.deepEqual(bot.portfoliosWithDeployableCapital(withCapital(5, 5)), ["conservative"]);
  assert.deepEqual(bot.portfoliosWithDeployableCapital(withCapital(4.99, 5)), []);
  assert.deepEqual(bot.portfoliosWithDeployableCapital(withCapital(50, 0)), [],
    "a zero stake is not something to deploy into");
  assert.deepEqual(bot.portfoliosWithDeployableCapital({}), []);
});

test("live execution: the run evaluates the shortlist that is on screen", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: the run log listed completely different markets from the live portfolio's
  // Execution candidates. The shortlist was honoured end to end -- the run showed
  // manualShortlistMatched 16 of 16 with no fallback -- so the divergence was on the
  // browser side: freshLiveWorkflowPayload refetches the scraped state and rebuilds the
  // shortlist from it, but never re-rendered, so the table kept showing the previous
  // catalogue while the newly fetched one was submitted. Short-dated sports and esports
  // markets turn over within minutes, so the two drift apart easily.
  const fn = app.slice(app.indexOf("async function freshLiveWorkflowPayload"));
  const body = fn.slice(0, fn.indexOf("\nasync function triggerOneTimeExecution"));

  const storeAt = body.indexOf("storeScrapedMarketState(scrapedState);");
  const renderAt = body.search(/if \(state\.page === "opportunities"\) renderBotEvaluations\(\);/);
  const payloadAt = body.indexOf("liveWorkflowPayload();");
  assert.ok(storeAt >= 0 && renderAt >= 0 && payloadAt >= 0, "all three steps must be present");
  assert.ok(renderAt > storeAt, "the re-render must follow the refetch that replaced the rows");
  assert.ok(renderAt < payloadAt, "and precede building the shortlist, so screen and payload agree");
  assert.match(body, /else rerenderCurrentDashboard\(\);/);

  // Refreshing the shortlist is part of running, not a precondition the user has to
  // satisfy first -- the refetch above already did it. An empty result is not a reason
  // to refuse either: with no shortlist supplied the executor scans for candidates
  // itself, exactly as a scheduled run does.
  assert.ok(!/Refresh the shortlist before starting a live order run/.test(app),
    "a manual run must not be blocked on a shortlist it refreshes itself");

  // The shortlist is still taken from the same rows the table renders.
  assert.match(app, /const shortlistTokenIds = portfolioCandidateRows\("live"\)/);

  // And the count actually submitted is reported, so the run log can be checked against
  // it rather than taken on trust.
  assert.match(app, /"Shortlist submitted"/);
  assert.match(app, /live_execution_candidate_token_ids \|\| ""\)\s*\n\s*\.split\(","\)\.filter\(Boolean\)\.length/);
});

test("queue janitor: a stuck run cannot head-block a concurrency group forever", async () => {
  const { readFile } = await import("node:fs/promises");
  const janitor = await readFile(new URL("../../.github/workflows/trading-queue-janitor.yml", import.meta.url), "utf8");

  // Why this exists: a run that cannot get a runner holds its concurrency group, and every
  // later dispatch then sits pending with no job created -- nothing executes and nothing
  // reaches the run log. Clearing it meant cancelling runs by hand in the GitHub UI.
  assert.match(janitor, /actions: write/, "cancelling runs needs this permission");
  assert.match(janitor, /schedule:\s*\n\s*- cron: '\*\/15 \* \* \* \*'/, "it has to run unattended");

  // Both states block a group, and a pending run is the one with no job at all, so
  // checking only "queued" would miss exactly the case this was built for.
  assert.match(janitor, /for status in \("queued", "pending"\):/);

  // A run that is genuinely executing must never be touched -- only waiting ones, and
  // only past the grace period.
  assert.match(janitor, /if age >= stale_minutes:/);
  assert.match(janitor, /stale_minutes = max\(5, int\(os\.environ\.get\("STALE_MINUTES"\) or 20\)\)/,
    "the grace period must have a floor so it cannot be set to something destructive");

  // It is itself queued while it runs, so without this it would cancel itself.
  assert.match(janitor, /if str\(run\.get\("id"\)\) == self_run_id:\s*\n\s*continue/);

  // A run that started in the meantime returns 409; that is success, not an error.
  assert.match(janitor, /level = "notice" if exc\.code == 409 else "warning"/);
});

test("live sync: an open dashboard cannot dispatch a workflow every 30 seconds", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // What this prevents: LIVE_SYNC_REQUEST_MS was 30000 and the dispatch poll ran on the
  // 15s state-refresh interval, so one open tab dispatched a full Actions run every 30
  // seconds -- 88 of the repo's last 100 runs were this one workflow. That saturated the
  // account's runner capacity, and deploy / market scan / paper bot / live execution then
  // sat with runner='' until GitHub cancelled each at 15 minutes. The visible symptoms
  // were "Scan is still queued in the background", a frontend fix that never reached the
  // hosting, and manual execution stuck pending.
  const requestMs = Number(/const LIVE_SYNC_REQUEST_MS = (\d+);/.exec(app)?.[1]);
  assert.ok(Number.isFinite(requestMs), "the background sync cadence must be declared");
  assert.ok(requestMs >= 300000, `background dispatch must be minutes apart, got ${requestMs}ms`);

  // The poll must be paced by its own cadence, not by the fast state-refresh interval, so
  // the client asks no more often than the server would allow anyway.
  assert.match(app, /requestLiveAccountSync\(\{ quiet: true, minSeconds: LIVE_SYNC_REQUEST_MS \/ 1000 \}\);\s*\n\}, LIVE_SYNC_REQUEST_MS\);/);

  // Re-reading the published state stays fast: that is a static JSON fetch, not a run.
  const refreshMs = Number(/const LIVE_STATE_REFRESH_MS = (\d+);/.exec(app)?.[1]);
  assert.ok(refreshMs <= 60000, "reading the state should stay responsive");

  // The server floor is the only guard that survives a cached frontend, so it must be
  // enforced there too and not left at 30s.
  const floor = Number(/\$minSeconds = max\((\d+), min\(900,/.exec(api)?.[1]);
  assert.ok(Number.isFinite(floor), "the server-side throttle floor must exist");
  assert.ok(floor >= 120, `server floor must bound a stale client, got ${floor}s`);
  const fallback = Number(/min\(900, \(int\) \(\$_GET\['minSeconds'\] \?\? (\d+)\)\)/.exec(api)?.[1]);
  assert.ok(fallback >= 300, `the default must not be aggressive either, got ${fallback}s`);

  // A deliberate click may still dispatch sooner than the background cadence.
  const manual = Number(/const LIVE_SYNC_MANUAL_SECONDS = (\d+);/.exec(app)?.[1]);
  assert.ok(Number.isFinite(manual), "the manual refresh throttle must be declared");
  assert.ok(manual >= floor && manual < requestMs / 1000,
    `a manual refresh must beat the background poll but respect the server floor, got ${manual}s`);
});

test("stake sizing: the summary row, the control and the executor share one base", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");

  // Reported inconsistency: the Live portfolio row said "12.4% of live equity ($2.48)"
  // while MAX PER TRADE right below it said "Calculated stake $3.04 / base $24.50". Both
  // numbers were real -- the row used full equity, the control used equity minus
  // unrealized P/L -- and with -4.50 unrealized they disagreed by 56 cents. The executor
  // sizes from equity minus unrealized P/L, so the row was the wrong one.
  assert.match(executor, /if \(equity != null && equity > 0\) return Math\.max\(0, equity - openPnl\);/,
    "the executor's base is equity minus unrealized P/L");

  // The summary row must use that same base for live, and must not silently fall back to
  // plain equity the way it used to.
  const rule = app.slice(app.indexOf("function stakeSizingRuleValue"));
  const body = rule.slice(0, rule.indexOf("\nfunction "));
  assert.match(body, /const sizingBase = isLive && Number\.isFinite\(equity\)\s*\n\s*\? Math\.max\(0, equity - \(Number\.isFinite\(openPnl\) \? openPnl : 0\)\)\s*\n\s*: equity;/);
  assert.match(body, /const nominalStake = Number\.isFinite\(sizingBase\)/,
    "the displayed stake must come from the sizing base, not from equity");
  assert.ok(!/const nominalStake = Number\.isFinite\(equity\) \? Math\.max\(0, equity\) \* allocation/.test(body),
    "the old full-equity computation must be gone");
  // Equity and open P/L have to be read off one snapshot, or the two could be mixed.
  assert.match(body, /const source = portfolio\?\.equityUsdc != null \? portfolio : fallbackPortfolio;/);
  // The label has to say which base it is, so the two places cannot read as contradictory.
  assert.match(body, /isLive \? "live equity excl\. unrealized P\/L" : "portfolio equity"/);

  // Paper legitimately sizes from full equity, so the fix must not change that.
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(bot, /maxStakeUsdc: Number\(\(equity \* portfolioMaxFraction\)\.toFixed\(2\)\)/);

  // The arithmetic that was reported, pinned: 12.4% on the live account's own numbers.
  const equity = 20.00;
  const openPnl = -4.50;
  const allocation = 0.124;
  const base = Math.max(0, equity - openPnl);
  assert.equal(Number((base * allocation).toFixed(2)), 3.04, "both places must show 3.04");
  assert.notEqual(Number((equity * allocation).toFixed(2)), 3.04, "full equity is what produced the wrong 2.48");
});

test("market scan: sports and esports get a guaranteed slot every hour", async () => {
  const scopes = await bot.marketScanScopes();
  const indexOf = (slug) => scopes.findIndex((scope) => scope.tag?.slug === slug);
  assert.deepEqual(bot.MARKET_SCAN_HOURLY_TAG_SLUGS, ["sports", "esports"]);
  // The rotation is long enough that these tags' full pass came round only every few
  // hours, which is what the guaranteed slot exists to fix.
  assert.ok(scopes.length > 20, `expected the full rotation, got ${scopes.length}`);

  const now = Date.parse("2026-08-06T18:00:00Z");
  const iso = (minutesAgoValue) => new Date(now - minutesAgoValue * 60000).toISOString();

  // Never scanned counts as overdue, so a fresh state picks these up immediately.
  assert.equal(bot.overdueHourlyScanScope(scopes, {}, now), indexOf("sports"));

  // Both overdue: the older one wins, so they cannot starve each other.
  const bothOverdue = { tagScannedAt: { "tag:sports": iso(70), "tag:esports": iso(200) } };
  assert.equal(bot.overdueHourlyScanScope(scopes, bothOverdue, now), indexOf("esports"));

  // Only one overdue.
  const onlySports = { tagScannedAt: { "tag:sports": iso(90), "tag:esports": iso(5) } };
  assert.equal(bot.overdueHourlyScanScope(scopes, onlySports, now), indexOf("sports"));

  // Both fresh: the normal rotation must be left alone, or every other tag starves.
  const bothFresh = { tagScannedAt: { "tag:sports": iso(10), "tag:esports": iso(20) } };
  assert.equal(bot.overdueHourlyScanScope(scopes, bothFresh, now), null);

  // Exactly at the boundary counts as due, so drift cannot push a pass past the hour.
  const atBoundary = { tagScannedAt: { "tag:sports": iso(60), "tag:esports": iso(1) } };
  assert.equal(bot.overdueHourlyScanScope(scopes, atBoundary, now), indexOf("sports"));
});

test("market scan: the borrowed slot delays the rotation without skipping a scope", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Borrowing a run for sports/esports must not advance the rotation cursor, otherwise
  // every borrowed slot would silently skip whichever scope was next in line.
  assert.match(source, /scanScopeCursor: usedHourlySlot \? rotationIndex : \(scopeIndex \+ 1\) % scopes\.length/);
  // And the per-scope timestamp has to be persisted, or the slot reads an empty map every
  // run, believes both tags are permanently overdue, and the rotation never moves at all.
  assert.match(source, /tagScannedAt: \{ \.\.\.\(previousScan\.tagScannedAt \|\| \{\}\), \[scope\.key\]: scanRunAt \}/);
  const normalize = source.slice(source.indexOf("function normalizeMarketScan"));
  assert.match(normalize.slice(0, normalize.indexOf("\nfunction ")), /tagScannedAt: Object\.fromEntries\(/,
    "normalizeMarketScan must carry tagScannedAt through");
});

test("trade table: every header lines up with the cell beneath it", async () => {
  // Headers and cells are two separate lists in one template, so reordering columns can
  // silently shift values under the wrong heading -- a P/L read as a stake is worse than
  // a missing column. This pins them together whatever order they are in.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const fn = app.slice(app.indexOf("function renderTradeRows"));
  const body = fn.slice(0, fn.indexOf("\nfunction ", 1));
  const thead = body.slice(body.indexOf("<thead>"), body.indexOf("</thead>"));
  const tbody = body.slice(body.indexOf("<tbody>"), body.indexOf("</tbody>"));

  const conditional = (text) => {
    const match = /\?\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(text);
    return match ? `${match[1]}|${match[2]}` : text.replaceAll('"', "").trim();
  };
  const headers = [...thead.matchAll(/tradeHeader\(tableKey,\s*(?:showStatus \? "\w+" : "\w+"|"\w+"),\s*(showStatus \? "[^"]+" : "[^"]+"|"[^"]+")\)/g)]
    .map((match) => conditional(match[1]));
  const cells = [...tbody.matchAll(/<td data-label="(\$\{showStatus \? "[^"]+" : "[^"]+"\}|[^"]+)"/g)]
    .map((match) => conditional(match[1]));

  assert.ok(headers.length >= 10, `expected the full column set, found ${headers.length}`);
  assert.deepEqual(cells, headers, "each column's cell must sit under its own header");

  // The Result column only exists in one of the two views and must stay conditional, or
  // the open table gains an empty column and the closed one loses a value.
  assert.ok(thead.includes('showStatus ? tradeHeader(tableKey, "status", "Result")'));
  assert.ok(tbody.includes('showStatus ? `<td data-label="Result"'));

  // The AI probability column used to be the other conditional one, suppressed on the
  // open tables and left on the closed ones. The scoring pipeline it came from is
  // retired -- every portfolio scores on the Polymarket probability -- so the column
  // could only ever show a figure from a system no longer running, on rows old enough
  // to have one. A stale number reads as a current one, so it is gone rather than
  // hidden in one more place.
  assert.ok(!/AI prob\./.test(body), "no AI probability column in the trade tables");
  assert.ok(!/showAiProbability/.test(app), "and no leftover switch for it");
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
  // resolvedRecent joined these: the archive is kept whole and the newest page of it is
  // published beside it, so the opportunities page never decodes all of history to show
  // its most recent rows.
  assert.deepEqual(Object.keys(segments).sort(),
    ["evaluations", "observations", "resolvedObservations", "resolvedRecent", "scanHistory"]);

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

test("state segments: resolved history is never discarded", () => {
  // Reported: the counts in the scraped and resolved tabs did not match what had
  // actually been mined, and stopped growing. Resolved rows were trimmed to a limit
  // on every write, so once the archive filled it churned -- older settled markets
  // were deleted to make room for newer ones, and no count could exceed the cap.
  //
  // A resolved market is the record of what was scraped and how it ended, which is
  // what every report and parameter comparison is measured against. Once dropped it
  // is gone: unlike an active row, it will never be re-scraped.
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.ok(!/MARKET_OBSERVATION_RESOLVED_RETAIN_LIMIT/.test(source),
    "no cap may stand between a resolved market and the archive");
  assert.match(source, /\.\.\.resolved\.sort\(\(a, b\) => marketObservationUpdateTime\(b\) - marketObservationUpdateTime\(a\)\),/,
    "resolved rows are sorted and kept, not sliced");

  // Active rows stay bounded: they are a working set, and one that falls out is
  // simply re-scraped.
  assert.match(source, /\.\.\.active\.sort\(compareActive\)\.slice\(0, MARKET_OBSERVATION_RETAIN_LIMIT\),/);

  const rows = Array.from({ length: 12 }, (_, index) => ({
    id: `resolved-${index}`,
    tokenId: String(900000000000 + index),
    status: "RESOLVED",
    updatedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  }));
  const state = bot.normalizeState({ marketObservations: rows });
  assert.equal(state.marketObservations.length, 12, "nothing may be dropped");
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
      // The newest page of the archive, so the opportunities page can show recent
      // resolved markets without decoding all of history to find them.
      "paper-state.resolvedRecent.json",
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
  // 0.3 days is 7.2 hours, and hours are the unit a short-dated market is read in.
  assert.match(summary, /7\.2 h left/);
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
  // Only the segments a reader reassembles. The recent page is published beside the
  // archive and carries the same transport field, and this merge replaces the resolved
  // half rather than appending -- so reading both would leave whichever landed last, and
  // the state would be rebuilt from a 3,000-row page instead of the whole archive.
  const names = bot.STATE_SEGMENT_NAMES.filter((name) => name in segments);
  assert.ok(!names.includes("resolvedRecent"), "the capped page is published, never read back");
  assert.ok(bot.PUBLISHED_STATE_SEGMENT_NAMES.includes("resolvedRecent"));
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
    // Pinning a resolved cap in the workflow is what made raising the default in the
    // bot change nothing in production. There must not be one at all now.
    assert.ok(!/PAPER_MARKET_OBSERVATION_RESOLVED_RETAIN_LIMIT/.test(workflow),
      `${name} must not cap resolved history`);
    const resolved = Number.NaN;
    if (Number.isFinite(active)) {
      assert.ok(active >= 5000, `${name} throttles the active catalogue to ${active}`);
    }
    if (Number.isFinite(resolved)) {
      assert.ok(resolved >= 3000, `${name} throttles resolved history to ${resolved}, so it cannot accumulate`);
      assert.ok(resolved <= 5000, `${name} would serve ${resolved} resolved rows at once and risk a 500`);
    }
  }
});

test("taxonomy performance: real Polymarket categories and tags stay separate", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // Gamma categories and tags are separate relations and can contain both strings and
  // objects. The old report inferred category from the first tag, producing identical
  // `category general` and `tag general` rows.
  state.marketObservations = state.marketObservations.map((row, index) => ({
    ...row,
    firstDaysToResolution: 4,
    daysToResolution: 4,
    firstLiquidity: 52000,
    polymarketCategories: index % 2 ? [{ slug: "sports" }] : [{ label: "Politics" }],
    polymarketTags: index % 2 ? [{ slug: "nba" }, { label: "Sports" }] : ["crypto"],
    firstPolymarketCategories: index % 2 ? [{ slug: "sports" }] : [{ label: "Politics" }],
    firstPolymarketTags: index % 2 ? [{ slug: "nba" }, { label: "Sports" }] : ["crypto"],
    riskGroupLabels: ["entity:acme"],
  }));

  const report = bot.buildCalculationReport(state);
  assert.equal(report.taxonomyVersion, 3);
  const categoryLabels = report.categorySummaries.map((row) => row.label);
  const tagLabels = report.tagSummaries.map((row) => row.label);
  assert.deepEqual(new Set(categoryLabels), new Set(["sports", "politics"]));
  for (const expected of ["nba", "sports", "crypto"]) {
    assert.ok(tagLabels.includes(expected), `${expected} must appear as a tag row`);
  }
  assert.ok(report.categorySummaries.every((row) => row.kind === "category"));
  assert.ok(report.tagSummaries.every((row) => row.kind === "tag"));
  // Risk labels are per-fixture dedup identifiers, not taxonomy: each groups exactly
  // one opportunity, so it can never carry a comparable sample and only crowds out the
  // real categories. They used to be fed straight into this table.
  assert.ok(!tagLabels.includes("entity:acme"), "a risk label must not become a tag row");
  assert.ok(!categoryLabels.includes("general"), "missing categories must not be invented as general");

  const resolvedGroup = [...report.categorySummaries, ...report.tagSummaries]
    .find((row) => row.resolved > 0);
  assert.ok(resolvedGroup, "the fixture must resolve at least one trade");
  for (const field of ["pnlPerTradeUsdc", "annualizedPnlPerTradeUsdc", "annualizedRoi", "avgNetYield", "avgDaysToResolution", "lastResolvedAt"]) {
    assert.ok(resolvedGroup[field] != null, `${field} must be reported`);
  }
  // ROI p.a. must be ROI over the group's own horizon, not over a default.
  assert.ok(
    Math.abs(resolvedGroup.annualizedRoi - resolvedGroup.roi * (365 / resolvedGroup.avgDaysToResolution)) < 0.01,
    "ROI p.a. must annualize over the measured horizon",
  );
  assert.ok(
    Math.abs(resolvedGroup.annualizedPnlPerTradeUsdc
      - resolvedGroup.pnlPerTradeUsdc * (365 / resolvedGroup.avgDaysToResolution)) < 0.01,
    "P/L p.a. must annualize the average realized P/L per fixed simulation trade",
  );
});

test("taxonomy performance: per-fixture slugs never become their own rows", async () => {
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  // The exact shapes seen in production: risk labels reached the table as rows like
  // "market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5". Only the real taxonomy
  // (sports, esports, politics, geopolitics, ...) belongs here.
  state.marketObservations = state.marketObservations.map((row) => ({
    ...row,
    firstDaysToResolution: 4,
    daysToResolution: 4,
    firstLiquidity: 52000,
    firstCategory: "Market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5",
    tags: ["Match: FC Bayern vs Hajduk", "esports"],
    polymarketCategories: [{ slug: "sports" }],
    firstPolymarketCategories: [{ slug: "sports" }],
    polymarketTags: [{ slug: "sports" }, { slug: "ucl-fen-stu1-2026-08-05-exact-score" }],
    firstPolymarketTags: [{ slug: "esports" }, { slug: "ucl-fen-stu1-2026-08-05-exact-score" }],
    riskGroupLabels: [
      "Market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5",
      "Event: uwcl-faw-haj-2026-08-05",
      "Team: sk brann",
      "Topic: bitcoin",
    ],
  }));

  const report = bot.buildCalculationReport(state);
  const rows = [...report.categorySummaries, ...report.tagSummaries];
  const labels = rows.map((row) => row.label);
  for (const noise of [
    "market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5",
    "event: uwcl-faw-haj-2026-08-05",
    "team: sk brann",
    "topic: bitcoin",
    "match: fc bayern vs hajduk",
    "ucl-fen-stu1-2026-08-05-exact-score",
  ]) {
    assert.ok(!labels.includes(noise), `${noise} must not appear as a row`);
  }
  // The genuine taxonomy on the same rows must survive the filter.
  for (const kept of ["esports", "sports"]) {
    assert.ok(labels.includes(kept), `${kept} must still be reported`);
  }
  // A category that was nothing but a fixture slug falls back rather than leaking.
  assert.ok(
    !labels.some((label) => /-(?:19|20)\d{2}-\d{2}-\d{2}/.test(label)),
    `no row may carry a dated fixture slug, got ${JSON.stringify(labels)}`,
  );
});

test("parameter combinations: a resolved row keeps its scrape-time entry price", () => {
  // Why "Resolved" in Best parameter combinations fell far short of the resolved list's
  // own count: a settled book prints 0 or 1, firstMarketProbability was seeded from it
  // before lastLiveMarketProbability existed, and an entry price of exactly 0 or 1 is
  // discarded -- so those resolved rows left the simulation altogether instead of
  // being counted in it.
  const resolvedRow = {
    tokenId: "12345678901234567890",
    question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?",
    status: "RESOLVED",
    marketClosed: true,
    // The settlement print, which must not be taken as the entry price.
    marketProbability: 1,
    firstMarketProbability: 1,
    // The quote the market actually carried while it was tradable.
    lastLiveMarketProbability: 0.9,
    finalOutcomePrice: 1,
    firstLiquidity: 60000,
    firstDaysToResolution: 1,
  };
  const state = bot.normalizeState({ marketObservations: [resolvedRow] });
  const report = bot.buildCalculationReport(state);
  assert.equal(report.sampleSize, 1, "the resolved row must reach the simulation at all");
  assert.equal(report.resolvedSampleSize, 1, "and must be counted as resolved, not dropped");
  assert.equal(report.examples[0].firstProbability, 0.9, "the scrape-time quote is the entry price");

  // A row that genuinely never had a live quote stays excluded: a 0%/100% entry is not
  // a tradable simulation, which is the caveat the report is expected to keep.
  const neverLive = bot.normalizeState({
    marketObservations: [{ ...resolvedRow, lastLiveMarketProbability: null }],
  });
  assert.equal(bot.buildCalculationReport(neverLive).sampleSize, 0);
});

test("parameter combinations: every distinct rule uses the full resolved sample and reports average volume", async () => {
  // A liquidity-floor loop made four copies of each probability/horizon rule. It did
  // not make the report more informative, and its ROI-first UI slice hid most of the
  // high-evidence rows. Volume is now a descriptive aggregate, not a synthetic fourth
  // dimension of every parameter combination.
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  state.marketObservations = state.marketObservations.map((row, index) => ({
    ...row,
    firstVolumeUsdc: 1000 + index * 100,
    firstDaysToResolution: 4,
    daysToResolution: 4,
  }));
  const pendingSource = state.marketObservations.find((row) => {
    const price = Number(row.firstMarketProbability ?? row.lastLiveMarketProbability ?? row.marketProbability);
    return price > 0 && price < 1;
  });
  assert.ok(pendingSource, "the fixture must contain a tradable price for the pending regression case");
  state.marketObservations.push({
    ...pendingSource,
    id: "pending-statistics-regression",
    status: "SCRAPED",
    marketClosed: false,
    finalOutcomePrice: null,
  });
  const report = bot.buildCalculationReport(state);
  const withoutPending = bot.buildCalculationReport({
    ...state,
    marketObservations: state.marketObservations.filter((row) => row.id !== "pending-statistics-regression"),
  });
  assert.equal(report.parameterSummaries.length, 90, "3 market types x 6 thresholds x 5 horizons");
  assert.ok(report.parameterSummaries.every((row) => !Object.hasOwn(row, "minLiquidityUsdc")));
  const widest = report.parameterSummaries.find((row) => row.marketType === "all"
    && row.threshold === 0.5
    && row.maxResolutionDays === 30);
  assert.equal(report.sampleSize, report.resolvedSampleSize,
    "performance statistics must exclude unresolved opportunities from the sample");
  assert.equal(report.observedSampleSize, withoutPending.observedSampleSize + 1,
    "the report retains the inventory count for the pending observation");
  assert.equal(report.sampleSize, withoutPending.sampleSize,
    "but the pending observation must stay outside performance statistics");
  assert.equal(widest.trades, report.sampleSize, "the broadest rule must retain every resolved trade");
  assert.equal(widest.pending, 0, "a parameter combination must never include pending opportunities");
  assert.ok(Number.isFinite(widest.avgVolumeUsdc) && widest.avgVolumeUsdc > 0,
    "the rule must expose the average first-scraped traded volume");
  const annualizedRule = report.parameterSummaries.find((row) => Number.isFinite(row.annualizedPnlPerTradeUsdc));
  assert.ok(annualizedRule,
    "a rule with a measured resolution horizon must expose comparable annualized P/L per fixed simulation trade");

  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  assert.match(app, /key: "annualizedPnlPerTradeUsdc",\s*direction: "desc"/);
  assert.match(app, /calculationHeader\("annualizedPnlPerTradeUsdc", "P\/L p\.a\."\)/);
  assert.match(app, /calculationHeader\("avgVolumeUsdc", "Avg volume"\)/);
  assert.doesNotMatch(app, /calculationHeader\("resolved", "Resolved"\)/);
  assert.doesNotMatch(app, /calculationHeader\("minLiquidityUsdc", "Min liquidity"\)/);
  assert.doesNotMatch(app, /rows\.slice\(0, 80\)/);
});

test("taxonomy performance: an unknown horizon reports no p.a. at all", async () => {
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

  state.marketObservations = state.marketObservations.map((row) => ({
    ...row,
    polymarketCategories: ["sports"],
    firstPolymarketCategories: ["sports"],
    polymarketTags: ["football"],
    firstPolymarketTags: ["football"],
  }));
  const report = bot.buildCalculationReport(state);
  const rows = [...report.categorySummaries, ...report.tagSummaries];
  for (const row of rows) {
    if (row.avgDaysToResolution == null) {
      assert.equal(row.annualizedRoi, null,
        `${row.label} has no horizon, so it must not report ${row.annualizedRoi} p.a.`);
    }
  }
});

test("taxonomy performance: every resolved trade is represented by a real label or an explicit fallback", () => {
  const resolvedRow = {
    tokenId: "taxonomy-unclassified-token",
    question: "Will the category fallback be visible?",
    status: "RESOLVED",
    marketClosed: true,
    marketProbability: 1,
    firstMarketProbability: 0.8,
    lastLiveMarketProbability: 0.8,
    finalOutcomePrice: 1,
    firstLiquidity: 60000,
    firstDaysToResolution: 2,
  };
  const report = bot.buildCalculationReport(bot.normalizeState({ marketObservations: [resolvedRow] }));
  assert.deepEqual(report.taxonomyCoverage.category, {
    totalTrades: 1,
    classifiedTrades: 0,
    unclassifiedTrades: 1,
  });
  assert.deepEqual(report.taxonomyCoverage.tag, {
    totalTrades: 1,
    classifiedTrades: 0,
    unclassifiedTrades: 1,
  });
  assert.equal(report.categorySummaries.find((row) => row.label === "uncategorized")?.trades, 1);
  assert.equal(report.tagSummaries.find((row) => row.label === "untagged")?.trades, 1);
});

test("taxonomy performance: categories and tags render as separately sorted tables", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  assert.match(app, /taxonomySort: \{/);
  assert.match(app, /category: \{ key: "annualizedPnlPerTradeUsdc", direction: "desc" \}/);
  assert.match(app, /tag: \{ key: "annualizedPnlPerTradeUsdc", direction: "desc" \}/);
  assert.match(app, /data-taxonomy-sort="\$\{kind\}" data-taxonomy-sort-key="\$\{key\}"/);
  assert.match(app, /const taxonomyButton = event\.target\.closest\("\[data-taxonomy-sort\]"\);/);
  assert.match(app, /const button = event\.target\.closest\("\[data-calculation-sort\]"\);/);
  assert.match(app, /"Category performance"/);
  assert.match(app, /"Tag performance"/);
  assert.doesNotMatch(app, /Category and tag performance/);
  assert.match(app, /kind === "category" && !hasSplitTaxonomy/,
    "legacy inferred categories must stay hidden until a split report is generated");
  // Every column in both tables is sortable.
  const sorted = [...app.matchAll(/taxonomyHeader\(kind, "([a-zA-Z]+)"/g)].map((match) => match[1]);
  for (const key of ["label", "trades", "accuracy", "pnl", "annualizedPnlPerTradeUsdc", "pnlPerTradeUsdc",
    "roi", "annualizedRoi", "avgNetYield", "avgDaysToResolution", "avgProbability", "avgVolumeUsdc", "lastResolvedAt"]) {
    assert.ok(sorted.includes(key), `${key} column must be sortable`);
  }
  // The header count must match the colspan on the empty row, or the layout breaks.
  assert.match(app, /colspan="13"/);
  assert.equal(sorted.length, 13);
  assert.doesNotMatch(app, /data-category-kind/);

  // The report is stored in the core state file, so its row count must be bounded.
  const botSource = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(botSource, /SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT/);
  assert.match(botSource, /return rows\.slice\(0, SCRAPED_SIMULATION_CATEGORY_ROW_LIMIT\);/);
  assert.match(botSource, /if \(labels\.length >= SCRAPED_SIMULATION_TAGS_PER_TRADE\) return labels;/);
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

test("execution revalidation: a missing probability estimate must not crash the shortlist", () => {
  // The reported bug. Conservative revalidated 80 stored candidates and marked every
  // one ERROR with "execution shortlist revalidation failed: Cannot read properties of
  // null (reading 'toFixed'); base status ERROR is not executable". annualizeReturn()
  // returns null for a non-finite input, which is normal for a scraped candidate that
  // was never AI-analysed, and the storage rounding called .toFixed() on it. The whole
  // object literal threw, so nothing was returned and a shortlist of tradable markets
  // (93% market probability, $80k liquidity) was discarded by a crash, not by a rule.
  assert.equal(bot.rounded(null, 4), null);
  assert.equal(bot.rounded(undefined, 4), null);
  assert.equal(bot.rounded(NaN, 4), null);
  assert.equal(bot.rounded(Infinity, 4), null);
  assert.equal(bot.rounded(0.12345, 4), 0.1235);
  assert.equal(bot.rounded(0, 2), 0, "a real zero must survive, not become null");
  assert.equal(bot.rounded("0.5", 2), 0.5);

  // annualizeReturn genuinely produces null for the input that triggered this.
  assert.equal(bot.annualizeReturn(NaN, 3), null);
  assert.equal(bot.rounded(bot.annualizeReturn(NaN, 3), 4), null, "the pair must compose safely");

  // No unguarded rounding may remain on a value annualizeReturn can null out.
  const source = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  for (const field of ["annualizedReturn", "expectedRoi", "expectedValue", "edge"]) {
    assert.ok(
      !new RegExp(`economics\\.${field}\\.toFixed`).test(source),
      `economics.${field}.toFixed() can throw and must go through rounded()`,
    );
  }
});

test("execution revalidation: a polymarket-source portfolio is judged on market numbers", () => {
  // The user's point: paper must decide like live. For probabilitySource "polymarket"
  // the ranking metric has to come from the market quote, never from an AI estimate
  // that a scraped candidate does not have.
  const strategy = { ...bot.PAPER_STRATEGIES.conservative, probabilitySource: "polymarket" };
  const item = {
    tokenId: "12345678901234567890",
    status: "SCRAPED",
    marketProbability: 0.93,
    liquidity: 80842.54,
    daysToResolution: 0.5,
    netGainIfWinUsdc: 0.32,
    totalCostUsdc: 5.02,
    netYield: 0.0637,
    // Deliberately absent: this candidate was never AI-analysed.
    aiProbability: null,
    annualizedReturn: null,
    expectedValueUsdc: null,
  };
  const economics = bot.portfolioEconomics(item, strategy);
  assert.equal(economics.probabilitySource, "polymarket");
  assert.ok(Number.isFinite(economics.annualizedReturn), "market p.a. must be computed without an AI probability");
  assert.equal(economics.expectedValueUsdc, 0.32, "the market path uses the net gain, not the AI expected value");
  assert.ok(economics.annualizedReturn > 0);
});

test("market dates: a date recovered from a slug is a whole day, not a kickoff", () => {
  // Reported: finished fixtures stayed in Execution candidates showing an end date of
  // 07. 08. 2026 01:59 -- midnight UTC in Prague, i.e. the slug's day stretched to
  // 23:59:59. val-fpx-jdg-2026-08-06 had already been played.
  //
  // sportsScheduledEventDate returns either a real kickoff or a date recovered from the
  // slug, and the future-kickoff rule could not tell them apart. A whole-day date is "in
  // the future" for the entire day it names, so it overrode the market's real end date
  // and kept the fixture listed until the next morning.
  const played = bot.marketDateContext({
    question: "Valorant: FunPlus Phoenix vs JD Gaming - Map 2 Winner",
    slug: "val-fpx-jdg-2026-08-06",
    eventSlug: "val-fpx-jdg-2026-08-06",
    endDate: "2026-08-06T18:00:00Z",
  });
  assert.equal(Date.parse(played.endDate), Date.parse("2026-08-06T18:00:00Z"),
    "the market's own end date must win over a whole-day slug bucket");
  assert.equal(played.endDateSource, "polymarket-resolution-window");
  // The slug date is still reported, just not used as the end date.
  assert.ok(played.scheduledEventDate.startsWith("2026-08-06T23:59:59"));

  // A real kickoff still ahead must still override a stale end date -- the case the
  // future-kickoff rule was added for in the first place.
  const kickoff = new Date(Date.now() + 2 * 3600000).toISOString();
  const upcoming = bot.marketDateContext({
    question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?",
    gameStartTime: kickoff,
    resolutionEndDate: new Date(Date.now() - 3 * 3600000).toISOString(),
  });
  assert.equal(upcoming.endDate, kickoff);
  assert.equal(upcoming.endDateSource, "sports-event-start");

  // With no end date at all the slug remains a usable fallback rather than nothing.
  const slugOnly = bot.marketDateContext({
    question: "Valorant: FunPlus Phoenix vs JD Gaming - Map 2 Winner",
    slug: "val-fpx-jdg-2026-08-06",
  });
  assert.ok(slugOnly.endDate.startsWith("2026-08-06T23:59:59"));
  assert.equal(slugOnly.endDateSource, "sports-event-start");
});

test("market dates: a kickoff that hasn't happened yet outranks a stale resolution window", () => {
  // Live bug: an exact-score sub-market's own resolutionEndDate said 02:00 (already
  // past), while Polymarket's own event page still showed a ~2h countdown to an 18:30
  // kickoff -- gameStartTime is the fresher, sports-API-sourced signal and must win
  // whenever it is still in the future, even though it falls after resolutionEndDate.
  const kickoff = new Date(Date.now() + 2 * 3600000).toISOString();
  const staleResolutionWindow = new Date(Date.now() - 3 * 3600000).toISOString();
  const context = bot.marketDateContext({
    question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?",
    gameStartTime: kickoff,
    resolutionEndDate: staleResolutionWindow,
  });
  assert.equal(context.endDate, kickoff, "the future kickoff must win over the stale, already-past resolution window");
  assert.equal(context.endDateSource, "sports-event-start");
  assert.equal(context.sportsEventStarted, false, "the game has not kicked off yet");
});

test("market dates: with no scheduled kickoff at all, the resolution window is still used", () => {
  const resolutionWindow = new Date(Date.now() + 3600000).toISOString();
  const context = bot.marketDateContext({ question: "Will it rain tomorrow?", resolutionEndDate: resolutionWindow });
  assert.equal(context.endDate, resolutionWindow);
  assert.equal(context.endDateSource, "polymarket-resolution-window");
});

test("market dates: an already-past kickoff still yields to an even-earlier-closing resolution window", () => {
  // Not the common shape, but confirms the fix's new future-kickoff branch does not
  // swallow the original comparison when both dates are already in the past.
  const kickoff = new Date(Date.now() - 3600000).toISOString();
  const resolutionWindow = new Date(Date.now() - 2 * 3600000).toISOString();
  const context = bot.marketDateContext({
    question: "Exact Score: SSC Napoli 1 - 0 CA Osasuna?",
    gameStartTime: kickoff,
    resolutionEndDate: resolutionWindow,
  });
  assert.equal(context.endDate, resolutionWindow);
  assert.equal(context.endDateSource, "polymarket-resolution-window");
});

test("market metric: the app filters and shows traded volume, not order-book liquidity", async () => {
  const { readFile } = await import("node:fs/promises");
  const bot2 = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // Reported: the dashboard's number never matched Polymarket's. It was showing Gamma's
  // `liquidity` (order-book depth) while the site shows traded volume ("$37.9K Vol.") --
  // two different measurements, so they could never agree. Volume is the metric now.
  for (const [label, source] of [["bot", bot2], ["executor", executor]]) {
    assert.match(source, /volumeNum/, `${label} must read Polymarket's own volume field`);
  }
  assert.match(bot2, /function marketVolumeUsdc\(market = \{\}\) \{/);
  assert.match(bot2, /volumeUsdc: Number\(marketVolumeUsdc\(market\)\.toFixed\(2\)\)/,
    "the scrape has to store volume, or nothing downstream can use it");

  // Every layer resolves the same way, and falls back to the stored liquidity so rows
  // captured before the switch keep working until they are refreshed.
  for (const [label, source] of [["bot", bot2], ["executor", executor], ["app", app]]) {
    assert.match(source, /\[item\??\.volumeUsdc, item\??\.volume24hr, item\??\.firstVolume24hr, item\??\.liquidity\]/,
      `${label} must resolve volume with the same fallback chain`);
  }

  // The thresholds are volume thresholds now, in both the paper and the live path.
  assert.match(bot2, /rowVolumeUsdc\(item\) < minLiquidityUsdc/);
  assert.match(bot2, /reasons\.push\(`volume \$\{candidateVolume\.toFixed\(2\)\} below/);
  assert.match(executor, /const candidateVolume = candidateVolumeUsdc\(item\);/);
  assert.match(executor, /`volume \$\{candidateVolume\.toFixed\(2\)\} USDC below live minimum/);
  // Live revalidation refreshes it, so an executed check updates the stored figure.
  assert.match(executor, /const volumeUsdc = number\(market\.volumeNum, number\(market\.volume, volume24hr\)\)/);
  assert.match(executor, /"volumeUsdc",/, "the persisted field list must carry it back to the row");

  // The tables and the filter control say volume, and read it.
  assert.ok(!/<th>Liquidity<\/th>/.test(app), "no table may still head a column Liquidity");
  assert.ok(!/data-label="Liquidity"/.test(app), "no cell may still be labelled Liquidity");
  assert.match(app, /data-label="Volume">\$\{money\(rowVolumeUsdc\(item\)\)\}/);
  assert.match(app, /scrapedSortableHeader\("liquidity", "Volume"\)/);
  assert.match(app, /\["Volume filter",/);
  assert.match(html, /<span>Volume min<\/span>/);
  assert.match(html, /<span>Min traded volume<\/span>/);
});

test("candidates: a finished event stops being listed, an in-play one does not", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const bot2 = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Reported: a Conservative run could only SKIP while several candidates were listed,
  // and their evaluation already said "event end date is in the past". Evaluation knew;
  // the list filter did not, so finished events kept occupying the shortlist.
  for (const [label, source] of [["app", app], ["bot", bot2]]) {
    assert.match(source, /reasons\.push\("event end date is in the past"\);/,
      `${label} must drop a candidate whose resolution window has passed`);
    // Not for a sports row dated by kickoff: past kickoff means in play, not finished,
    // and those are still tradable. Hiding them would be worse than listing a stale one.
    assert.match(source, /String\(item\.endDateSource \|\| ""\) !== "sports-event-start"/,
      `${label} must not hide an in-play fixture`);
  }

  // The evaluator already retires such rows in the stored state, which is what makes the
  // list agree with it rather than merely hiding the row on screen.
  assert.match(bot2, /rejectReasons\.unshift\("event end date is in the past; awaiting resolution sync"\)/);
  assert.match(bot2, /status: "RESOLVED",\s*\n\s*thesisType: "RESOLVED",/);

  // Ordering: the past-date check must precede the max-horizon check, or a finished event
  // would be reported as merely exceeding the horizon.
  const filter = bot2.slice(bot2.indexOf('reasons.push("event end date is in the past");'));
  assert.match(filter.slice(0, 400), /else if \(days > maxResolutionDays\)/);
});

test("no model: the bot consults no AI provider and never waits on a memo", async () => {
  const { readFile } = await import("node:fs/promises");
  const bot2 = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Reported: candidates were unexecutable with "Gemini grounded AI analysis is pending"
  // and "base status ERROR is not executable". The portfolios must not use a model at all.
  //
  // One switch, off by default, and everything that could reach a provider or block on a
  // memo hangs off it -- so a stale env var or the stored portfolio config on the hosting
  // cannot turn it back on by itself.
  assert.match(bot2, /const AI_ANALYSIS_ENABLED = envBool\("PAPER_AI_ANALYSIS_ENABLED", false\);/);
  assert.match(bot2, /const GEMINI_API_KEY = AI_ANALYSIS_ENABLED \? \(process\.env\.GEMINI_API_KEY \|\| ""\) : "";/,
    "no key means callGeminiJson returns before making a request");
  assert.match(bot2, /const OPENAI_API_KEY = AI_ANALYSIS_ENABLED \? \(process\.env\.OPENAI_API_KEY \|\| ""\) : "";/,
    "'not Gemini' must not quietly mean 'some other provider'");
  assert.match(bot2, /const REQUIRE_GEMINI = AI_ANALYSIS_ENABLED && envBool/,
    "a memo that is never produced must not be required");
  assert.match(bot2, /const AI_ANALYSIS_LIMIT = AI_ANALYSIS_ENABLED \? envNumber\("PAPER_AI_ANALYSIS_LIMIT", 2\) : 0;/);
  // The request site is still guarded by the key it can no longer receive.
  assert.match(bot2, /async function callGeminiJson\(messages\) \{\s*\n\s*if \(!GEMINI_API_KEY\) return null;/);

  // With no model there is no AI probability, so ranking must fall to the market quote --
  // otherwise every candidate carries a NaN probability and nothing is executable.
  assert.match(bot2, /if \(!AI_ANALYSIS_ENABLED\) return "polymarket";/);
  assert.equal(bot.PAPER_STRATEGIES.conservative.probabilitySource, "polymarket");
  assert.equal(bot.PAPER_STRATEGIES.highReward.probabilitySource, "polymarket");
  assert.equal(bot.PAPER_STRATEGIES.moreProbable.probabilitySource, "polymarket");

  // And the workflows must neither ask for the AI source nor ship credentials.
  for (const name of ["trading-paper-bot", "trading-paper-evaluation"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.ok(!/GEMINI_API_KEY|GEMINI_MODEL|OPENAI_API_KEY/.test(workflow),
      `${name} must not pass model credentials`);
    assert.ok(!/PROBABILITY_SOURCE: "ai"/.test(workflow), `${name} must not request the AI source`);
    assert.match(workflow, /PAPER_REQUIRE_GEMINI: "false"/);
  }
});

test("no model: the 'use Polymarket probability' switch is gone and cannot be flipped back", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, html, executorSource, liveWorkflow] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
  ]);

  // With no AI probability left to choose between, the toggle only offered a way to
  // break scoring. Deleting the control is not enough on its own: the value is stored
  // per portfolio on the hosting, so a config saved months ago still says "ai" and
  // would keep every candidate at a NaN probability with no way to fix it from the UI.
  // Each layer therefore decides the source itself instead of reading it back.
  assert.ok(!/data-polymarket-probability/.test(html), "the settings control must be gone");
  assert.ok(!/polymarketProbability/.test(app), "no element binding may survive the control");
  assert.match(app, /function normalizeProbabilitySource\(\) \{\n  return "polymarket";\n\}/,
    "a stored 'ai' config must still resolve to the market probability");

  // Run the shipped function over the values a stored config can actually hold.
  const normalize = new Function(`${/function normalizeProbabilitySource\(\)[\s\S]*?\n\}/.exec(app)[0]}
    return normalizeProbabilitySource;`)();
  for (const stored of ["ai", "AI", "gemini", "", null, undefined]) {
    assert.equal(normalize(stored), "polymarket", `stored ${JSON.stringify(stored)} must score on the market`);
  }

  // Same on the execution side, where the value used to arrive through the environment.
  assert.match(executorSource, /^const PROBABILITY_SOURCE = "polymarket";$/m);
  assert.ok(!/process\.env\.LIVE_PROBABILITY_SOURCE/.test(executorSource),
    "the executor must not read a source it no longer supports");
  assert.ok(!/LIVE_PROBABILITY_SOURCE: "ai"/.test(liveWorkflow), "the live workflow must not request the AI source");
  assert.ok(!/"LIVE_PROBABILITY_SOURCE": live\.get\("probabilitySource"\)/.test(liveWorkflow),
    "the stored portfolio config must not be able to inject the AI source either");

  // And the reject reason the user kept seeing must now be unreachable.
  assert.ok(!/grounded Gemini analysis is pending/.test(executorSource));
});

test("paper economics: a candidate with no stored netYield is not scored as break-even", () => {
  // Reported: no paper trade could pass, every candidate showing net yield 0.0% and
  // potential p.a. 0.0% while the market probability read 93-95%.
  //
  // Two defects compounded. A scraped evaluation never persisted netYield, so the
  // annualization had nothing to work from and returned null -- and Number(null) is
  // 0, not NaN, so "no p.a. could be computed" became an exact break-even that the
  // filter then rejected as "non-profitable after fees". Missing data read as a hard
  // and wrong verdict.
  const strategy = { ...bot.PAPER_STRATEGIES.conservative, probabilitySource: "polymarket" };
  const scraped = { marketProbability: 0.93, marketPrice: 0.93, netGainIfWinUsdc: 0.0723, totalCostUsdc: 1, daysToResolution: 0.5 };

  const economics = bot.portfolioEconomics(scraped, strategy);
  assert.equal(economics.expectedValueUsdc, 0.0723);
  // 7.23% over half a day is a large annualized number; the point is that it is the
  // real one and strictly positive, not zero.
  assert.ok(economics.annualizedReturn > 1, `expected a real p.a., got ${economics.annualizedReturn}`);
  assert.equal(Number(economics.annualizedReturn.toFixed(3)), 52.779);

  // A stored value still wins, so the one-day annualization floor keeps applying.
  assert.ok(bot.netYieldAfterFees({ netYield: 0.04, netGainIfWinUsdc: 99, totalCostUsdc: 1 }) === 0.04);

  // And genuinely absent economics must stay absent -- "unknown", never "worthless".
  const unknown = bot.portfolioEconomics({ marketProbability: 0.93, daysToResolution: 0.5 }, strategy);
  assert.equal(unknown.annualizedReturn, null, "an unknown p.a. must not become 0");
  assert.equal(unknown.expectedValueUsdc, null);
});

test("paper economics: the scraped evaluation persists what the portfolios rank on", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  // Deriving these on read is what left a missing field scoring the row at a flat
  // zero, so the record itself must carry them.
  assert.match(source, /netYield: rounded\(totalCost > 0 \? netGainIfWin \/ totalCost : null, 4\)/);
  assert.match(source, /potentialAnnualizedReturn: rounded\(/);
  // The shared guard against the Number(null) trap.
  assert.match(source, /function numericOrNaN\(value\) \{\n  return value == null \|\| value === "" \? NaN : Number\(value\);\n\}/);
});

test("automation: a portfolio can be switched off and paced, and a manual run overrides both", () => {
  const base = bot.PAPER_STRATEGIES.conservative;
  const now = Date.parse("2026-08-07T12:00:00Z");
  const minutesAgoIso = (minutes) => new Date(now - minutes * 60000).toISOString();

  // Off means off for automatic runs.
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...base, automationEnabled: false }, { manual: false }), false);
  // Absent means on: a portfolio saved before the switch existed must keep trading
  // rather than silently stop because a field it never had reads as false.
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...base, automationEnabled: undefined }, { manual: false }), true);
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...base, automationEnabled: true }, { manual: false }), true);
  // ...but a manual run still trades a switched-off portfolio.
  assert.equal(bot.strategyMatchesExecutionTrigger({ ...base, automationEnabled: false }, { manual: true }), true);

  // The interval is the portfolio's own cadence, independent of how often the
  // workflow happens to be scheduled.
  const hourly = { ...base, executionCronMinutes: 60 };
  assert.equal(bot.strategyCadenceIsDue(hourly, minutesAgoIso(59), now, { manual: false }), false, "not due yet");
  assert.equal(bot.strategyCadenceIsDue(hourly, minutesAgoIso(59), now, { manual: true }), true, "a manual run ignores the cadence");
  assert.equal(bot.strategyCadenceIsDue(hourly, minutesAgoIso(61), now, { manual: false }), true, "due");
  assert.equal(bot.strategyCadenceIsDue(hourly, null, now, { manual: false }), true, "no previous run is not a reason to wait");
  // 0 keeps the old behaviour: every scheduled run.
  assert.equal(bot.strategyCadenceIsDue({ ...base, executionCronMinutes: 0 }, minutesAgoIso(1), now, { manual: false }), true);
});

test("manual live execution: the server no longer demands a parameter that was removed", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // Reported: "Manual live execution requires a current execution shortlist and its
  // probability source. Refresh the shortlist before running." That guard outlived the
  // parameter -- the probability source was removed with the AI pipeline, so the check
  // could never be satisfied again and every manual live run was rejected with 400.
  assert.ok(!/live_execution_probability_source/.test(api),
    "the server must not read a request field that no longer exists");
  assert.ok(!/requires a current execution shortlist/.test(api),
    "and must not refuse a run over a shortlist the dashboard refreshes as part of running");
});

test("market scan: a run evicted from the queue is retaken, not reported as an error", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const scan = await readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8");
  const bot2 = await readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8");

  // Reported: a manual "esports" scan showed 'Error: Scan workflow finished with
  // cancelled.' The run was cancelled 22 seconds after dispatch, having never run.
  //
  // The scan shares a concurrency group with the paper bot -- correctly, since both
  // publish paper-state.json and must never overlap -- and in a non-cancelling group
  // GitHub keeps one run in progress and one pending, evicting the pending one the
  // moment a third is queued. So the scan lost its place in the queue; nothing failed
  // and nothing was scanned.
  for (const [label, workflow] of [["scan", scan], ["paper bot", bot2]]) {
    assert.match(workflow, /group: trading-paper-bot/, `${label} must stay serialized against the other`);
    assert.match(workflow, /cancel-in-progress: false/, `${label} must not cancel a run that is mid-write`);
  }

  const fn = app.slice(app.indexOf("const dispatchScan = async () =>"));
  const body = fn.slice(0, fn.indexOf("state.scrapedScanStatus = \"Publishing scan results...\""));
  assert.match(body, /workflow\?\.status === "completed" && workflow\.conclusion === "cancelled"/,
    "an eviction must be recognised rather than surfaced as a failure");
  assert.match(body, /re-queuing/, "and the user must see it was retaken, not that it broke");
  // Exactly one retry: a genuine cancellation must still surface instead of looping.
  assert.equal((body.match(/await dispatchScan\(\);/g) || []).length, 2);
  // A failed scan now publishes its reason before the workflow goes red, so that reason is
  // preferred -- but an eviction has no reason to report, and must still surface as before.
  assert.match(body, /throw new Error\(reason \|\| `Scan workflow finished with \$\{workflow\.conclusion/,
    "a second cancellation is still reported");
});

test("5050 tab: the portfolio is a live mode with its own config and run log", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // 5050 trades the same wallet as the main live portfolio, so it shares every live
  // view -- positions, orders, account. What must not be shared is the config it is
  // steered by and the run log it writes, because the two decide separately.
  assert.match(html, /data-mode-toggle="live-5050"/, "it needs its own tab");
  assert.match(app, /const LIVE_MODES = new Set\(\["live", "live-5050"\]\);/);
  assert.match(app, /function isLiveMode\(\) \{\n  return LIVE_MODES\.has\(state\.mode\);\n\}/,
    "every live view must recognise it, or the tab renders as a paper portfolio");
  assert.match(app, /isFixedEntryMode\(mode\) \? "live5050" : "live"/, "separate config");
  assert.match(app, /isFixedEntryMode\(mode\) \? "data\/live-5050-execution-state\.json"/, "separate run log");
  assert.match(app, /fetchJson\(liveExecutionStateFile\(/, "and the load must actually use it");

  // Its defaults are the strategy: a fixed entry price, many bids, and automation
  // off until it is deliberately switched on -- this one commits past its capital.
  assert.match(app, /live5050: \{/);
  assert.match(app, /fixedEntryPrice: 0\.5,/);
  assert.match(app, /automationEnabled: false,/);
});

test("days left: under a day reads in hours, not tenths of a day", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const compactDays = new Function(`${/function compactDays\(value\)[\s\S]*?\n\}/.exec(app)[0]}
    return compactDays;`)();

  // "0.2 d" has to be converted before it means anything, and the old "< 0.1 d"
  // bucket covered everything from two hours down to two minutes -- which is the
  // range that matters most for the short-dated sports markets this trades.
  assert.equal(compactDays(0.2), "4.8 h");
  assert.equal(compactDays(0.75), "18.0 h");
  assert.equal(compactDays(0.05), "1.2 h");
  assert.ok(!/</.test(compactDays(0.02)), "the catch-all bucket must be gone");
  assert.equal(compactDays(0.02), "29 min", "below an hour, minutes");

  // A day and over is unchanged.
  assert.equal(compactDays(1), "1.0 d");
  assert.equal(compactDays(3.4), "3.4 d");
  // The boundary belongs to hours, so nothing renders as "1.0 d" twice.
  assert.equal(compactDays(0.99), "23.8 h");

  // Superseded: "due now" used to cover everything at or past the end date, which hid
  // how long a market had been overdue. A passed date now reads as a negative horizon.
  assert.equal(compactDays(0), "< 1 min");
  assert.equal(compactDays(-1), "-1.0 d");
  assert.equal(compactDays(Number.NaN), "-");
  assert.equal(compactDays(0.0005), "1 min");
});

test("5050: it is its own live portfolio, not a copy of a paper one", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: the 5050 tab showed the conservative paper portfolio. The mode was
  // recognised as live everywhere except the one place that decides which loader
  // runs, so it fell through to the paper bot's state.
  assert.match(app, /return LIVE_MODES\.has\(requestedMode\)\n\s*\? loadLiveState\(/,
    "a live portfolio must load live data");
  assert.ok(!/return requestedMode === "live"\n\s*\? loadLiveState/.test(app));

  // Overview finances come from the shared Polymarket account, as they must --
  // there is one wallet -- but orders, positions and the run log are attributed.
  assert.match(app, /function submittedTokenIds\(executionState\)/);
  assert.match(app, /return isFixedEntryMode\(\) \? owned : !owned;/,
    "each token shows under exactly one of the two live portfolios");
  assert.match(app, /\.filter\(belongsToActiveLivePortfolio\)/);
  assert.match(app, /!isFixedEntryMode\(\) && Array\.isArray\(state\.liveState\?\.runLog\)/,
    "and 5050's run log is its own");

  // A token nobody claims belongs to Live: attribution must never hide a row from
  // both tabs, and a failed fetch must not reassign 5050's positions wholesale.
  assert.match(app, /if \(!tokenId\) return !isFixedEntryMode\(\);/);
  assert.match(app, /if \(fixedEntryResult\.status === "fulfilled"\) state\.live5050ExecutionState/);

  // Its own identity, and automation off by default: this is the portfolio that
  // deliberately commits past its capital.
  assert.match(app, /"5050 - fixed-entry bids"/);
  assert.match(app, /live5050: \{[\s\S]*?automationEnabled: false,/);
});

test("portfolio config: a setting the server drops can never persist", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // normalize_strategy_config rebuilds the config from a fixed key list, so any key
  // it does not return is discarded on every save no matter what the dashboard
  // sends. The automation switch and the cron interval were both missing, which
  // would have made them look like they saved and silently reset.
  const strategy = api.slice(api.indexOf("function normalize_strategy_config"));
  const body = strategy.slice(0, strategy.indexOf("\n}"));
  assert.match(body, /'executionCronMinutes' =>/);
  assert.match(body, /'automationEnabled' =>/);
  assert.match(body, /\$defaults\['automationEnabled'\] \?\? true/, "absent must mean on");

  // 5050 is a whole portfolio the normalizer never copied, so its settings -- the
  // order price above all -- would have vanished on the first save.
  assert.match(api, /\$config\['live5050'\] = normalize_strategy_config\(\$fixedInput, \$defaults\['live5050'\]\);/);
  assert.match(api, /'fixedEntryPrice' => 0\.50,/);
  assert.match(api, /'automationEnabled' => false,/, "5050 ships with automation off");
  // A limit order cannot rest at 0 or 1, so a bad price must not reach the executor
  // and be rejected by the exchange one bid at a time.
  assert.match(api, /\(\$entryPrice > 0 && \$entryPrice < 1\)/);
});

test("5050: the order price is a portfolio setting, not only a dispatch input", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");

  // It has to be visible and editable where the portfolio is configured.
  assert.match(html, /data-fixed-entry-price/);
  assert.match(app, /function normalizeFixedEntryPrice\(value\)/);
  assert.match(app, /els\.fixedEntryPrice\?\.addEventListener\("change"/);
  // The order count is not capped: the exchange reserves collateral per resting bid,
  // so the balance bounds it and a configured ceiling only stopped the strategy
  // short of what it could fund.
  assert.ok(!/maxOpenOrders/.test(app), "no order ceiling remains in the dashboard");
  assert.ok(!/data-fixed-entry-max-orders/.test(html));
  // And meaningless for every other portfolio, so its control only shows for 5050. Keyed
  // on the mode the sync call is for, not on state.mode as it was: the two differ whenever
  // the panel is synced for a portfolio other than the open tab, and the row then followed
  // the tab rather than the portfolio being edited.
  assert.match(app, /els\.fixedEntryRows\?\.forEach\(\(row\) => row\.toggleAttribute\("hidden", !isFixedEntryMode\(mode\)\)\)/);
  assert.match(app, /every qualifying candidate is bid at/, "the rules card must state it");

  // The saved value has to actually govern the run, or the dashboard and the bids
  // would disagree. A dispatch input overrides it for one run and is blank by
  // default, so it cannot silently shadow the portfolio setting.
  assert.match(workflow, /- name: Load 5050 portfolio config/);
  assert.match(workflow, /"LIVE_FIXED_ENTRY_PRICE": cfg\.get\("fixedEntryPrice"\)/);
  const inputs = workflow.slice(workflow.indexOf("entry_price:"), workflow.indexOf("concurrency:"));
  assert.ok(!/default: "0\.50"/.test(inputs), "a defaulted input would always win over the saved setting");
});

test("portfolio settings: each portfolio owns its own, and cannot change another's", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: the ON/OFF switch behaved as if it applied to everything at once.
  // updatePortfolioConfigForMode special-cased only "live", so "live-5050" fell
  // through to the paper branch -- where paperStrategyIdFromMode answers
  // "conservative" for any mode it does not recognise. Every 5050 setting, the
  // automation switch and the order price alike, was written into the conservative
  // paper portfolio.
  const pick = (re) => re.exec(src)[0];
  const run = new Function("state", `${[
    pick(/function normalizeMode\(mode\)[\s\S]*?\n\}/),
    pick(/const LIVE_MODES = new Set\(\[[^\]]*\]\);/),
    pick(/function isFixedEntryMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    pick(/function liveConfigKeyForMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    pick(/function paperStrategyIdFromMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    pick(/function defaultPortfolioConfig\(\)[\s\S]*?\n\}/),
    pick(/function portfolioConfigForMode\(mode = state\.mode\)[\s\S]*?\n\}/),
    pick(/function updatePortfolioConfigForMode\(mode, updates\)[\s\S]*?\n\}/),
  ].join("\n")}
    const DEFAULT_MAX_RESOLUTION_DAYS = 7;
    return { portfolioConfigForMode, updatePortfolioConfigForMode };`);

  const MODES = ["live", "live-5050", "paper-conservative", "paper-highReward", "paper-moreProbable"];
  for (const changed of MODES) {
    const api = run({ mode: changed, portfolioConfig: null });
    api.updatePortfolioConfigForMode(changed, { automationEnabled: false });
    assert.equal(api.portfolioConfigForMode(changed).automationEnabled, false, `${changed} must keep its own change`);
    for (const other of MODES.filter((m) => m !== changed)) {
      const stillOn = api.portfolioConfigForMode(other).automationEnabled;
      // 5050 is the one that ships off; everything else defaults on.
      const expected = other === "live-5050" ? false : true;
      assert.equal(stillOn, expected, `changing ${changed} must not touch ${other}`);
    }
  }

  // The 5050-only settings land in the 5050 slot, not in a paper strategy.
  const api = run({ mode: "live-5050", portfolioConfig: null });
  api.updatePortfolioConfigForMode("live-5050", { fixedEntryPrice: 0.35 });
  assert.equal(api.portfolioConfigForMode("live-5050").fixedEntryPrice, 0.35);
  assert.equal(api.portfolioConfigForMode("paper-conservative").fixedEntryPrice, undefined,
    "a paper portfolio must never acquire a setting it does not have");
});

test("5050: only equity is shared with Live, never its history", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // One wallet means one equity, and that figure is genuinely shared. Everything
  // else on the overview is account-level -- the main portfolio's entire history --
  // so showing it under 5050 would credit it with trades it never made.
  assert.match(app, /els\.portfolioEquity\.textContent = money\(equity\);/,
    "equity stays the shared account figure");

  const live = app.slice(app.indexOf("const fixedEntry = isFixedEntryMode();"));
  const block = live.slice(0, live.indexOf("data-account-summary") + 1 || 4000);
  assert.match(block, /const realizedPnl = fixedEntry \? ownRealized : rawRealized;/);
  assert.match(block, /const totalPnlValue = fixedEntry \? ownRealized \+ ownOpen : totalPnl;/);
  assert.match(block, /els\.portfolioTotalPl\.textContent = signedMoney\(totalPnlValue\);/);
  assert.match(block, /els\.portfolioOpenPl\.textContent = signedMoney\(openPnlValue\);/);
  // Percentages measure what this portfolio put at risk, not a deposit it does not
  // have of its own.
  assert.match(block, /ownStake > 0 \? value \/ ownStake : null/);

  // Closed trades and the activity feed are attributed too, so the accuracy card
  // and the closed-trades tab cannot show Live's history either.
  assert.match(app, /function liveClosedTrades\(liveState\) \{[\s\S]*?\.filter\(belongsToActiveLivePortfolio\);/);
  assert.match(app, /function liveActivity\(liveState\) \{[\s\S]*?\.filter\(belongsToActiveLivePortfolio\)/);
});

test("dashboard: the browser file cannot borrow a Node-only helper", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: "Can't find variable: number" blanked the entire portfolio dashboard
  // -- parameters, tiles and trades -- on every portfolio. The 5050 P/L split called
  // number(), which exists in the executor but not here. node --check parses, it
  // does not resolve identifiers, so the file compiled cleanly and failed only in
  // the browser at render time.
  //
  // These names all exist in tools/*.mjs and none of them exist in app.js, so a call
  // to one is always this mistake: an executor idiom carried into the browser file.
  const nodeOnly = ["number", "envNumber", "envBool", "hasFlag", "roundToTick", "successfulOrderResponse", "orderResponseError", "selectedProbability", "selectedExpectedValue", "selectedAnnualizedReturn"];
  const source = app
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, "$1"))
    .join("\n");
  for (const name of nodeOnly) {
    const called = new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(source);
    const defined = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`).test(source);
    assert.ok(!called || defined, `app.js calls ${name}() but never defines it`);
  }

  // The call site that broke: it must convert with something the browser has.
  assert.match(app, /const usdc = \(value\) => \{\n\s*const numeric = Number\(value\);/);
  assert.match(app, /closedTrades\.reduce\(\(sum, trade\) => sum \+ usdc\(/);
});

test("dashboard: a renderer cannot read another renderer's local variables", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: "all statistics are shared". renderBotState was rewritten to read
  // totalPnlValue, which is a local of renderLiveState -- a first-occurrence replace
  // that landed in the wrong function. Every paper portfolio then threw at that line,
  // so its tiles kept whatever the previous render had left on screen, which reads
  // exactly as one portfolio's numbers showing under all of them.
  //
  // These are locals of the live renderer's per-portfolio P/L split. Each must appear
  // only inside the function that declares it.
  const lines = app.split("\n");
  const bounds = (name) => {
    const start = lines.findIndex((line) => line.startsWith(`function ${name}(`));
    assert.ok(start >= 0, `${name} not found`);
    const end = lines.findIndex((line, i) => i > start && line === "}");
    return [start, end];
  };
  const [liveStart, liveEnd] = bounds("renderLiveState");

  for (const local of ["totalPnlValue", "openPnlValue", "ownBasePct", "ownRealized", "ownOpen", "ownStake", "fixedEntry", "usdc"]) {
    lines.forEach((line, i) => {
      // A property of the same name is not a read of the variable. `row.fixedEntry` is a
      // field the executor publishes and says nothing about renderLiveState's local, so
      // matching it would make this guard fire on data rather than on scope.
      if (!new RegExp(`(?<![\\w$.?])${local}(?![\\w$])`).test(line.replace(/\?\.\s*/g, "."))) return;
      assert.ok(i >= liveStart && i <= liveEnd,
        `${local} is a local of renderLiveState but is read at app.js:${i + 1} — ${line.trim()}`);
    });
  }

  // And the paper renderer keeps its own figure.
  const [paperStart, paperEnd] = bounds("renderBotState");
  const paper = lines.slice(paperStart, paperEnd).join("\n");
  assert.match(paper, /els\.portfolioTotalPl\.textContent = signedMoney\(totalPnl\);/,
    "the paper portfolio must report its own total P/L");
});

test("automation: every portfolio carries its own ON/OFF badge in its settings", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  // It belongs with the portfolio's own settings, next to the card that names it
  // -- "Live portfolio", "5050 portfolio", the paper label -- so which portfolio it
  // applies to is never in question.
  assert.match(app, /function automationBadgeMarkup\(\)/);
  const card = app.slice(app.indexOf("function renderPortfolioRulesCard"), app.indexOf("portfolio-rule-list"));
  assert.match(card, /<strong>\$\{escapeHtml\(title\)\}<\/strong>\s*\n\s*\$\{automationBadgeMarkup\(\)\}/,
    "the badge must render beside the card's own title");

  // One card is rendered per portfolio, so both paths get it.
  assert.match(app, /renderPortfolioRulesCard\(portfolioState\.label \|\| "Paper portfolio"/);
  assert.match(app, /renderPortfolioRulesCard\(isFixedEntryMode\(\) \? "5050 portfolio" : "Live portfolio"/);

  // The state shown is the open portfolio's own.
  assert.match(app, /const on = automationIsEnabled\(portfolioConfigForMode\(state\.mode\)\);/);
  assert.match(app, /updatePortfolioConfigForMode\(state\.mode, \{ automationEnabled: value \}\)/);

  // The card is rebuilt on every render, so a bound listener would be lost with the
  // element it was attached to. Delegation is what makes the click keep working.
  assert.match(app, /document\.addEventListener\("click", \(event\) => \{\n\s*const toggle = event\.target\?\.closest\?\.\("\[data-automation-toggle\]"\);/);
  assert.ok(!/els\.automationToggle/.test(app), "no stale handle to an element that no longer exists at load");
  assert.ok(!/data-automation-toggle/.test(html), "and no static copy in the markup to go out of sync");

  // This pinned the exact cache-buster the badge shipped with, which froze the
  // stylesheet's version: every later CSS change failed this test for a reason that had
  // nothing to do with the badge. What has to hold is that the badge is styled and that
  // the stylesheet is versioned at all, so a browser holding an old copy re-fetches it.
  const css = await readFile(new URL("../assets/app.css", import.meta.url), "utf8");
  assert.match(css, /^\.automation-toggle \{/m, "the badge must be styled");
  assert.match(css, /^\.automation-toggle\.is-off \{/m, "and off must look different from on");
  assert.match(html, /app\.css\?v=[\w.-]+/, "and the stylesheet must be cache-busted");
});

test("live modes: nothing may treat 5050 as a paper portfolio", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: switching to 5050 flashed several closed trades before they vanished.
  // renderKnownStateForMode tested normalizeMode(mode) === "live", so 5050 fell to
  // renderBotState and painted the paper portfolio's closed trades until the live
  // load replaced them. That single comparison had already caused the tab showing
  // conservative data, the settings writing into the conservative portfolio, and the
  // stats appearing shared -- it is one bug shape, not four.
  //
  // Every place that asks "is this a live portfolio?" must ask it of the set, so
  // adding a live portfolio can never again mean auditing the file by hand.
  const lines = app.split("\n");
  const offenders = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    if (/normalizeMode\([^)]*\)\s*===\s*"live"/.test(line)
      || /\bnormalizedMode\s*===\s*"live"(?!-)/.test(line)) {
      offenders.push(`app.js:${i + 1} — ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, [],
    `these compare against "live" alone and so exclude 5050:\n${offenders.join("\n")}`);

  // The two that matter most, pinned by name.
  assert.match(app, /function renderKnownStateForMode\(mode = state\.mode\) \{\n\s*if \(LIVE_MODES\.has\(normalizeMode\(mode\)\)\) \{/,
    "the pre-load render must not fall through to the paper renderer");
  assert.match(app, /function portfolioForMode\(mode = state\.mode\) \{\n\s*if \(LIVE_MODES\.has\(normalizeMode\(mode\)\)\)/);

  // Reloading on the 5050 tab must not drop back to a paper portfolio.
  assert.match(app, /if \(normalizeMode\(value\) === value\) return value;/);
});

test("5050: the run log is its own, even before it has one", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: 5050 displayed another portfolio's execution history. Its state file
  // does not exist until its first run publishes one, so that fetch legitimately
  // 404s -- and the load kept the previous value on failure, which was Live's log if
  // Live had been opened first. "No log of its own yet" was being rendered as
  // "show the other portfolio's".
  assert.match(app, /state\.liveExecutionByMode\[executionMode\] = executionResult\.value;/);
  assert.match(app, /\} else if \(!\(executionMode in state\.liveExecutionByMode\)\) \{\n\s*\/\/[^\n]*\n\s*state\.liveExecutionByMode\[executionMode\] = null;/,
    "a missing log must resolve to nothing, never to another portfolio's");
  assert.match(app, /state\.liveExecutionState = state\.liveExecutionByMode\[executionMode\] \|\| null;/);
  assert.ok(!/executionResult\.status === "fulfilled" \? executionResult\.value : state\.liveExecutionState/.test(app),
    "the failure branch must not fall back to whatever was loaded last");

  // And the pre-load render must switch the log with the tab, or the other
  // portfolio's history shows for as long as the fetch takes.
  assert.match(app, /state\.liveExecutionState = state\.liveExecutionByMode\[normalizeMode\(mode\)\] \|\| null;\n\s*if \(state\.liveState\) renderLiveState/);

  // Each portfolio reads its own file.
  assert.match(app, /isFixedEntryMode\(mode\) \? "data\/live-5050-execution-state\.json" : "data\/live-execution-state\.json"/);
  assert.match(app, /fetchJson\(liveExecutionStateFile\(options\.requestedMode \|\| state\.mode\)\)/);
});

test("5050: its own button and its own schedule run its own algorithm", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8");

  // Reported: pressing Run once on the 5050 dashboard started the main live
  // portfolio. 5050 is a live mode, so the target resolved to "live" -- a different
  // algorithm, against real money.
  assert.match(app, /function currentExecutionTarget\(\) \{\n\s*if \(isFixedEntryMode\(\)\) return "live-5050";/);
  assert.match(app, /if \(button\.dataset\.oneTimeExecution === "current"\) return currentExecutionTarget\(\);/);
  assert.match(api, /'live-5050' => \[\n\s*'workflow' => 'trading-live-5050\.yml',/);

  // The result watcher must read the portfolio's own execution state, or it would
  // report another portfolio's run as this one's outcome.
  assert.match(app, /target === "live-5050" \? "live-5050-execution"/);

  // The auto trigger: a schedule exists, and the run is gated by the portfolio's own
  // switch and cadence rather than firing regardless.
  assert.match(workflow, /schedule:\s*\n(?:\s*#[^\n]*\n)*\s*- cron: '7,37 \* \* \* \*'/);
  // This asserted a hard-coded MANUAL for every dispatch, which was right while the cron
  // was the only automatic trigger. The scan now dispatches this workflow as well, for a
  // portfolio set to execute after each scrape, and that run is not a person's -- so the
  // source is an input the dispatcher sets, still defaulting to MANUAL so that pressing
  // the dashboard button means what it always did.
  assert.match(
    workflow,
    /LIVE_RUN_SOURCE: \$\{\{ github\.event_name == 'workflow_dispatch' && \(inputs\.live_run_source \|\| 'MANUAL'\) \|\| 'AUTO' \}\}/,
    "a hard-coded MANUAL would bypass both the switch and the cadence",
  );
  assert.match(workflow, /"LIVE_EXECUTION_CRON_MINUTES": cfg\.get\("executionCronMinutes"\)/);
  // The switch moved for the same reason: applied only to scheduled events, it would now
  // leave a dispatched after-scrape run trading while automation is off. It is written as
  // saved whatever the event, and the executor is what exempts a manual run from it.
  assert.match(workflow, /"LIVE_AUTOMATION_ENABLED": str\(bool\(cfg\.get\("automationEnabled", True\)\)\)\.lower\(\)/);

  // A scheduled run must place orders; only an unconfirmed dispatch is a dry run.
  assert.match(workflow, /POLYMARKET_DRY_RUN: \$\{\{ \(github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.live_confirm\)\) && 'false' \|\| 'true' \}\}/);

  // The algorithm runs over the whole candidate set, not a browser shortlist.
  assert.match(workflow, /LIVE_CANDIDATE_SCAN_LIMIT: "300"/);
  assert.ok(!/live_execution_candidate_token_ids/.test(workflow));
});

test("5050: the candidate list is judged by its own rule, not market-price economics", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // 5050 does not buy at the market, it rests a bid at a fixed price. Judging its
  // shortlist on market-price yield asks the wrong question: a candidate trading at
  // 95c has a poor return if bought there and an excellent one if filled at 50c, so
  // the generic economics filter was hiding exactly the candidates it bids on -- and
  // the visible list disagreed with what the run would do.
  const branch = /if \(isFixedEntryMode\(mode\)\) \{[\s\S]*?return reasons;\n  \}/.exec(app)[0];
  const run = new Function("item", "config", "mode", "deps", `
    const {isFixedEntryMode,normalizeFixedEntryPrice,probability,money,compactDays,
      normalizeMarketTagList,marketMatchesAllowedTags}=deps;
    const reasons=[];
    const liquidity=Number(item.volumeUsdc||0), minLiquidity=Number(config.minLiquidityUsdc);
    const days=Number(item.daysToResolution), maxDays=Number(config.maxResolutionDays);
    ${branch}
    return reasons;`);
  const deps = {
    isFixedEntryMode: () => true,
    normalizeFixedEntryPrice: (v) => v ?? 0.5,
    probability: (v) => `${(v * 100).toFixed(1)}%`,
    money: (v) => `$${Number(v).toFixed(0)}`,
    compactDays: (d) => `${d} d`,
    // The tag restriction is covered by its own test; here it must not interfere.
    normalizeMarketTagList: (value) => (Array.isArray(value) ? value : []),
    marketMatchesAllowedTags: () => true,
  };
  const config = { fixedEntryPrice: 0.5, minLiquidityUsdc: 100, maxResolutionDays: 30 };
  const reasons = (item) => run(item, config, "live-5050", deps);

  // The case the old filter wrongly hid: expensive now, which is the whole point.
  assert.deepEqual(reasons({ bestAsk: 0.95, volumeUsdc: 60000, daysToResolution: 0.4 }), []);

  // Resting below the market is the strategy, so at or under the entry price there is
  // nothing to buy -- the same reason the executor gives.
  assert.match(reasons({ bestAsk: 0.5, volumeUsdc: 60000, daysToResolution: 0.4 })[0], /at or below the 50\.0% entry price/);
  assert.match(reasons({ bestAsk: 0.3, volumeUsdc: 60000, daysToResolution: 0.4 })[0], /at or below/);

  // The portfolio's own volume floor and horizon still apply.
  assert.match(reasons({ bestAsk: 0.95, volumeUsdc: 50, daysToResolution: 0.4 })[0], /volume/);
  assert.match(reasons({ bestAsk: 0.95, volumeUsdc: 60000, daysToResolution: -1 })[0], /end date is in the past/);
  assert.match(reasons({ bestAsk: 0.95, volumeUsdc: 60000, daysToResolution: 45 })[0], /beyond 30 days/);

  // It must return before the market-price economics, or those would re-reject it.
  const after = app.slice(app.indexOf(branch) + branch.length);
  assert.match(after.slice(0, 200), /if \(!Number\.isFinite\(annualizedReturn\)\)/,
    "the fixed-entry branch has to short-circuit the generic yield checks");
});

test("5050: the progress log describes the run that actually happens", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: pressing Run 5050 once looked like it started the live portfolio. The
  // right workflow was dispatched, but every line of the progress log said "Live
  // execution" and one of them claimed "34 candidates from the refreshed list on
  // screen were sent for live verification" -- which never happened: the 5050
  // workflow has no shortlist input and the API forwards none, so the run scans for
  // candidates itself. The log described a different run from the one taking place.
  assert.match(app, /target === "live-5050" \? "5050 execution requested"/);
  assert.match(app, /target === "live-5050" \? "5050 execution confirmed"/);
  assert.match(app, /target === "live-5050" \? "starting 5050 workflow"/);

  // The shortlist is built and announced only for the portfolio that sends one.
  assert.match(app, /const sendsShortlist = target === "live";/);
  assert.match(app, /const workflowPayload = sendsShortlist \? await freshLiveWorkflowPayload\(\) : null;/);
  assert.match(app, /if \(sendsShortlist\) \{\n\s*\/\/ Name the shortlist that was actually submitted/);

  // And 5050 says what it will really do, naming its own entry price.
  assert.match(app, /"Running the 5050 algorithm"/);
  assert.match(app, /scans for them itself rather than taking the list on screen/);
});

test("5050: candidates on an event already working are risk-blocked", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported twice: every candidate stayed READY however many bids were resting.
  //
  // The rule was never wrong -- it was fed an empty set. The exposure passed to it
  // came from activeExposureRowsForMode, which filters the wallet down to what this
  // portfolio placed, and that attribution is derived from 5050's run log. The log
  // does not exist until its first run publishes one, so 5050 saw no exposure at all
  // and blocked nothing. Checking the token alone was also too narrow: one bid per
  // event means the other sub-markets of that event are different tokens and collide
  // only on the event key.
  assert.match(app, /const activeRows = isFixedEntryMode\(mode\)\n\s*\? \[\n\s*\.\.\.\(Array\.isArray\(state\.liveState\?\.positions\)/,
    "5050 must see the whole wallet, not its attributed subset");
  assert.ok(!/walletTokenIds/.test(app), "the narrower token-only check is superseded");

  const pick = (re) => re.exec(app)[0];
  const body = [
    "const inferredRiskKeysForRow = () => [];",
    pick(/function riskKeysForRow\([\s\S]*?\n\}/),
    pick(/function candidateRiskBlockReason\([\s\S]*?\n\}/),
  ].join("\n");
  const reason = new Function("item", "activeRows", `${body}
    return candidateRiskBlockReason(item, activeRows, new Map());`);
  const wallet = [{ tokenId: "A1", riskGroupKeys: ["event:matchA", "match:a"] }];

  assert.match(reason({ tokenId: "A1", riskGroupKeys: ["event:matchA"] }, wallet), /duplicate token already open/);
  assert.match(reason({ tokenId: "A2", riskGroupKeys: ["event:matchA", "match:a"] }, wallet),
    /same event or match already open/, "a sibling sub-market must block on the event key");
  assert.equal(reason({ tokenId: "B1", riskGroupKeys: ["event:matchB"] }, wallet), "",
    "an unrelated event stays biddable");

  // The failure being fixed: an empty exposure set makes everything look ready.
  assert.equal(reason({ tokenId: "A2", riskGroupKeys: ["event:matchA"] }, []), "");
});

test("5050: its own resting orders appear on its tab straight away", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: orders placed by 5050 did not show in its Opened trades. Attribution
  // read only 5050's run log, and that log is written at the END of a run -- after
  // the orders are already resting on the book. So its own orders were invisible on
  // its own tab, and counted as Live's, for the whole window in between.
  //
  // The price is a second, independent signal: 5050 rests every bid at exactly its
  // configured entry price, far from the market by construction.
  const pick = (re) => re.exec(app)[0];
  const body = [
    pick(/function fixedEntryPriceSignatures\([\s\S]*?\n\}/),
    pick(/function matchesFixedEntryPrice\([\s\S]*?\n\}/),
    pick(/function restsAtFixedEntryPrice\([\s\S]*?\n\}/),
    // Attribution now separates a filled row from a resting one. These orders are
    // unfilled, so they still go through the price and run-log signals this pins.
    pick(/function isFilledPortfolioRow\([\s\S]*?\n\}/),
    pick(/function boughtAtFixedEntryPrice\([\s\S]*?\n\}/),
    pick(/function isClosedTrade\([\s\S]*?\n\}/),
    pick(/function belongsToActiveLivePortfolio\([\s\S]*?\n\}/),
  ].join("\n");
  const belongs = (fixed, owned) => new Function("row", `
    const isFixedEntryMode=()=>${fixed};
    const normalizeFixedEntryPrice=(v)=>v??0.5;
    const portfolioConfigForMode=()=>({fixedEntryPrice:0.51});
    // No published run log in this case -- the point is that a bid is recognised before
    // one exists, from the configured price alone.
    const state={live5050ExecutionState:null};
    const fixedEntryTokenIds=()=>new Set(${JSON.stringify(owned)});
    ${/const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0]}
    ${body}
    return belongsToActiveLivePortfolio(row);`);

  const notYetLogged = { tokenId: "T1", price: 0.51 };
  const logged = { tokenId: "T2", price: 0.51 };
  const liveOrder = { tokenId: "T3", price: 0.96 };

  // The case that was broken: on the book, not yet in the log.
  assert.equal(belongs(true, ["T2"])(notYetLogged), true);
  assert.equal(belongs(false, ["T2"])(notYetLogged), false, "and it must not count as Live's");
  assert.equal(belongs(true, ["T2"])(logged), true);
  // Live's orders rest near the market and stay Live's.
  assert.equal(belongs(true, ["T2"])(liveOrder), false);
  assert.equal(belongs(false, ["T2"])(liveOrder), true);

  // Every row lands on exactly one tab -- attribution must not hide or duplicate.
  for (const row of [notYetLogged, logged, liveOrder]) {
    assert.equal(belongs(true, ["T2"])(row) === belongs(false, ["T2"])(row), false,
      `${row.tokenId} must belong to exactly one live portfolio`);
  }

  // Tick rounding must not lose a bid by a hundredth.
  assert.equal(belongs(true, [])({ tokenId: "T4", price: 0.5099 }), true);
});

test("market scan: a manual scan finishes on the server, whatever the tab does", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: a manual scan sometimes ends in an error, or seems to break when the
  // page is left. The scan itself runs on the runner and finishes regardless -- only
  // the waiting happens in the browser, and the waiting had three faults.
  const wait = app.slice(app.indexOf("async function waitForScrapedScanWorkflow"));
  const body = wait.slice(0, wait.indexOf("\n}"));

  // 1. It gave up after 64 polls 3s apart -- about three minutes, shorter than a
  //    large scan -- and the caller turned that into an error.
  assert.match(body, /budgetMs = 25 \* 60 \* 1000/);
  assert.match(body, /while \(Date\.now\(\) < deadline\)/,
    "the budget must be wall-clock, not a poll count, or a throttled tab spends it on no real time");
  assert.ok(!/attempt < 64/.test(body));

  // 2. One failed status check threw out of the loop and reported an error for a
  //    scan that was running fine.
  assert.match(body, /\} catch \{/);
  assert.match(body, /consecutiveFailures \+= 1;/);
  assert.match(body, /still waiting/);

  // 3. A hidden tab throttles timers to about one per minute, so a poll scheduled
  //    before the switch idles long past the work finishing.
  assert.match(body, /await sleepUntilVisible\(/);
  assert.match(app, /function sleepUntilVisible\(ms\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", onVisible\);/);
  assert.match(app, /if \(document\.visibilityState === "visible"\) finish\(\);/);
  // The listener must be removed, or every wait leaks one.
  assert.match(app, /document\.removeEventListener\("visibilitychange", onVisible\);/);

  // Running is not failing: the caller waits for publication instead of erroring.
  assert.match(app, /Scan is still running on the server; its results will appear when it publishes\./);
  assert.ok(!/throw new Error\("Scan is still queued in the background/.test(app));
});

test("live portfolios: each sizes from its own commitments, not the shared wallet's", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Superseded by a later report and an explicit decision. Free cash was the shared
  // balance minus EVERY resting buy, because one wallet backs both portfolios and the
  // exchange really does reserve for all of them. In practice 5050 rests many bids at
  // once, which left the Live portfolio reading zero free cash and skipping every
  // candidate while the account was otherwise idle. Each portfolio is now shown, and
  // sizes from, what its own commitments leave -- and the exchange, not the dashboard,
  // decides whether a submission fits. That refusal is already handled and counted.
  assert.match(app, /const ownOrderReservation = reservedByOrders\(openOrderRows\);/);
  assert.match(app, /const freeCash = Number\.isFinite\(cash\) \? Math\.max\(0, cash - ownOrderReservation\) : null;/);
  // The wallet total is still computed, so the tile can say how much of the balance the
  // other portfolio has spoken for rather than quietly overstating what is spendable.
  assert.match(app, /const walletOrderRisk = reservedByOrders\(Array\.isArray\(liveState\?\.openOrders\)/);
  assert.match(app, /const otherPortfolioReservation = Math\.max\(0, walletOrderRisk - ownOrderReservation\);/);
  assert.match(app, /locked by the other portfolio/);

  // Unchanged: risk is what THIS portfolio has committed, and the wallet-wide position
  // total must not stand in for it.
  assert.match(app, /const ownPositionRisk = positions\.reduce\(/);
  assert.match(app, /els\.portfolioRisk\.textContent = money\(ownPositionRisk \+ openOrderRisk\);/);
  assert.ok(!/portfolio\.openRiskUsdc \|\| 0\) \+ openOrderRisk/.test(app),
    "the wallet-wide position total must not stand in for a portfolio's own");
  // A resting sell releases collateral rather than reserving it.
  assert.match(app, /\.filter\(\(order\) => !String\(order\.side \|\| ""\)\.toUpperCase\(\)\.includes\("SELL"\)\)/);
  // A cancelled or filled order still in the snapshot reserves no collateral.
  assert.match(app, /TERMINAL_ORDER_STATUSES\.has\(String\(order\.rawStatus \|\| order\.status \|\| ""\)\.toUpperCase\(\)\)/);
  // Orders carry notionalUsdc from the sync; the others are fallbacks.
  assert.match(app, /Number\(order\.notionalUsdc \?\? order\.totalCostUsdc \?\? order\.stakeUsdc\)/);

  // The arithmetic, on one wallet holding both portfolios' orders.
  const cash = 20;
  const live = [{ side: "BUY", notionalUsdc: 3 }];
  const other = [{ side: "BUY", notionalUsdc: 2.55 }, { side: "BUY", notionalUsdc: 2.55 }];
  const sell = [{ side: "SELL", notionalUsdc: 9 }];
  const reserved = (rows) => rows
    .filter((order) => !order.side.includes("SELL"))
    .reduce((sum, order) => sum + order.notionalUsdc, 0);
  const own = reserved(live);
  const wallet = reserved([...live, ...other, ...sell]);
  assert.equal(own, 3);
  assert.equal(wallet, 8.1);
  // What the Live tab shows now, and what it has to disclose alongside it.
  assert.equal(Math.max(0, cash - own).toFixed(2), "17.00");
  assert.equal(Math.max(0, wallet - own).toFixed(2), "5.10");
});

test("run log: history survives a reload and a failed fetch", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Reported: the run log empties itself -- "No Live trading decision runs recorded
  // yet" on a list that had entries. The per-portfolio execution state was cached in
  // memory only, so every reload began with nothing and the log read empty until the
  // fetch landed; if that fetch failed, it stayed empty for the whole session.
  // History that disappears on a refresh is worse than history a minute stale.
  const pick = (re) => re.exec(app)[0];
  const body = [
    pick(/function cachedLiveExecutionByMode\(\)[\s\S]*?\n\}/),
    pick(/function rememberLiveExecutionState\(mode, value\)[\s\S]*?\n\}/),
  ].join("\n");
  const store = new Map();
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const api = new Function("localStorage", `const LIVE_EXECUTION_CACHE_KEY="k";
    ${body}
    return {cachedLiveExecutionByMode, rememberLiveExecutionState};`)(localStorage);

  assert.deepEqual(api.cachedLiveExecutionByMode(), {}, "a first visit has no history to show");
  api.rememberLiveExecutionState("live", { generatedAt: "t1", action: "SUBMITTED", runLog: [{ id: "r1" }, { id: "r2" }] });
  api.rememberLiveExecutionState("live-5050", { generatedAt: "t2", action: "SKIP", runLog: [{ id: "f1" }] });

  // Each portfolio keeps its own, so a reload cannot show one portfolio's log
  // under the other.
  const reloaded = api.cachedLiveExecutionByMode();
  assert.equal(reloaded.live.runLog.length, 2);
  assert.equal(reloaded["live-5050"].runLog.length, 1);
  assert.equal(reloaded.live.action, "SUBMITTED");

  // The failure that was blanking it.
  api.rememberLiveExecutionState("live", null);
  assert.equal(api.cachedLiveExecutionByMode().live.runLog.length, 2, "a failed fetch must not wipe the log");

  // A full or unavailable store must never break a render.
  assert.doesNotThrow(() => api.rememberLiveExecutionState("live", { runLog: [], get generatedAt() { throw new Error("boom"); } }));

  // The cache is seeded before the first render, not only after a load.
  assert.match(app, /state\.liveExecutionByMode = state\.liveExecutionByMode \|\| cachedLiveExecutionByMode\(\);\n\s*state\.liveExecutionState = state\.liveExecutionByMode\[normalizeMode\(mode\)\] \|\| null;/);
  assert.match(app, /rememberLiveExecutionState\(executionMode, executionResult\.value\);/);
  // Bounded, so a large batch cannot overflow the quota and lose everything.
  assert.match(app, /runLog: Array\.isArray\(value\.runLog\) \? value\.runLog\.slice\(0, 60\) : \[\]/);
});

test("rules card: automation is the badge, not a row", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The ON/OFF badge sits in the card header and is clickable, so repeating the same
  // state as a read-only row below it said the same thing twice -- and the row could
  // not be acted on.
  assert.ok(!/\["Automatic execution", automationIsEnabled/.test(app));
  assert.match(app, /function automationBadgeMarkup\(\)/, "the badge stays the single place it is shown");
  assert.match(app, /\$\{automationBadgeMarkup\(\)\}/);
});

test("scraped counts: the UI reports the archive, not the page it was served", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // Nothing is discarded on disk now, but one response still cannot carry the whole
  // archive: measured on a 5000-row active catalogue, this summary peaks near 111 MB
  // at 8000 resolved rows and a 128 MB host answers 500 first. So the list is a page
  // and the count is the total -- otherwise the labels shrink as the archive grows,
  // which reads as records disappearing.
  assert.match(api, /\$resolvedServeLimit = 3000;/);
  assert.match(api, /'observationTotals' => state_observation_totals\(\$data\)/,
    "the true totals must be served alongside the page");
  assert.match(api, /'resolvedTruncated' => \$resolvedTruncated/);

  // And the browser must prefer the reported total over what it received.
  assert.match(app, /const totals = state\.scrapedObservationTotals;/);
  assert.match(app, /if \(totals && Number\.isFinite\(Number\(totals\.resolved\)\) && Number\(totals\.resolved\) > counts\.resolved\)/);
  assert.match(app, /counts\.resolved = Number\(totals\.resolved\);/);
});

// A manual scan of the `clf` tag on 2026-08-08 exited 0, published nothing and left no log.
// The tag picker is built from tags observed on stored markets, which is a far wider set
// than MARKET_SCAN_CATEGORY_TAGS, so the scan threw "unknown Polymarket scan tag" before
// the try that records a run -- and the caller swallowed it. These tests pin both halves:
// an unknown slug is now looked up rather than rejected, and a scan that fails anyway
// still leaves a row behind.
// The tag is read at import time and the trigger at call time, so the environment has to
// stay applied for the whole test, not just for the import. The query suffix gives each
// case its own module instance.
async function scopedBot(suffix, env = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    return { bot: await import(`../tools/paper-trading-bot.mjs?${suffix}`), restore };
  } catch (error) {
    restore();
    throw error;
  }
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const result = handler(url);
    if (!result) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => result };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("market scan: a tag outside the catalogue is resolved instead of aborting the scan", async () => {
  const { bot: scoped, restore } = await scopedBot("scan-tag-resolve", {
    PAPER_MARKET_SCAN_TAG: "clf",
    PAPER_MARKET_SCAN_TRIGGER: "MANUAL",
    PAPER_MARKET_SCAN_LIVE: "false",
  });
  const stub = stubFetch((url) => {
    if (url.includes("/tags/slug/clf")) return { id: 102345, slug: "clf", label: "CLF" };
    if (url.includes("events/keyset")) return { events: [], next_cursor: "" };
    return null;
  });
  try {
    const state = { marketObservations: [], marketScanHistory: [], evaluations: [] };
    await scoped.refreshMarketObservations(state);

    const run = state.marketScanHistory[0];
    assert.equal(run.status, "SUCCESS", `expected a completed scan, got ${run.status}: ${run.error}`);
    assert.equal(run.trigger, "MANUAL", "the manual flag the user was looking for");
    assert.equal(run.scanTag, "clf");

    // The scan needs Gamma's numeric id; the slug alone cannot be queried.
    const eventsCall = stub.calls.find((url) => url.includes("events/keyset"));
    assert.ok(eventsCall, "the resolved tag must actually be scanned");
    assert.match(eventsCall, /tag_id=102345/);

    // And the id is kept, so the next scan of this tag costs no extra request.
    assert.equal(state.marketScan.resolvedTagIds.clf, "102345");
    assert.equal(scoped.normalizeMarketScan(state.marketScan).resolvedTagIds.clf, "102345",
      "the whitelist must carry it into the published state");
  } finally {
    stub.restore();
    restore();
  }
});

test("market scan: a cached tag id is reused without a second lookup", async () => {
  const { bot: scoped, restore } = await scopedBot("scan-tag-cache", {
    PAPER_MARKET_SCAN_TAG: "clf",
    PAPER_MARKET_SCAN_LIVE: "false",
  });
  const stub = stubFetch((url) => (url.includes("events/keyset") ? { events: [], next_cursor: "" } : null));
  try {
    const state = {
      marketObservations: [],
      marketScanHistory: [],
      evaluations: [],
      marketScan: { resolvedTagIds: { clf: "102345" } },
    };
    await scoped.refreshMarketObservations(state);
    assert.equal(state.marketScanHistory[0].status, "SUCCESS");
    assert.ok(!stub.calls.some((url) => url.includes("/tags")), "a cached id must not be looked up again");
    assert.match(stub.calls.find((url) => url.includes("events/keyset")), /tag_id=102345/);
  } finally {
    stub.restore();
    restore();
  }
});

test("market scan: a scan that cannot run still records a run with its trigger and reason", async () => {
  const { bot: scoped, restore } = await scopedBot("scan-tag-missing", {
    PAPER_MARKET_SCAN_TAG: "clf",
    PAPER_MARKET_SCAN_TRIGGER: "MANUAL",
    PAPER_MARKET_SCAN_LIVE: "false",
  });
  // Gamma knows no such tag: every lookup route 404s.
  const stub = stubFetch(() => null);
  try {
    const state = { marketObservations: [], marketScanHistory: [], evaluations: [] };
    const observations = await scoped.refreshMarketObservations(state);
    assert.deepEqual(observations, [], "a failed scan returns nothing rather than throwing past the caller");

    const run = state.marketScanHistory[0];
    assert.ok(run, "the run the user went looking for and could not find");
    assert.equal(run.status, "ERROR");
    assert.equal(run.trigger, "MANUAL");
    assert.equal(run.scanTag, "clf");
    assert.equal(run.scanScope, "Category: clf", "the attempt is named even though no scope was chosen");
    assert.ok(String(run.error || "").length > 0, "the row has to carry the reason");
    assert.equal(state.marketScan.lastScanError, run.error);
  } finally {
    stub.restore();
    restore();
  }
});

test("market scan: a failed scan is published, then fails the workflow", async () => {
  const { readFile } = await import("node:fs/promises");
  const [source, workflow, app] = await Promise.all([
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8"),
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
  ]);

  // The history row is written whatever happened, so a failed scan is still listed.
  assert.match(source, /scanFailure = String\(normalizeMarketScan\(state\.marketScan\)\.lastScanError \|\| ""\);/);
  assert.match(source, /if \(scanFailure\) await writeScanErrorMarker\(scanFailure\);/);
  // And the summary must not claim success over a scan that fetched nothing.
  assert.match(source, /action: scanFailure \? "MARKET_SCAN_FAILED" : "MARKET_SCAN"/);

  // Publish first, fail second, dispatch downstream work only if the scan actually ran.
  const order = ["Upload paper state", "Append compact scraping history entry",
    "Fail when the scan did not complete", "Dispatch post-scrape execution"]
    .map((name) => workflow.indexOf(`- name: ${name}`));
  assert.ok(order.every((index) => index > 0), "every step must be present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, `steps are out of order: ${order}`);
  assert.match(workflow, /PAPER_SCAN_ERROR_PATH: data\/market-scan-error\.txt/);
  assert.match(workflow, /if \[ -s trading\/data\/market-scan-error\.txt \]; then/);

  // The dashboard names the cause instead of only reporting that the workflow failed.
  assert.match(app, /const reason = await publishedScanFailureReason\(baseline\);/);
  assert.match(app, /return `\$\{label\}: scan failed - \$\{runError \|\| "no markets were scanned"\}`;/);
});

// Reported: the execution candidates list did not show every candidate. It rendered a
// fixed first 80 rows and said nothing about the rest, so a portfolio with more than
// that simply hid them. The list now pages through the whole set.
function candidateRenderer(state) {
  const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
  const pick = (name) => {
    let start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = [pick("candidateVisibleCount"), pick("renderPortfolioCandidateRows")].join("\n\n");
  const pageSize = Number(/const CANDIDATE_PAGE_SIZE = (\d+);/.exec(app)[1]);
  const stub = () => "";
  const deps = {
    state,
    CANDIDATE_PAGE_SIZE: pageSize,
    normalizeMode: (mode) => mode,
    portfolioConfigForMode: () => ({ probabilitySource: "polymarket" }),
    normalizeProbabilitySource: (value) => value,
    LIVE_MODES: new Set(["live", "live-5050"]),
    portfolioReturnMetricLabel: () => "p.a.",
    escapeHtml: (value) => String(value ?? ""),
    formatInteger: (value) => String(value),
  };
  // Cell formatting is not what is under test, so whatever the renderer reaches for
  // next gets a neutral stub.
  const compile = () => {
    const names = Object.keys(deps);
    return new Function(...names, `${body}\nreturn { renderPortfolioCandidateRows, candidateVisibleCount };`)(
      ...names.map((name) => deps[name]),
    );
  };
  let api = compile();
  return {
    pageSize,
    candidateVisibleCount: (mode) => api.candidateVisibleCount(mode),
    render(rows, mode, diagnostics) {
      for (let guard = 0; guard < 80; guard += 1) {
        try {
          return api.renderPortfolioCandidateRows(rows, mode, diagnostics);
        } catch (error) {
          const missing = /(\w+) is not defined/.exec(error.message);
          if (!missing) throw error;
          deps[missing[1]] = stub;
          api = compile();
        }
      }
      throw new Error("renderer could not be satisfied");
    },
  };
}

test("execution candidates: every candidate is reachable, a page at a time", () => {
  const state = { mode: "live-5050", candidateVisibleCount: 0, candidateVisibleMode: "", candidateTotalCount: 0 };
  const renderer = candidateRenderer(state);
  const size = renderer.pageSize;
  const total = size * 3 + 10;
  const rows = Array.from({ length: total }, (_, index) => ({ tokenId: String(index), question: `Market ${index}` }));
  const diagnostics = { ready: rows, riskBlocked: [], manuallyExcluded: [], filteredReasonCounts: new Map() };
  const countRows = (html) => (html.match(/<tr\b/g) || []).length - 1;

  const first = renderer.render(rows, "live-5050", diagnostics);
  assert.equal(countRows(first), size, "the first page is one screenful");
  assert.match(first, /data-candidates-load-more/, "and it must say the rest exists");
  assert.match(first, new RegExp(`${total - size} of ${total} still hidden`),
    "the control has to name how many are not on screen");

  // Scrolling (or the button) raises the count; the renderer must follow it all the way.
  state.candidateVisibleCount = size * 2;
  assert.equal(countRows(renderer.render(rows, "live-5050", diagnostics)), size * 2);

  state.candidateVisibleCount = total;
  const last = renderer.render(rows, "live-5050", diagnostics);
  assert.equal(countRows(last), total, "with the count at the total, every candidate renders");
  assert.ok(!/data-candidates-load-more/.test(last), "and nothing claims there is more");

  // Past the end is not an error, and still shows exactly the whole set.
  state.candidateVisibleCount = total + size;
  assert.equal(countRows(renderer.render(rows, "live-5050", diagnostics)), total);

  // A different portfolio starts again at one page rather than inheriting the scroll.
  assert.equal(renderer.candidateVisibleCount("live"), size);
  assert.equal(state.candidateVisibleMode, "live");
});

test("execution candidates: the list extends itself on scroll and by button", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Endless scrolling, as asked for -- plus the button, because a scroll listener is
  // no use to anyone driving the table from the keyboard.
  assert.match(app, /els\.portfolioCandidates\?\.addEventListener\("click", \(event\) => \{\n  if \(!event\.target\.closest\("\[data-candidates-load-more\]"\)\) return;/);
  // `scroll` does not bubble, so a panel-level listener has to capture.
  assert.match(app, /els\.portfolioCandidates\?\.addEventListener\("scroll", \(event\) => \{[\s\S]*?\}, true\);/);
  assert.match(app, /showMoreCandidates\(\);/);
  // Re-rendering replaces the table, so the position has to survive the extension or
  // the list snaps back to the top and the end can never be reached.
  assert.match(app, /const offset = scroller \? scroller\.scrollTop : 0;/);
  assert.match(app, /if \(nextScroller\) nextScroller\.scrollTop = offset;/);
  // The summary must not imply the totals are all on screen.
  assert.match(app, /const paged = shown < total \? ` - showing \$\{formatInteger\(shown\)\} of \$\{formatInteger\(total\)\}` : "";/);
});

// Reported with a screenshot: the newest 5050 run was still listed twice, the first of
// the pair labelled "Live", and the newest runs were missing. The earlier fix matched the
// two rows by batchLog id -- but the device cache keeps a reduced copy of the state, and
// the first paint after a reload renders from it. That copy carried no batchLog, so the
// top-level row was rebuilt as a run of its own with a synthesized id and a hard-coded
// Live label, and the pair no longer matched.
function runLogRenderer(app, executionState, { fixedEntry = true } = {}) {
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["normalizeLiveExecutionRun", "isSameLiveRun", "mergeUniqueByRun",
    "isCadenceWaitRun", "isHistoryRecoveryRun", "liveRunLogRows"].map(pick).join("\n\n");
  return new Function("state", "isFixedEntryMode", "liveBatchCandidateSummaryFromExecution", "portfolioReturnMetricLabel",
    `${body}\nreturn liveRunLogRows;`)(
    { liveState: null, liveExecutionState: executionState },
    () => fixedEntry,
    (item) => item,
    () => "",
  )();
}

test("5050 run log: one row per run whatever shape the state was stored in", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const generatedAt = "2026-08-08T13:09:11.000Z";
  const batchLog = {
    action: "SKIP",
    reason: "fixed-entry batch rested 0 of 1 bids at 0.51",
    strategyId: "live-5050",
    strategyLabel: "5050",
    runAt: generatedAt,
    counts: {},
  };
  const newest = { ...batchLog, id: `live-trade-batch-${generatedAt}`, generatedAt };
  const older = {
    id: "live-trade-batch-2026-08-08T11:55:40.000Z",
    runAt: "2026-08-08T11:55:40.000Z",
    strategyId: "live-5050",
    action: "SUBMITTED",
    reason: "older run",
  };
  const runLog = [newest, older];

  const shapes = {
    // Straight from the published state.
    fresh: { generatedAt, action: batchLog.action, reason: batchLog.reason, batchLog, runLog },
    // What the device cache used to hold: no batchLog at all. This is the screenshot.
    legacyCache: { generatedAt, action: batchLog.action, reason: batchLog.reason, runLog },
    // And with a batchLog whose clock read drifted from generatedAt by a few ms, which
    // is how the executor used to stamp them.
    driftedClock: {
      generatedAt,
      action: batchLog.action,
      reason: batchLog.reason,
      batchLog: { ...batchLog, id: null, runAt: "2026-08-08T13:09:11.004Z" },
      runLog,
    },
  };

  for (const [label, executionState] of Object.entries(shapes)) {
    const rows = runLogRenderer(app, executionState);
    assert.equal(rows.length, 2, `${label}: expected one row per run, got ${rows.map((row) => row.action).join(", ")}`);
    assert.equal(rows[1].id, older.id, `${label}: the older run must be untouched`);
    assert.ok(!/^Live$/.test(String(rows[0].strategyLabel || "")),
      `${label}: a 5050 run must not be labelled as the Live portfolio`);
  }
});

test("5050 run log: the cache keeps enough to identify the run it stored", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // A cache that drops the identity is what forced the row to be rebuilt as a new run.
  assert.match(app, /batchLog: value\.batchLog\n\s+\? \{\n\s+id: value\.batchLog\.id \|\| null,/);
  assert.match(app, /strategyId: value\.batchLog\.strategyId \|\| null,/);
  // Unequal ids must not be read as proof of different runs, because one of them may be
  // synthesized here rather than by the executor.
  assert.match(app, /if \(leftId && rightId && leftId === rightId\) return true;/);
  // And the title must name the portfolio whose log it is.
  assert.match(app, /const label = isFixedEntryMode\(\) \? "5050" : \(isLiveMode\(\) \? "Live" : paperModeLabel\(\)\);/);

  // The browser caches the script URL, so a dashboard fix that does not bump this is
  // published and never served -- which is why the earlier fix appeared not to work.
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const version = /assets\/app\.js\?v=([^"]+)/.exec(html);
  assert.ok(version, "app.js must stay cache-busted");
  assert.notEqual(version[1], "20260804-resolved-scraped", "the version has to move when app.js does");
});

test("days left: a market past its end date reads as overdue, and p.a. is untouched", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const pick = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    const bodyStart = src.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (!depth) return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const minDays = 1 / 24;
  const api = new Function("MIN_ANNUALIZATION_DAYS", `
    ${pick(app, "compactDays")}
    ${pick(app, "daysUntil")}
    ${pick(app, "annualizationDays")}
    ${pick(app, "annualizeReturn")}
    return { compactDays, daysUntil, annualizeReturn };
  `)(minDays);
  const at = (days) => new Date(Date.now() + days * 86400000).toISOString();

  // Reported: "1.0 day left" on a market whose date had passed. Negative is wanted.
  assert.match(api.compactDays(api.daysUntil(at(-2.3))), /^-2\.3 d$/);
  assert.match(api.compactDays(api.daysUntil(at(-0.5))), /^-12\.0 h$/);
  assert.match(api.compactDays(api.daysUntil(at(-0.02))), /^-\d+ min$/);
  // Future horizons are unchanged.
  assert.match(api.compactDays(api.daysUntil(at(5))), /^5\.0 d$/);
  assert.match(api.compactDays(api.daysUntil(at(0.5))), /^12\.0 h$/);
  assert.equal(api.compactDays(api.daysUntil("not a date")), "-");

  // The executor stored a one-day floor as the row's days-left, which is what produced
  // "1.0 day". It is gone; the annualization floor that guards the maths is not.
  assert.ok(!/return Math\.max\(1, \(end - Date\.now\(\)\) \/ 86400000\);/.test(executor),
    "the display floor must be gone");
  assert.match(executor, /return Math\.max\(MIN_ANNUALIZATION_DAYS, days\);/,
    "the annualization floor must stay");

  // Asked for explicitly: leave the potential p.a. as it is. A signed horizon must not
  // move it, because every annualization already floors a non-positive one.
  for (const days of [-40, -2.3, -0.5, 0]) {
    const signed = api.daysUntil(at(days));
    assert.equal(api.annualizeReturn(0.1, signed), api.annualizeReturn(0.1, Math.max(0, signed)),
      `p.a. must be unchanged at ${days} days`);
  }
});

// Asked to check that the Live portfolio's closed trades show up. They do render -- the
// account snapshot carries 28 of them and nothing trims the list -- but attribution had a
// hole that could take them away. A row that FILLED was claimed the same way a resting
// order is: by token. Both live portfolios draw from one candidate pool and 5050 rests a
// bid on nearly everything that clears its bar, so any market Live actually bought and
// closed was handed to 5050 as soon as 5050 had an unfilled bid on the same token.
function liveTradeAttribution(app, { mode, fixedEntryPrice = 0.51, execution5050 = null }) {
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["submittedTokenIds", "fixedEntryTokenIds", "fixedEntryPriceSignatures", "matchesFixedEntryPrice",
    "restsAtFixedEntryPrice", "isFilledPortfolioRow", "fixedEntryOrderPricesByToken", "boughtAtFixedEntryPrice",
    "belongsToActiveLivePortfolio", "isClosedTrade", "liveClosedTrades", "liveOpenOrders"]
    .map(pick).join("\n\n");
  const tolerance = /const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0];
  return new Function("state", "isFixedEntryMode", "normalizeFixedEntryPrice", "portfolioConfigForMode",
    `${tolerance}\n${body}\nreturn { liveClosedTrades, liveOpenOrders };`)(
    { mode, live5050ExecutionState: execution5050 },
    () => mode === "live-5050",
    (value) => Number(value),
    () => ({ fixedEntryPrice }),
  );
}

test("live closed trades: a resting 5050 bid does not take a trade Live actually closed", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The shape live-account-sync builds: an average fill price, and no `price` field.
  const closed = (tokenId, entryPrice, status = "WON") => ({
    id: `t-${tokenId}`, status, tokenId, question: `Market ${tokenId}`,
    entryPrice, currentPrice: null, latestPrice: entryPrice, realizedPnlUsdc: 1.2,
  });
  const liveState = {
    closedTrades: [
      closed("100", 0.95),
      closed("101", 0.88, "LOST"),
      closed("102", 0.51),                       // 5050's own fill, at its one price
      closed("103", 0.97, "REDEEMED"),
      { ...closed("104", 0.9), tokenId: "" },     // no token at all
    ],
  };
  // 5050 has a bid resting on 100 -- the market Live bought and closed.
  const execution5050 = { runLog: [{ attempts: [{ tokenId: "100", action: "SUBMITTED" }] }] };

  const onLive = liveTradeAttribution(app, { mode: "live", execution5050 }).liveClosedTrades(liveState);
  const on5050 = liveTradeAttribution(app, { mode: "live-5050", execution5050 }).liveClosedTrades(liveState);

  assert.deepEqual(onLive.map((row) => row.tokenId), ["100", "101", "103", ""],
    "every trade Live bought stays on the Live tab, including the one 5050 has a bid on");
  assert.deepEqual(on5050.map((row) => row.tokenId), ["102"],
    "and 5050 keeps only what it actually bought, at its own price");

  // A row with no recorded buy price cannot be claimed, so it stays with Live.
  const unknown = { closedTrades: [{ id: "x", status: "WON", tokenId: "100", entryPrice: null }] };
  assert.equal(liveTradeAttribution(app, { mode: "live", execution5050 }).liveClosedTrades(unknown).length, 1);
  assert.equal(liveTradeAttribution(app, { mode: "live-5050", execution5050 }).liveClosedTrades(unknown).length, 0);

  // With no 5050 state at all -- its file 404s until its first run publishes -- nothing
  // may be taken from Live.
  assert.equal(liveTradeAttribution(app, { mode: "live", execution5050: null }).liveClosedTrades(liveState).length, 4);
});

test("live closed trades: resting orders are still attributed by price and run log", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // Unfilled orders have no buy price, so the original signals still decide them --
  // 5050 rests every bid at its entry price, which is far from the market by design.
  const liveState = {
    openOrders: [
      { id: "a", tokenId: "300", price: 0.51, remainingSize: 5 },   // 5050 by price
      { id: "b", tokenId: "301", price: 0.94, remainingSize: 3 },   // Live
      { id: "c", tokenId: "302", price: 0.88, remainingSize: 2 },   // 5050 by its run log
    ],
  };
  const execution5050 = { runLog: [{ attempts: [{ tokenId: "302", action: "SUBMITTED" }] }] };
  assert.deepEqual(
    liveTradeAttribution(app, { mode: "live", execution5050 }).liveOpenOrders(liveState).map((row) => row.id),
    ["b"],
  );
  assert.deepEqual(
    liveTradeAttribution(app, { mode: "live-5050", execution5050 }).liveOpenOrders(liveState).map((row) => row.id),
    ["a", "c"],
  );
});

// Reported: a Live run ended SKIP with "no currently executable candidate after live
// revalidation", and the rejected candidates stayed in the list instead of updating and
// disappearing. Two of the three were markets Gamma no longer lists at all.
//
// The workflow step that writes those verdicts back downloads paper-state.json and merges
// into state["evaluations"] and state["marketObservations"]. Since the catalogue was split
// into sibling segment files, the core keeps exactly those fields as empty arrays -- so
// every run merged into nothing, wrote nothing, and the dead markets were shortlisted,
// re-fetched and re-rejected again on the next pass.
test("live revalidation: the verdicts are written where the rows actually live", async () => {
  const { readFile } = await import("node:fs/promises");
  // The merge is a shared script now: it was a heredoc in the live workflow and absent
  // from 5050, so a market that portfolio found gone stayed READY in its candidate list
  // and was re-fetched and re-rejected by every pass after it.
  const persist = await readFile(new URL("../tools/persist-live-revalidation.py", import.meta.url), "utf8");

  // The fact that makes merging into the core wrong, checked against the real splitter
  // rather than assumed: the fields the step needs are emptied out of paper-state.json.
  const future = new Date(Date.now() + 86400000).toISOString();
  const { core, segments } = bot.splitStateIntoSegments(bot.normalizeState({
    evaluations: [{ tokenId: "555", question: "Dead", status: "EVALUATED", marketProbability: 0.9, endDate: future }],
    marketObservations: [{ tokenId: "555", question: "Dead", status: "SCRAPED", marketProbability: 0.9, endDate: future }],
  }));
  assert.deepEqual(core.evaluations, [], "the core carries no evaluations to merge into");
  assert.deepEqual(core.marketObservations, [], "nor any observations");
  assert.equal(segments.evaluations.evaluations.length, 1, "the rows are in the segment file");
  assert.equal(segments.observations.marketObservations.length, 1);
  assert.equal(core.stateSegments.evaluations.file, "paper-state.evaluations.json");
  assert.equal(core.stateSegments.observations.file, "paper-state.observations.json");

  // So the step has to follow the manifest to those files, and write them back.
  assert.match(persist, /core = read_json\("paper-state\.json"\)/);
  assert.match(persist, /manifest = core\.get\("stateSegments"\)/);
  assert.match(persist, /for segment, field in \(\("evaluations", "evaluations"\), \("observations", "marketObservations"\)\):/);
  assert.match(persist, /documents\[name\] = read_json\(name\)/);
  assert.match(persist, /count = merge_revalidation\(documents\[name\]\.get\(field\), /);
  assert.match(persist, /for name in sorted\(changed\):\n\s+write_json\(name, documents\[name\]\)/);
  // A state written before segmentation still has its rows inline; that path must remain.
  assert.match(persist, /if not re\.fullmatch\(r"\[A-Za-z0-9\._-\]\+\\\.json", name\):\n\s+name = "paper-state\.json"/);
  // And the old whole-core rewrite must be gone, or it would clobber the manifest shell.
  assert.ok(!/merged_evaluations = merge_revalidation\(state\.get\("evaluations"\)/.test(persist));
  assert.ok(!/json\.dumps\(state, ensure_ascii=False, indent=2\)/.test(persist),
    "the observations segment is megabytes; it must not be written indented");

  // A market Gamma dropped is closed out, which is what removes it from the candidates:
  // api.php's active-observation test rejects exactly this status.
  assert.match(persist, /if update\.get\("marketGone"\):/);
  assert.match(persist, /item\["status"\] = "CLOSED"/);
  // Both live portfolios must run it; one of them not doing so is the reported bug.
  for (const file of ["polymarket-live-limit-order-test", "trading-live-5050"]) {
    const workflow = await readFile(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), "utf8");
    assert.match(workflow, /run: python3 trading\/tools\/persist-live-revalidation\.py/, `${file} must persist its verdicts`);
  }

  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");
  assert.match(api, /in_array\(\$status, \['RESOLVED', 'CLOSED', 'EXPIRED', 'FINALIZED', 'SETTLED'\], true\)/);
});

// Asked for: restrict which tags the 5050 logic may be applied to, defaulting to sports
// and esports. The shortlist and the run have to agree on it, or the tab would list
// candidates the executor then refuses -- which is the failure mode this desk keeps
// running into whenever the two sides filter differently.
test("5050 tags: the setting defaults to sports and esports and reaches the executor", async () => {
  const { readFile } = await import("node:fs/promises");
  const [api, workflow, executor, html] = await Promise.all([
    readFile(new URL("../api.php", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
  ]);

  assert.match(api, /'allowedMarketTags' => \['sports', 'esports'\],/, "the requested default");
  // Absent keeps the default; an explicitly empty list must clear the restriction, or it
  // could only ever be narrowed once set.
  assert.match(api, /array_key_exists\('allowedMarketTags', \$fixedInput\)/);
  assert.match(api, /\? normalize_market_tag_list\(\$fixedInput\['allowedMarketTags'\]\)/);

  // The saved value has to survive the trip: an empty list is a real setting and must be
  // written to the environment rather than skipped as "unset".
  assert.match(workflow, /"LIVE_FIXED_ENTRY_ALLOWED_TAGS": ",".join\(/);
  assert.match(workflow, /always_write = \{"LIVE_FIXED_ENTRY_ALLOWED_TAGS"\}/);
  assert.match(workflow, /if value is None or \(value == "" and key not in always_write\):/);
  assert.match(workflow, /LIVE_FIXED_ENTRY_ALLOWED_TAGS: "sports,esports"/, "and a fallback if the config cannot be read");

  // The executor rejects an off-tag market before anything that costs a request. The set
  // is built by the shared envTagSet now that the per-portfolio exclusion list needs the
  // same slugging; this used to be an inline `new Set(...)`.
  assert.match(executor, /const FIXED_ENTRY_ALLOWED_TAGS = envTagSet\("LIVE_FIXED_ENTRY_ALLOWED_TAGS"\);/);
  assert.match(executor, /if \(!marketTagIsAllowed\(row\)\) \{\n\s+note\(`outside this portfolio's tags/);
  // And it is editable, with the tag row shown only on the 5050 tab.
  assert.match(html, /<input type="text" placeholder="sports, esports" data-fixed-entry-tags>/);
  assert.match(html, /data-fixed-entry-row title="Comma separated Polymarket tags/);
});

test("5050 tags: the shortlist and the run agree on which markets qualify", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const executor = await readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8");
  const pick = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = src.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (!depth) return src.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };

  const dashboard = new Function(`
    ${pick(app, "normalizedScrapedScanTag")}
    ${pick(app, "normalizeMarketTagList")}
    ${pick(app, "marketTagSlugsOf")}
    ${pick(app, "marketCarriesAnyTag")}
    ${pick(app, "marketMatchesAllowedTags")}
    return { normalizeMarketTagList, marketMatchesAllowedTags };
  `)();
  const executorFor = (envValue) => new Function("process", `
      ${pick(executor, "envTagSet")}
      const FIXED_ENTRY_ALLOWED_TAGS = envTagSet("LIVE_FIXED_ENTRY_ALLOWED_TAGS");
      ${pick(executor, "marketTagSlugs")}
      ${pick(executor, "marketTagIsAllowed")}
      return { marketTagIsAllowed, tags: [...FIXED_ENTRY_ALLOWED_TAGS] };
    `)({ env: { LIVE_FIXED_ENTRY_ALLOWED_TAGS: envValue } });

  const allowed = dashboard.normalizeMarketTagList(["Sports", "esports", "esports", " "]);
  assert.deepEqual(allowed, ["sports", "esports"], "typed input is slugged and de-duplicated");
  const run = executorFor(allowed.join(","));
  assert.deepEqual(run.tags, ["sports", "esports"], "and the executor reads the same set");

  // Gamma hands tags back as plain strings and as {label,slug} objects, and a market
  // carries them under different fields depending on which pass recorded it.
  const cases = [
    [{ polymarketTags: ["esports", "counter-strike"] }, true],
    [{ tags: [{ slug: "sports" }, { label: "EPL" }] }, true],
    [{ firstTags: ["sports"] }, true],
    [{ riskCategory: "Sports" }, true],
    [{ polymarketTags: ["politics", "elections"] }, false],
    [{}, false],
  ];
  for (const [row, expected] of cases) {
    assert.equal(dashboard.marketMatchesAllowedTags(row, allowed), expected, `shortlist: ${JSON.stringify(row)}`);
    assert.equal(run.marketTagIsAllowed(row), expected, `run: ${JSON.stringify(row)}`);
  }

  // Cleared means every tag, on both sides -- including a market carrying no tags.
  const unrestricted = executorFor("");
  for (const [row] of cases) {
    assert.equal(dashboard.marketMatchesAllowedTags(row, []), true);
    assert.equal(unrestricted.marketTagIsAllowed(row), true);
  }
});

// Reported: a position bought at 50.0% with a 1.00:1 reward/risk -- 5050's signature --
// was showing under Live, which never buys at 50c because its probability bar is 80%.
// The earlier fix attributed a fill by comparing its buy price with 5050's CONFIGURED
// entry price, and that setting had since moved from 0.50 to 0.51. So every position
// 5050 had filled at the old price stopped matching and was handed to Live.
test("5050 fills: a changed entry price does not hand old fills to Live", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["submittedTokenIds", "fixedEntryTokenIds", "fixedEntryPriceSignatures",
    "matchesFixedEntryPrice", "restsAtFixedEntryPrice", "fixedEntryOrderPricesByToken",
    "isFilledPortfolioRow", "boughtAtFixedEntryPrice", "belongsToActiveLivePortfolio",
    "isClosedTrade"].map(pick).join("\n\n");
  const tolerance = /const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0];
  const belongs = (mode, execution5050, configuredPrice) => new Function(
    "state", "isFixedEntryMode", "normalizeFixedEntryPrice", "portfolioConfigForMode",
    `${tolerance}\n${body}\nreturn belongsToActiveLivePortfolio;`,
  )(
    { mode, live5050ExecutionState: execution5050 },
    () => mode === "live-5050",
    (value) => Number(value),
    () => ({ fixedEntryPrice: configuredPrice }),
  );

  const token = "88888888888888888888888888888888";
  // The reported row: rested and filled at 0.50, back when that was the setting.
  const position = {
    tokenId: token,
    question: "LoL: Movistar KOI vs GIANTX - Game 2 Winner",
    outcome: "Movistar KOI",
    status: "OPEN",
    shares: 7.18,
    entryPrice: 0.5,
    totalCostUsdc: 3.59,
  };
  const log = {
    runLog: [
      { attempts: [{ tokenId: token, orderPrice: 0.5, orderSize: 7.18, action: "SUBMITTED" }] },
      { attempts: [{ tokenId: "77777", orderPrice: 0.51, action: "SUBMITTED" }] },
    ],
  };

  // The setting has moved on; the run log has not. Attribution follows the log.
  for (const configured of [0.51, 0.5, 0.62]) {
    assert.equal(belongs("live", log, configured)(position), false,
      `configured ${configured}: a 5050 fill must not appear under Live`);
    assert.equal(belongs("live-5050", log, configured)(position), true,
      `configured ${configured}: it belongs to 5050`);
  }

  // What the earlier fix was for must still hold: a Live fill at the market price on a
  // token 5050 merely has an unfilled bid resting on stays with Live.
  const liveFill = { tokenId: "77777", status: "OPEN", shares: 4, entryPrice: 0.94, totalCostUsdc: 3.76 };
  assert.equal(belongs("live", log, 0.51)(liveFill), true);
  assert.equal(belongs("live-5050", log, 0.51)(liveFill), false);

  // And a 5050 fill whose bid has aged out of the capped run log still matches on the
  // price the portfolio is set to now, so history does not leak to Live as the log rolls.
  const aged = { tokenId: "999", status: "OPEN", shares: 5, entryPrice: 0.51 };
  assert.equal(belongs("live-5050", { runLog: [] }, 0.51)(aged), true);
  assert.equal(belongs("live", { runLog: [] }, 0.51)(aged), false);

  // A rejected attempt claims no token. A market 5050 asked for and was refused, which
  // Live then bought at the market, stays with Live -- that is the guard that stops a
  // merely-attempted bid taking Live's history.
  const refused = { runLog: [{ attempts: [{ tokenId: "555", orderPrice: 0.5, action: "REJECTED" }] }] };
  const liveFillOnRefusedToken = { tokenId: "555", status: "OPEN", shares: 4, entryPrice: 0.94 };
  assert.equal(belongs("live-5050", refused, 0.62)(liveFillOnRefusedToken), false);
  assert.equal(belongs("live", refused, 0.62)(liveFillOnRefusedToken), true);

  // Its price is a different matter: a refused bid is still a bid, and says what price
  // this portfolio rests at. So a fill at 0.50 is 5050's whatever the setting has since
  // become. The two signals cannot collide in practice -- Live's 80% probability bar
  // means it does not buy at 50c.
  const fillAtARefusedPrice = { tokenId: "666", status: "OPEN", shares: 5, entryPrice: 0.5 };
  assert.equal(belongs("live-5050", refused, 0.62)(fillAtARefusedPrice), true);
  assert.equal(belongs("live", refused, 0.62)(fillAtARefusedPrice), false);
});

// Reported: the 5050 run log held a single entry, which is not what happened -- the
// portfolio had run dozens of times. The Live portfolio's log emptied the same way once
// and gained two guards for it; 5050 was created with neither.
test("5050 run log: history cannot be replaced by a single row", async () => {
  const { readFile } = await import("node:fs/promises");
  const [fixed, live] = await Promise.all([
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
  ]);

  // Guard one: the restore must not be allowed to fail quietly. The tool already treats
  // a genuine first-run 404 as an empty log and exits 0, so `|| echo` only ever masked
  // the failures it raises on purpose -- and the run then carried on with nothing.
  assert.match(fixed, /run: node tools\/restore-live-execution-history\.mjs\n/);
  assert.ok(!/restore-live-execution-history\.mjs \|\| echo/.test(fixed),
    "a failed restore must fail the run, not start a fresh log over real history");

  // Guard two: merge the published log into the local one immediately before the upload,
  // because the upload replaces the hosted file outright.
  assert.match(fixed, /- name: Merge published run-log history before upload/);
  assert.match(fixed, /LIVE_EXECUTION_PUBLISHED_STATE_URL: https:\/\/osobnizkusenosti\.cz\/trading\/api\.php\?action=state&target=live-5050-execution/);
  assert.match(fixed, /LIVE_EXECUTION_STATE_PATH: data\/live-5050-execution-state\.json/);
  assert.match(fixed, /run: node tools\/merge-live-execution-history\.mjs/);

  // It has to sit between the executor and the upload, or it guards nothing.
  const order = ["Rest the fixed-entry bids", "Merge published run-log history before upload", "Upload 5050 state"]
    .map((name) => fixed.indexOf(`- name: ${name}`));
  assert.ok(order.every((index) => index > 0), "every step must be present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, `steps are out of order: ${order}`);

  // Both live portfolios now carry the same protection; neither should lose it.
  for (const [label, workflow] of [["live", live], ["5050", fixed]]) {
    assert.match(workflow, /node tools\/merge-live-execution-history\.mjs/, `${label} needs the merge guard`);
    assert.match(workflow, /node tools\/restore-live-execution-history\.mjs/, `${label} needs the restore`);
  }
});

test("5050 run log: the merge publishes a superset, never less", async () => {
  // The tool guards its own entry point, so importing it runs nothing.
  const { mergeRunLogs } = await import("../tools/merge-live-execution-history.mjs");

  // What a run that started from an empty restore writes locally: this decision alone.
  const local = [{ id: "live-trade-batch-2026-08-08T19:39:57.055Z", runAt: "2026-08-08T19:39:57.055Z", strategyId: "live-5050", action: "SUBMITTED", reason: "this run" }];
  const published = Array.from({ length: 13 }, (_, index) => {
    const hour = String(index + 6).padStart(2, "0");
    return { id: `live-trade-batch-2026-08-08T${hour}:00:00.000Z`, runAt: `2026-08-08T${hour}:00:00.000Z`, strategyId: "live-5050", action: "SUBMITTED", reason: `run ${hour}` };
  });

  const merged = mergeRunLogs(local, published);
  assert.equal(merged.length, 14, "one local row plus the thirteen already published");
  assert.equal(merged[0].reason, "this run", "newest first");
  assert.equal(merged[merged.length - 1].reason, "run 06", "and the whole history behind it");
  // The published log can only grow: the merge drops no row that was already there.
  for (const row of published) {
    assert.ok(merged.some((item) => item.id === row.id), `${row.id} must survive the merge`);
  }
  // A local row wins its key, so this run's fresh decision is not shadowed by a stale copy.
  const collided = mergeRunLogs(local, [{ ...local[0], reason: "stale published copy" }, ...published]);
  assert.equal(collided.length, 14);
  assert.equal(collided[0].reason, "this run");

  // And if the published state cannot be read at all the tool refuses outright, rather
  // than letting the upload replace rows it could not see.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/merge-live-execution-history.mjs", import.meta.url), "utf8");
  assert.match(source, /Live execution history merge failed/);
  assert.match(source, /process\.exit\(1\);/);
});

// Asked for: scrape sports and esports automatically, as often as the schedule allows.
// Five minutes is the floor -- GitHub does not run a scheduled workflow more often --
// and measured over seven hours of this repo's own scheduled runs it does not reliably
// manage even the ten minutes it was asked for: median gap 10 min, mean 14, worst 47.
// So two entries offset by five, each naming one tag, and no assumption that every tick
// arrives.
test("scheduled scan: sports and esports alternate on the tightest cadence available", async () => {
  const { readFile } = await import("node:fs/promises");
  const scan = await readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8");

  const crons = [...scan.matchAll(/^ {4}- cron: '([^']+)'$/gm)].map((match) => match[1]);
  assert.equal(crons.length, 2, `expected two schedule entries, got ${JSON.stringify(crons)}`);
  const minutesOf = (cron) => cron.split(" ")[0].split(",").map(Number);
  const [first, second] = crons.map(minutesOf);
  assert.equal(first.length, 6, "one entry every ten minutes");
  assert.equal(second.length, 6);
  // Together they fire every five minutes, and never at the same minute.
  const all = [...first, ...second].sort((a, b) => a - b);
  assert.deepEqual(all, [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57]);
  assert.equal(new Set(all).size, all.length, "the two entries must not collide");
  for (let i = 1; i < all.length; i += 1) {
    assert.equal(all[i] - all[i - 1], 5, "five minutes apart is the floor GitHub allows");
  }

  // The tag is chosen from which entry fired, so the expression has to name the very
  // string one of the cron entries carries -- edit one without the other and every
  // scheduled run would silently scan the same tag.
  const chooser = /PAPER_MARKET_SCAN_TAG: \$\{\{ inputs\.market_scan_tag \|\| \(github\.event\.schedule == '([^']+)' && 'esports' \|\| \(github\.event\.schedule && 'sports' \|\| ''\)\) \}\}/.exec(scan);
  assert.ok(chooser, "the scheduled tag chooser must be present");
  assert.ok(crons.includes(chooser[1]), `the chooser names ${chooser[1]}, which is not one of ${JSON.stringify(crons)}`);
});

test("scheduled scan: a scheduled pass stays small and does not fan out", async () => {
  const { readFile } = await import("node:fs/promises");
  const [scan, bot] = await Promise.all([
    readFile(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8"),
  ]);

  // The filters the opportunities page was already scanning with, applied only to
  // scheduled runs so a dispatch still scans exactly what the page asked for.
  assert.match(scan, /PAPER_MARKET_SCAN_LIQUIDITY_MIN: \$\{\{ inputs\.market_scan_liquidity_min \|\| \(github\.event\.schedule && '40000' \|\| '0'\) \}\}/);
  assert.match(scan, /PAPER_MARKET_SCAN_MAX_DAYS: \$\{\{ inputs\.market_scan_max_days \|\| \(github\.event\.schedule && '2' \|\| '-1'\) \}\}/);

  // Only a dispatch is manual; the scraping log flags them and a scheduled pass must not
  // claim to be one.
  assert.match(scan, /PAPER_MARKET_SCAN_TRIGGER: \$\{\{ github\.event_name == 'workflow_dispatch' && 'MANUAL' \|\| 'AUTO' \}\}/);

  // This restricted the post-scrape dispatch to manual scans, on the worry that firing
  // it every five minutes would back up the one self-hosted runner the live executors
  // share. The effect was that "execute after each scraping" almost never happened, and
  // the worry was wrong: each live workflow serializes on its own concurrency group, so
  // a dispatch arriving while one runs and one waits replaces the waiting one. The rate
  // is bounded by run length, about a minute, not by how often the scan asks.
  assert.match(scan, /- name: Dispatch post-scrape execution\n\s+if: success\(\)\n/);
  assert.doesNotMatch(scan, /- name: Dispatch post-scrape execution\n\s+if: [^\n]*event_name/);

  // And the paper bot must stop taking its rotation slot for these two tags, or they are
  // scanned twice and the other 22 scopes only advance on the ticks left over.
  assert.match(bot, /PAPER_MARKET_SCAN_HOURLY_INTERVAL_MINUTES: "0"/);
  assert.equal(bot.match(/PAPER_MARKET_SCAN_HOURLY_INTERVAL_MINUTES/g).length, 1);

  // Zero is what disables it; the executor must still read it that way.
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(MARKET_SCAN_HOURLY_INTERVAL_MINUTES <= 0\) return null;/);

  // Both scanners still write one paper-state.json, so they must stay serialized.
  assert.match(scan, /group: trading-paper-bot/);
  assert.match(bot, /group: trading-paper-bot/);
});

// Reported: a resting limit order at 52% -- the price 5050 was set to -- was listed under
// Live. Attribution compared the order against a single value, the entry price the
// portfolio is configured at right now, and that setting moves: 0.50, then 0.51, then
// 0.52. Every bid rested at the previous one stopped matching the moment it changed. The
// token could not stand in for it either, because the run log had just been truncated to
// a single row, so there was nothing left to match a token against.
test("5050 orders: a bid is recognised at every price the portfolio bids at", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");
  const pick = (name) => {
    const start = app.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`missing ${name}`);
    const bodyStart = app.indexOf(") {\n", start);
    let depth = 0;
    for (let i = bodyStart + 2; i < app.length; i += 1) {
      if (app[i] === "{") depth += 1;
      else if (app[i] === "}") {
        depth -= 1;
        if (!depth) return app.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced ${name}`);
  };
  const body = ["submittedTokenIds", "fixedEntryTokenIds", "fixedEntryPriceSignatures",
    "matchesFixedEntryPrice", "restsAtFixedEntryPrice", "fixedEntryOrderPricesByToken",
    "isFilledPortfolioRow", "boughtAtFixedEntryPrice", "belongsToActiveLivePortfolio",
    "isClosedTrade", "liveOpenOrders"].map(pick).join("\n\n");
  const tolerance = /const FIXED_ENTRY_PRICE_TOLERANCE = [\d.]+;/.exec(app)[0];
  const openOrdersFor = (mode, execution5050, configuredPrice) => new Function(
    "state", "isFixedEntryMode", "normalizeFixedEntryPrice", "portfolioConfigForMode",
    `${tolerance}\n${body}\nreturn liveOpenOrders;`,
  )(
    { mode, live5050ExecutionState: execution5050 },
    () => mode === "live-5050",
    (value) => Number(value),
    () => ({ fixedEntryPrice: configuredPrice }),
  );

  // The reported row, plus one the Live portfolio really did place at the market.
  const fixedBid = {
    id: "o-1", tokenId: "444", side: "BUY", status: "ORDER_STATUS_LIVE", price: 0.52,
    originalSize: 6.88, remainingSize: 6.88, notionalUsdc: 3.58,
    question: "Valorant: Eternal Fire vs Joblife - Map 2 Winner", outcome: "Eternal Fire",
  };
  const liveBid = { id: "o-2", tokenId: "555", side: "BUY", status: "ORDER_STATUS_LIVE", price: 0.93, originalSize: 4, remainingSize: 4 };
  const liveState = { openOrders: [fixedBid, liveBid] };
  const ids = (mode, execution, configured) => openOrdersFor(mode, execution, configured)(liveState).map((row) => row.id);

  // A run log holding some other token, but recording the price this portfolio bids at.
  const log = { runLog: [{ attempts: [{ tokenId: "999", orderPrice: 0.52, action: "SUBMITTED" }] }] };
  // A log truncated to nothing, where the published state still says what the last run did.
  const wipedButRecent = { fixedEntry: { entryPrice: 0.52 }, attempts: [{ tokenId: "999", orderPrice: 0.52, action: "SUBMITTED" }], runLog: [] };

  for (const [label, execution, configured] of [
    ["configured price current", log, 0.52],
    ["configured price stale", log, 0.5],
    ["log wiped, last run known", wipedButRecent, 0.5],
    ["log wiped, configured current", { runLog: [] }, 0.52],
  ]) {
    assert.deepEqual(ids("live", execution, configured), ["o-2"], `${label}: Live keeps only its own bid`);
    assert.deepEqual(ids("live-5050", execution, configured), ["o-1"], `${label}: the fixed-entry bid is 5050's`);
  }

  // A rejected attempt still says what price this portfolio bids at, even though it
  // claims no token -- that distinction is what lets a refused bid help here without
  // letting it steal a market Live actually traded.
  const refusedOnly = { runLog: [{ attempts: [{ tokenId: "999", orderPrice: 0.52, action: "REJECTED" }] }] };
  assert.deepEqual(ids("live-5050", refusedOnly, 0.5), ["o-1"]);
  assert.deepEqual(ids("live", refusedOnly, 0.5), ["o-2"]);

  // A dry run placed nothing, so its price is not evidence of anything.
  const dryOnly = { runLog: [{ attempts: [{ tokenId: "999", orderPrice: 0.52, action: "DRY_RUN_READY" }] }] };
  assert.deepEqual(ids("live", dryOnly, 0.5).sort(), ["o-1", "o-2"]);
});

// Asked for: the ability to exclude whole event tags from a portfolio's candidates, as a
// portfolio parameter in the same shape as 5050's tag filter -- but on every portfolio,
// and the opposite way round: a block-list rather than an allow-list.

// Extracts a named function's source so the real implementation can be driven directly.
function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  // Counted from the end of the parameter list, or a `= {}` default parameter would
  // close the brace count before the body has opened.
  const bodyStart = src.indexOf(") {\n", start);
  let depth = 0;
  for (let i = bodyStart + 2; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (!depth) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
}

test("excluded tags: every portfolio carries the setting, and it starts empty", async () => {
  const { readFile } = await import("node:fs/promises");
  const [api, html] = await Promise.all([
    readFile(new URL("../api.php", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
  ]);

  // In the shared strategy normalizer, so all five portfolios have it rather than 5050
  // alone. A key this function does not return is dropped on every save, so being here
  // is what makes it persist at all.
  const normalizer = functionSource(api.replace(/mixed \$/g, "$"), "normalize_strategy_config");
  assert.match(normalizer, /'excludedMarketTags' => normalize_market_tag_list\(\$input\['excludedMarketTags'\] \?\? \$defaults\['excludedMarketTags'\] \?\? \[\]\)/);

  // Five defaults: three paper strategies, live, and 5050 -- each excluding nothing, so
  // adding the setting changes no portfolio's behaviour until someone fills it in.
  assert.equal((api.match(/^\s+'excludedMarketTags' => \[\],$/gm) || []).length, 5);

  // Unlike the allow-list, empty and absent mean the same thing here, so the setting
  // needs no array_key_exists special case to be clearable.
  assert.doesNotMatch(api, /array_key_exists\('excludedMarketTags'/);

  // Editable on every tab: the row carries no data-fixed-entry-row, which is what hides
  // the 5050-only controls everywhere else.
  const row = html.slice(html.indexOf('data-excluded-tags-label') - 400, html.indexOf('data-excluded-tags-label') + 60);
  assert.match(row, /<input type="text" placeholder="politics, elections" data-excluded-tags>/);
  assert.doesNotMatch(row, /data-fixed-entry-row/);
});

test("excluded tags: dashboard, live executor and paper bot agree on what a tag is", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, executor, bot] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  // Three separate slug implementations decide this, so they are driven against the same
  // markets: a shortlist that disagrees with the run is the whole class of bug here.
  const dashboard = new Function(`
    ${functionSource(app, "normalizedScrapedScanTag")}
    ${functionSource(app, "normalizeMarketTagList")}
    ${functionSource(app, "marketTagSlugsOf")}
    ${functionSource(app, "marketExcludedByTags")}
    return (item, tags) => marketExcludedByTags(item, normalizeMarketTagList(tags));
  `)();
  const live = (tags) => new Function("process", `
    ${functionSource(executor, "envTagSet")}
    const EXCLUDED_MARKET_TAGS = envTagSet("LIVE_EXCLUDED_MARKET_TAGS");
    ${functionSource(executor, "marketTagSlugs")}
    ${functionSource(executor, "excludedMarketTagsOn")}
    return excludedMarketTagsOn;
  `)({ env: { LIVE_EXCLUDED_MARKET_TAGS: tags } });
  const paper = (tags) => {
    const strategy = new Function("process", `
      ${functionSource(bot, "envTagSet")}
      return { excludedMarketTags: envTagSet("PAPER_X_EXCLUDED_MARKET_TAGS") };
    `)({ env: { PAPER_X_EXCLUDED_MARKET_TAGS: tags } });
    const check = new Function(`
      ${functionSource(bot, "rowTagSlugs")}
      ${functionSource(bot, "excludedTagsOnRow")}
      return excludedTagsOnRow;
    `)();
    return (item) => check(item, strategy);
  };

  // Typed the way a person types it, matched against the slugs a market actually carries.
  const typed = "Politics, elections";
  const cases = [
    [{ polymarketTags: ["politics", "us-news"] }, ["politics"]],
    [{ tags: [{ slug: "elections", label: "Elections" }] }, ["elections"]],
    [{ firstTags: ["Politics"] }, ["politics"]],
    [{ riskCategory: "politics" }, ["politics"]],
    [{ polymarketTags: ["politics"], tags: ["elections"] }, ["politics", "elections"]],
    [{ polymarketTags: ["esports", "counter-strike"] }, []],
    [{}, []],
  ];
  for (const [row, expected] of cases) {
    const label = JSON.stringify(row);
    assert.deepEqual(dashboard(row, typed).sort(), [...expected].sort(), `dashboard: ${label}`);
    assert.deepEqual(live(typed)(row).sort(), [...expected].sort(), `live executor: ${label}`);
    assert.deepEqual(paper(typed)(row).sort(), [...expected].sort(), `paper bot: ${label}`);
  }

  // Nothing excluded is the default, and it must never reject anything.
  for (const empty of ["", "   ", ",,"]) {
    assert.deepEqual(dashboard({ polymarketTags: ["politics"] }, empty), [], "dashboard excludes nothing");
    assert.deepEqual(live(empty)({ polymarketTags: ["politics"] }), [], "live excludes nothing");
    assert.deepEqual(paper(empty)({ polymarketTags: ["politics"] }), [], "paper excludes nothing");
  }
});

test("excluded tags: the rule sits above every mode-specific test", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, executor, bot] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/live-order-executor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  // The 5050 branch returns early, so a rule placed after it would silently not apply to
  // the portfolio most likely to want one. The exclusion goes above the whole ladder.
  const reasons = functionSource(app, "portfolioCandidateFilterReasons");
  const exclusion = reasons.indexOf("const hitExclusions = marketExcludedByTags(item, excludedTags);");
  const fixedEntryBranch = reasons.indexOf("if (isFixedEntryMode(mode)) {");
  assert.ok(exclusion > 0 && fixedEntryBranch > exclusion,
    "the exclusion must be checked before the 5050 branch returns");

  // In the live executor it goes in the shared prefilter, which feeds both live
  // strategies -- not into either strategy, where the other would not inherit it.
  const prefilter = functionSource(executor, "prefilterLiveCandidate");
  assert.match(prefilter, /const excludedTags = excludedMarketTagsOn\(item\);/);
  assert.match(prefilter, /reasons\.push\(`excluded tag\$\{excludedTags\.length > 1 \? "s" : ""\} \$\{excludedTags\.join\(", "\)\}`\)/);
  assert.match(executor, /const candidatePool = prepareLiveCandidatePool\(rawCandidateRows, liveState\);/,
    "and that prefilter is what builds the pool both strategies read");

  // The paper bot filters and explains in two separate places; a row dropped by one and
  // not the other is a candidate list that disagrees with its own rejection reasons.
  assert.match(functionSource(bot, "strategyEligibleCandidates"),
    /if \(excludedTagsOnRow\(item, strategy\)\.length\) return false;/);
  assert.match(functionSource(bot, "portfolioFilterResult"),
    /const excludedTags = excludedTagsOnRow\(item, strategy\);/);
});

test("excluded tags: the saved value reaches all three runtimes", async () => {
  const { readFile } = await import("node:fs/promises");
  const [paperWorkflow, liveWorkflow, fixedWorkflow, bot] = await Promise.all([
    readFile(new URL("../../.github/workflows/trading-paper-bot.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/polymarket-live-limit-order-test.yml", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/trading-live-5050.yml", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(paperWorkflow, /emit\(f"\{prefix\}_EXCLUDED_MARKET_TAGS", ",".join\(excluded_tags\)\)/);
  assert.match(liveWorkflow, /"LIVE_EXCLUDED_MARKET_TAGS": ",".join\(/);
  assert.match(fixedWorkflow, /"LIVE_EXCLUDED_MARKET_TAGS": ",".join\(/);

  // The paper workflow writes one variable per strategy, so each strategy has to read
  // its own -- a shared name would give all three portfolios one setting.
  for (const prefix of ["CONSERVATIVE", "HIGH_REWARD", "MORE_PROBABLE"]) {
    assert.match(bot, new RegExp(`excludedMarketTags: envTagSet\\("PAPER_${prefix}_EXCLUDED_MARKET_TAGS"\\)`));
  }
});

// Asked for: the Polymarket tag box holds minor tags; it should offer only a few main
// ones, category-style, and politics and geopolitics are missing from it.

test("scan categories: the picker offers categories, not whatever was scraped", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  // The counting moved out of here: the bracket used to report how many of our own rows
  // carried the tag, and now reports how many events Polymarket lists that match what the
  // scan takes. What this test still owns is *which* categories are offered and in what
  // order, so it drives the option builder against a supplied count map instead.
  const build = (counts) => new Function("state", `
    ${/const MARKET_SCAN_CATEGORIES = \[[\s\S]*?\n\];/.exec(app)[0]}
    ${functionSource(app, "scrapedScanTagOptions")}
    return scrapedScanTagOptions;
  `)({ scanCategoryCounts: counts })();

  // Measured off Gamma, these are the per-league slugs the sports and esports scopes
  // produce. They are what used to fill the box, and exactly what must not.
  const options = build(new Map([["sports", 191], ["esports", 32]]));
  const offered = options.map(([tag]) => tag);

  for (const minor of ["uslc", "usl1", "bra3", "brazil-serie-a", "setkamemd", "setka", "chl2", "ecu1", "games"]) {
    assert.ok(!offered.includes(minor), `${minor} is a league, not a category, and must not be offered`);
  }
  // The two the box was missing. It could not have shown them while the list came from
  // scraped rows: only sports and esports are scraped, so a category could never appear
  // until it had already been scanned -- which needed it in the box first.
  assert.ok(offered.includes("politics"), "politics must be offerable");
  assert.ok(offered.includes("geopolitics"), "geopolitics must be offerable");
  assert.ok(offered.length <= 16, `a category picker, not a tag dump: ${offered.length} entries`);

  // Fixed order, so the box does not rearrange itself as counts arrive.
  assert.deepEqual(offered, build(null).map(([tag]) => tag), "the list is the same whatever is counted");
  assert.equal(offered[0], "politics");

  // The count is whatever Polymarket reported for that category, and a category with no
  // answer carries null rather than a zero -- "no number yet" and "none there" are
  // different facts, and only the second is worth putting in a bracket.
  assert.equal(options.find(([tag]) => tag === "sports")[1], 191);
  assert.equal(options.find(([tag]) => tag === "esports")[1], 32);
  assert.equal(options.find(([tag]) => tag === "politics")[1], null, "no answer is not a zero");
  assert.equal(build(new Map([["politics", 0]])).find(([tag]) => tag === "politics")[1], 0);
});

test("scan categories: every offered category is one the scanner can resolve", async () => {
  const { readFile } = await import("node:fs/promises");
  const [app, bot] = await Promise.all([
    readFile(new URL("../assets/app.js", import.meta.url), "utf8"),
    readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"),
  ]);

  const categories = new Function(`
    ${/const MARKET_SCAN_CATEGORIES = \[[\s\S]*?\n\];/.exec(app)[0]}
    return MARKET_SCAN_CATEGORIES;
  `)();
  const known = new Set(
    [...(/const MARKET_SCAN_CATEGORY_TAGS = \[[\s\S]*?\n\];/.exec(bot)[0]).matchAll(/slug: "([^"]+)"/g)]
      .map((match) => match[1]),
  );

  // Offering a category the scanner has no tag id for would make the box able to ask for
  // a scan that cannot run. Every entry has to be one it already knows.
  for (const tag of categories) {
    assert.ok(known.has(tag), `${tag} is offered but the scanner has no tag id for it`);
  }

  // A stored preference for a tag no longer offered has to fall back rather than sit
  // selected and invisible -- the per-league slugs people picked before are all gone now.
  const render = functionSource(app, "renderScrapedScanControls");
  assert.match(render, /if \(state\.scrapedScanTag && !availableTags\.has\(state\.scrapedScanTag\)\) state\.scrapedScanTag = "";/);
  // And a category whose count did not arrive inside the budget gets no bracket at all,
  // rather than a zero that would read as "nothing there".
  assert.match(render, /const suffix = count == null \? "" :/);
});

test("paper rotation: free capital is spent before a position is given up", async () => {
  // Reported on the Conservative portfolio, and it applied to all three: the log showed
  // free cash available to open a trade, yet the run rotated -- it sold a holding to fund
  // a candidate it could have bought outright, giving up the position for nothing.
  //
  // Two things made it certain rather than occasional. Rotation was evaluated before the
  // capital check that follows it, and its only capital test was whether the stake would
  // fit *after* an exit -- trivially true when it already fits without one.
  const { readFile } = await import("node:fs/promises");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  const held = { id: "T1", status: "OPEN", tokenId: "1", maxLossUsdc: 5, stakeUsdc: 5 };
  const candidate = { tokenId: "2" };
  const review = (available, stake) => new Function(
    "openTrades", "heldHours", "ROTATION_MIN_HOLD_HOURS", "findFirstOpenCandidate",
    "tradeContinuationEconomics", "candidateRotationScore", "portfolioEconomics",
    "ROTATION_MIN_SCORE_IMPROVEMENT", "ROTATION_MIN_EV_USDC_IMPROVEMENT",
    // The review now summarises each position it weighed, so its two summary helpers
    // come with it.
    `${functionSource(bot, "rotationPositionSummary")}\n${functionSource(bot, "rotationCandidateSummary")}\n`
    + `${functionSource(bot, "rotationReview")}\nreturn rotationReview;`,
  )(
    (trades) => trades, () => 48, 6, () => ({ best: candidate }),
    // A candidate far better than the holding, so nothing but the capital rule can
    // decide this: score 2 vs 1 and EV 0.50 vs 0.10 clear both improvement bars.
    () => ({ score: 1, expectedValue: 0.10 }), () => 2, () => ({ expectedValueUsdc: 0.50 }),
    0.15, 0.02,
  )({ trades: [held] }, [candidate], {}, available, stake);

  assert.equal(review(9, 5), null, "with free cash to spare the portfolio buys, it does not rotate");
  assert.equal(review(5, 5), null, "and exactly enough is enough -- the same bar the capital check uses");

  // Rotation still does its job when the candidate genuinely cannot be funded otherwise.
  const short = review(1, 5);
  assert.ok(short, "short of the stake, rotation is the only way to take the better candidate");
  assert.equal(short.trade.id, "T1");
  assert.equal(short.candidate.tokenId, "2");

  // The rule the live executor has always had, now stated on the paper side too, and
  // recorded so a ROTATED_OPENED row can be read without guessing at the cash position.
  assert.match(bot, /if \(available >= stake\) return null;/);
  assert.match(bot, /freeCapitalCoversStake: Number\(available\) >= Number\(stake\),/);
});

test("paper rotation log: it names the position sold and what lost to it", async () => {
  // Reported from a ROTATED_OPENED row: nothing said which open position was being
  // rotated out, nor why that one rather than the others. The run-log detail has a rich
  // rotation renderer, but it was written for the live executor's shape -- action,
  // reason, best.position, best.candidate, reviews -- and the paper side emitted none of
  // those, so the section rendered "Action: -", "Reason: -" and stopped.
  const { readFile } = await import("node:fs/promises");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  const holding = (id, hours, tokenId) => ({
    id, status: "OPEN", tokenId, maxLossUsdc: 5, stakeUsdc: 5, totalCostUsdc: 5,
    currentValueUsdc: 4.6, unrealizedPnlUsdc: -0.4, question: `Held ${id}`, outcome: "Yes",
    openedAt: new Date(Date.now() - hours * 3600000).toISOString(),
  });
  const candidate = {
    tokenId: "2", question: "Better market", outcome: "No",
    marketProbability: 0.94, netYield: 0.06, daysToResolution: 1,
  };
  const review = new Function(
    "openTrades", "heldHours", "ROTATION_MIN_HOLD_HOURS", "findFirstOpenCandidate",
    "tradeContinuationEconomics", "candidateRotationScore", "portfolioEconomics",
    "ROTATION_MIN_SCORE_IMPROVEMENT", "ROTATION_MIN_EV_USDC_IMPROVEMENT",
    `${functionSource(bot, "rotationPositionSummary")}\n${functionSource(bot, "rotationCandidateSummary")}\n`
    + `${functionSource(bot, "rotationReview")}\nreturn rotationReview;`,
  )(
    (trades) => trades, (trade) => (Date.now() - Date.parse(trade.openedAt)) / 3600000, 6,
    () => ({ best: candidate }), () => ({ score: 1, expectedValue: 0.10 }), () => 2,
    () => ({ expectedValueUsdc: 0.50 }), 0.15, 0.02,
  )(
    { trades: [holding("A", 48, "1"), holding("B", 2, "3")] },
    [candidate], { selectionMetric: "EV p.a." }, 1, 5,
  );

  assert.equal(review.trade.id, "A", "the eligible holding is the one rotated");
  // Every holding that was weighed is on the record, including the ones that were not
  // chosen -- that is the half the log was missing.
  const byQuestion = new Map(review.reviews.map((row) => [row.position.question, row]));
  assert.deepEqual([...byQuestion.keys()].sort(), ["Held A", "Held B"]);
  assert.equal(byQuestion.get("Held A").action, "ROTATE_CANDIDATE");
  assert.match(byQuestion.get("Held A").reason, /clears both bars/);
  // And a holding excluded before the comparison says why it never got there.
  assert.equal(byQuestion.get("Held B").action, "HOLD");
  assert.match(byQuestion.get("Held B").reason, /below the 6h minimum/);

  // The position summary carries what the detail renders about the row being sold.
  const sold = byQuestion.get("Held A").position;
  assert.equal(sold.outcome, "Yes");
  assert.equal(sold.estimatedExitValueUsdc, 4.6);
  assert.equal(sold.realizedPnlIfExitUsdc, -0.4, "what exiting now actually realises");

  // The emitted review uses the field names the run-log detail already reads.
  const emitted = bot.slice(bot.indexOf("    rotationReview: {"));
  for (const field of ["action:", "reason:", "best: {", "position: rotationPositionSummary(trade)",
    "candidate: rotationCandidateSummary(review.candidate", "evDeltaUsdc:", "reviews:"]) {
    assert.ok(emitted.includes(field), `the rotation review must emit ${field}`);
  }
});

test("paper candidates: a retired scorer's zeros are not the reason a candidate was skipped", async () => {
  // Reported from the same log: every row under "Candidates not used" showed +0.0% net
  // yield, +0.0% potential p.a. and "probability 0.0% below high-confidence threshold and
  // edge-opportunity threshold; annualized EV 0.0% is non-profitable after fees" -- for
  // markets priced nowhere near zero.
  //
  // The row's verdict came from the AI-scored economics. With no model consulted there is
  // no AI probability, so that verdict is a row of zeros. Every portfolio scores on the
  // Polymarket probability, so that is the verdict the row now carries.
  const { readFile } = await import("node:fs/promises");
  const bot = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  assert.match(bot, /const scoringEconomics = AI_ANALYSIS_ENABLED \? economics : marketEconomics;/);
  assert.match(bot, /const rejectReasons = scoringEconomics\.rejectReasons\.map/);
  // Both stored rows take their status from it, or one shape keeps the zeros.
  assert.equal((bot.match(/status: scoringEconomics\.status,/g) || []).length, 2);
  assert.ok(!/status: economics\.status,/.test(bot), "no row may still carry the AI verdict");

  // The switch is the existing single one, so nothing new can turn the model back on.
  assert.match(bot, /const AI_ANALYSIS_ENABLED = envBool\("PAPER_AI_ANALYSIS_ENABLED", false\);/);
});

test("scraping log: the asked-for columns lead, and every header keeps its own cell", async () => {
  // Asked for: new/updated third, categories fourth. The table scrolls horizontally, so
  // the first columns are what is read without dragging -- and those two are what a
  // scraping run is judged on.
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../assets/app.js", import.meta.url), "utf8");

  const fn = app.slice(app.indexOf("function renderScrapeRunLog"));
  const body = fn.slice(0, fn.indexOf("\nfunction ", 1));
  const headers = [...body.matchAll(/<th>([^<]+)<\/th>/g)].map((match) => match[1]);
  const cells = [...body.matchAll(/<td data-label="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(headers.slice(0, 4), ["Run time", "Trigger", "New / updated", "Categories"]);

  // Headers and cells are two separate lists in one template, so moving a column means
  // moving both -- otherwise every value below it shifts under the wrong heading, which
  // reads as wrong data rather than a layout slip. The trade table has had this pinned
  // since a reorder did exactly that; this table had nothing.
  assert.deepEqual(cells, headers, "each column's cell must sit under its own header");
  assert.ok(headers.length >= 13, `expected the full column set, found ${headers.length}`);
});

test("execution candidates: Win and Days left lead, precheck follows the market", async () => {
  // Asked for: drop the row-number column, put Win first and Days left second, and move
  // precheck behind Market. The table scrolls sideways, so the leading columns are what
  // is read without dragging -- and a row's number in the list is not one of them.
  const renderer = candidateRenderer({ candidateVisibleCount: 80, candidateVisibleMode: "live" });
  const rows = [{ tokenId: "1", question: "A market", outcome: "Yes" }];

  for (const mode of ["live", "paper-conservative"]) {
    const html = renderer.render(rows, mode, null);
    const headers = [...html.matchAll(/<th>([^<]*)<\/th>/g)].map((match) => match[1].trim());
    const cells = [...html.matchAll(/<td data-label="([^"]*)"/g)].map((match) => match[1].trim());

    assert.deepEqual(headers.slice(0, 4), ["Win", "Days left", "Market", "Precheck"], `${mode} order`);
    // Headers and cells are two lists in one template, so a moved column has to move in
    // both or every value below it lands under the wrong heading.
    assert.deepEqual(cells, headers, `${mode}: each cell must sit under its own header`);
    assert.ok(!headers.includes("#"), `${mode}: the row-number column is gone`);
    assert.ok(!/data-label="#"/.test(html), `${mode}: and its cell with it`);
  }

  // READY on a live portfolio said "will verify live quote, fees and ranking" -- what
  // every live execution does to every candidate, so it said nothing about the row while
  // taking the space of something that would.
  const app = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../assets/app.js", import.meta.url), "utf8"));
  // Checked against the code, or the comment recording why it went would count as the
  // string it warns about.
  const appCode = app.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/will verify live quote/.test(appCode), "the blanket precheck note is gone");
  // A paper portfolio keeps its own note, and an excluded or blocked row keeps its reason.
  assert.match(app, /\(!live \? "ready for next paper execution" : ""\)/);
  assert.match(app, /"excluded manually for this portfolio"/);
  assert.match(app, /"excluded by diversification rules"/);
  // With no note there must be no empty element left behind under the badge.
  assert.match(app, /\$\{status \? `<span>\$\{escapeHtml\(status\)\}<\/span>` : ""\}/);
});

// Reported from the conservative portfolio's run log: every candidate came back as
// "execution shortlist revalidation failed: scoringEconomics is not defined; base status
// ERROR is not executable", and the portfolio stopped opening orders altogether.
//
// The cause was mine. Routing the verdict through market economics instead of the retired
// AI probability introduced `scoringEconomics` in the main evaluation path, and the same
// rename landed on two lines inside refreshEvaluationAfterProbability, which has no such
// local. node --check parses, it does not resolve identifiers, so it compiled clean and
// threw on the first call -- and that call is what revalidates a stored candidate, so one
// ReferenceError took out the whole shortlist.
//
// Calling the real function is the only thing that catches this class of bug.
test("revalidation: refreshing a stored candidate does not throw on an undefined name", () => {
  const evaluation = {
    id: "market-1",
    tokenId: "77",
    question: "Will this resolve yes?",
    outcome: "No",
    marketPrice: 0.96,
    marketProbability: 0.96,
    stakeUsdc: 5,
    takerFeeUsdc: 0,
    totalCostUsdc: 5,
    executableShares: 5.2,
    filledStakeUsdc: 5,
    spread: 0.01,
    liquidity: 90000,
    volume24hr: 90000,
    daysToResolution: 0.5,
    endDate: new Date(Date.now() + 12 * 3600000).toISOString(),
  };

  const refreshed = bot.refreshEvaluationAfterProbability(evaluation, 0.96, "market", null);
  assert.ok(refreshed, "the refreshed evaluation must come back");
  assert.equal(typeof refreshed.status, "string");
  assert.notEqual(refreshed.status, "", "a candidate with no verdict is not executable");
  // The verdict comes from the market's economics now, so a market this strong is not
  // rejected for want of an AI probability that nothing produces any more.
  assert.ok(Array.isArray(refreshed.rejectReasons));
  assert.ok(!refreshed.rejectReasons.some((reason) => /is not defined/.test(String(reason))));

  // And a market whose own probability cannot be read still gets judged rather than
  // crashing the shortlist -- that is the null-marketEconomics path.
  const unreadable = bot.refreshEvaluationAfterProbability(
    { ...evaluation, marketProbability: null, marketPrice: Number.NaN },
    0.96,
    "market",
    null,
  );
  assert.ok(unreadable);
  assert.equal(typeof unreadable.status, "string");
});

// The same 500 that killed the trading runs also kills the opportunities page, and the
// page cannot simply skip the resolved archive -- the Resolved tab is what it is for.
// Measured on a state at production's counts, decoding 23,561 resolved rows peaks at
// 138 MB, and the host answers 500 above 128 MB. Nothing downstream can rescue that: the
// cost is paid at json_decode, before a single row has been filtered or capped.
//
// So the archive is still kept whole -- it is the record of everything ever mined -- and
// the newest page of it is published beside it as its own capped file. Reading that
// instead changes the cost from "however much history exists" to a constant.
test("state segments: the newest resolved page is published beside the full archive", () => {
  const resolvedAt = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const observations = [];
  for (let i = 0; i < 40; i += 1) {
    observations.push({ id: `active-${i}`, tokenId: `${i}`, status: "SCRAPED", marketProbability: 0.9 });
  }
  // Deliberately oldest-first, so an implementation that just takes the head of the list
  // instead of sorting serves the wrong page and fails here.
  for (let i = 0; i < 200; i += 1) {
    observations.push({ id: `resolved-${i}`, tokenId: `r${i}`, status: "RESOLVED", resolvedAt: resolvedAt(200 - i) });
  }

  const { core, segments } = bot.splitStateIntoSegments({ marketObservations: observations });
  const archive = segments.resolvedObservations.resolvedMarketObservations;
  const recent = segments.resolvedRecent.resolvedMarketObservations;

  // The archive keeps everything, and the active catalogue never carries resolved rows.
  assert.equal(archive.length, 200);
  assert.equal(segments.observations.marketObservations.length, 40);

  // The page is bounded and newest first. With the default cap above the row count it is
  // the whole archive re-ordered, which is what makes the ordering testable at this size.
  assert.equal(recent.length, 200);
  assert.equal(recent[0].id, "resolved-199", "the newest resolved market leads the page");
  assert.equal(recent[recent.length - 1].id, "resolved-0");

  // The tab labels read the manifest, not the served rows, so capping the page must not
  // change what the counts say was mined.
  assert.equal(core.stateSegments.resolvedObservations.counts.resolvedMarketObservations, 200);
  assert.equal(core.stateSegments.resolvedRecent.truncatedFrom, 200);
  assert.equal(core.stateSegments.resolvedRecent.file, "paper-state.resolvedRecent.json");
  assert.equal(core.stateSegments.resolvedRecent.mergesInto, "marketObservations");
});

test("state segments: the opportunities page reads the capped page, not the archive", async () => {
  const { readFile } = await import("node:fs/promises");
  const api = await readFile(new URL("../api.php", import.meta.url), "utf8");

  // The one line that decides whether this page costs a constant or grows with history.
  assert.match(api, /case 'scraped':\n[\s\S]*?return \['observations', 'resolvedRecent', 'scanHistory'\];/);
  // It merges through the same transport field, so nothing downstream changes shape.
  assert.match(api, /'resolvedRecent' => \['resolvedMarketObservations'\],/);
  // And the totals still come from the archive's own manifest entry, untouched.
  assert.match(api, /\$manifest\['resolvedObservations'\]\['counts'\]\['resolvedMarketObservations'\]/);

  // The page is published but never reassembled into state: it carries the archive's own
  // transport field, and the merge replaces the resolved half rather than appending, so a
  // reader that loaded both would rebuild the state from whichever landed last.
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  const readBack = /const STATE_SEGMENT_NAMES = \[[^\]]*\];/.exec(source);
  const published = /const PUBLISHED_STATE_SEGMENT_NAMES = \[[^\]]*\];/.exec(source);
  assert.doesNotMatch(readBack[0], /RESOLVED_RECENT_SEGMENT/,
    "reassembling the state from the capped page would truncate the archive on the next write");
  assert.match(published[0], /RESOLVED_RECENT_SEGMENT/);
});

// The capped page was kept out of the local reader by name, and the hosted reader walks
// the manifest instead -- so it fetched the page too, merged it last, and the archive in
// memory became its own first 3,000 rows. The next write would have published that back
// as the whole archive, losing every older resolved market permanently.
test("state segments: reading the hosted state never rebuilds it from the capped page", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

  // Both readers exclude the same set, named once so they cannot drift apart.
  assert.match(source, /const DERIVED_STATE_SEGMENTS = new Set\(\[RESOLVED_RECENT_SEGMENT\]\);/);
  assert.match(source, /\.filter\(\(\[name\]\) => !DERIVED_STATE_SEGMENTS\.has\(name\)\)/,
    "the manifest-driven reader must skip derived segments");
  assert.match(source, /Object\.keys\(manifest\)\.filter\(\(name\) => !DERIVED_STATE_SEGMENTS\.has\(name\)\)/,
    "and must not then count them as segments it failed to address");

  // What the merge would have done, driven by the real function in manifest order.
  const resolvedAt = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
  const observations = [];
  for (let i = 0; i < 5; i += 1) observations.push({ id: `a${i}`, status: "SCRAPED" });
  for (let i = 0; i < 50; i += 1) observations.push({ id: `r${i}`, status: "RESOLVED", resolvedAt: resolvedAt(50 - i) });
  const { core, segments } = bot.splitStateIntoSegments({ marketObservations: observations });

  // Manifest order, which is the order the hosted reader fetches in.
  let asHosted = { ...core };
  for (const name of Object.keys(core.stateSegments)) {
    if (name === "resolvedRecent") continue;
    asHosted = bot.mergeStateSegment(asHosted, segments[name]);
  }
  assert.equal(asHosted.marketObservations.length, 55, "the archive is rebuilt whole");

  // And the failure it replaces: merging the page last leaves only the page.
  const truncated = bot.mergeStateSegment(asHosted, segments.resolvedRecent);
  assert.equal(
    truncated.marketObservations.filter((item) => item.status === "RESOLVED").length,
    segments.resolvedRecent.resolvedMarketObservations.length,
    "merging the page replaces the archive rather than adding to it -- which is why it is skipped",
  );
});
