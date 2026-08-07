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

test("market scan: sports and esports get a guaranteed slot every hour", () => {
  const scopes = bot.marketScanScopes();
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

  // The two columns that only exist in one of the two views must stay conditional, or
  // the closed table gains an empty column and the open one loses a value.
  assert.ok(thead.includes('showStatus ? tradeHeader(tableKey, "status", "Result")'));
  assert.ok(tbody.includes('showStatus ? `<td data-label="Result"'));
  assert.ok(thead.includes('showAiProbability ? tradeHeader(tableKey, "aiProbability", "AI prob.")'));
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
  for (const expected of ["nba", "sports", "crypto"]) {
    assert.ok(labels.includes(expected), `${expected} must appear as a tag row`);
  }
  assert.ok(rows.some((row) => row.kind === "category"), "categories are still grouped");
  // Risk labels are per-fixture dedup identifiers, not taxonomy: each groups exactly
  // one opportunity, so it can never carry a comparable sample and only crowds out the
  // real categories. They used to be fed straight into this table.
  assert.ok(!labels.includes("entity:acme"), "a risk label must not become a tag row");

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

test("category performance: per-fixture slugs never become their own rows", async () => {
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
    polymarketTags: [{ slug: "sports" }, { slug: "ucl-fen-stu1-2026-08-05-exact-score" }],
    riskGroupLabels: [
      "Market: uwcl-faw-haj-2026-08-05-corners-team-home-4pt5",
      "Event: uwcl-faw-haj-2026-08-05",
      "Team: sk brann",
      "Topic: bitcoin",
    ],
  }));

  const rows = bot.buildCalculationReport(state).categorySummaries;
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

test("parameter combinations: the no-floor liquidity row really means all", async () => {
  // The dominant reason this table reported far fewer resolved opportunities than the
  // resolved list: every combination required a finite liquidity, including the row the
  // UI labels "All" (floor 0). An opportunity whose liquidity was never stored was
  // therefore dropped from all 360 combinations at once. Unknown horizons were already
  // tolerated, so the two filters disagreed on how to treat missing data.
  const { readFile } = await import("node:fs/promises");
  const state = bot.normalizeState(
    JSON.parse(await readFile(new URL("../data/paper-state.fixture.json", import.meta.url), "utf8")),
  );
  const report = bot.buildCalculationReport(state);
  const noFloor = report.parameterSummaries.filter((row) => row.marketType === "all"
    && row.minLiquidityUsdc === 0
    && row.threshold === 0.5);
  assert.ok(noFloor.length, "the fixture must produce a no-floor row");
  assert.ok(
    noFloor.some((row) => row.trades === report.sampleSize),
    `the widest no-floor row must hold every simulated opportunity (${report.sampleSize}), got ${JSON.stringify(noFloor.map((r) => r.trades))}`,
  );
  assert.ok(
    noFloor.some((row) => row.resolved === report.resolvedSampleSize),
    `and every resolved one (${report.resolvedSampleSize}), got ${JSON.stringify(noFloor.map((r) => r.resolved))}`,
  );

  // A real floor still excludes an unknown liquidity: it cannot be shown to clear it.
  const withFloor = report.parameterSummaries.find((row) => row.marketType === "all"
    && row.minLiquidityUsdc === 100000
    && row.threshold === 0.5
    && row.maxResolutionDays === 30);
  assert.equal(withFloor.trades, 0, "an unrecorded liquidity must not pass a real floor");
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
