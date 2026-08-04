// Runs offline: no secrets, no network, no hosting access.
// Deterministic portfolio constants must be set before the module is imported,
// because the bot reads them from the environment at import time.
process.env.PAPER_PORTFOLIO_USDC = "100";
process.env.PAPER_MAX_FRACTION = "0.05";
process.env.PAPER_MIN_ANNUALIZATION_DAYS = "1";
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

test("economics: a 0.0 day horizon cannot produce a millions-of-percent P.A.", () => {
  assert.equal(bot.annualizationDays(0), 1, "the horizon is floored at one day");
  assert.equal(bot.annualizationDays(0.0001), 1);
  assert.equal(bot.annualizationDays(7), 7);
  assert.equal(bot.annualizationDays("nonsense"), null);

  const potential = bot.annualizedPotentialReturn(0.01, 0);
  assert.equal(potential, 0.01 * 365, "1% over a floored single day is 365%, not unbounded");
  assert.ok(Number.isFinite(potential));
  assert.ok(potential < 100, "a 1% yield must never annualize past 10000%");
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
