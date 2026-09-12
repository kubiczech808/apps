// Runs offline: no secrets, no network, no hosting access.
//
// Reported: the ROI column in the portfolio overview is computed only for the portfolio
// that is open, and the value vanishes from the row as soon as another is selected -- so
// the portfolios cannot be compared by it.
//
// The cause is not a rendering bug. The overview payload deliberately carries every
// portfolio's summary and an EMPTY trade list, which is what keeps switching portfolios
// cheap, and the browser's ROI is a sum over trades. For every row but one it summed
// nothing.
//
// So the two halves of the ratio are computed where the trades still exist -- server-side,
// in the pass that already counts the closed trades -- and both ends are driven here.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

function evalPhp(expression, args) {
  const directory = mkdtempSync(join(tmpdir(), "overview-roi-"));
  try {
    const cut = API.indexOf("\ntry {");
    assert.ok(cut > 0, "api.php still ends with its request dispatch");
    const definitions = join(directory, "definitions.php");
    writeFileSync(definitions, API.slice(0, cut) + "\n");
    const encoded = Buffer.from(JSON.stringify(args)).toString("base64");
    return JSON.parse(execFileSync("php", ["-r",
      `require '${definitions}'; $args = json_decode(base64_decode('${encoded}'), true); echo json_encode(${expression});`,
    ], { encoding: "utf8" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The browser's rule, lifted from the file and executed rather than restated.
function browserRoi(row) {
  const source = /function portfolioRealizedRoiForMode[\s\S]*?\n\}/.exec(APP);
  assert.ok(source, "the ROI rule must be findable");
  const helpers = [
    /function isUnfilledLimitOrder[\s\S]*?\n\}/,
    /function isClosedTrade[\s\S]*?\n\}/,
    /function paperPortfolioTrades[\s\S]*?\n\}/,
  ].map((pattern) => {
    const match = pattern.exec(APP);
    assert.ok(match, `helper ${pattern} must be findable`);
    return match[0];
  });
  const factory = new Function("state", `
    ${helpers.join("\n")}
    const isLivePortfolioMode = () => false;
    const paperStrategyIdFromMode = (mode) => mode;
    const liveOwnPortfolioPnl = () => null;
    ${source[0]}
    return portfolioRealizedRoiForMode;
  `);
  return factory({ botState: { paperPortfolios: { probe: row } } })("probe");
}

const CLOSED = (extra = {}) => ({
  status: "RESOLVED",
  realizedPnlUsdc: 1,
  totalCostUsdc: 5,
  ...extra,
});

test("a portfolio's return is computed where its trades still are", () => {
  // Three closed trades, one of them an order that never filled. The unfilled one bought
  // nothing, so it is neither profit nor capital spent -- counting its reserved notional
  // as invested would dilute the return of every portfolio that rests bids.
  const summary = evalPhp("paper_portfolio_history_summary($args)", {
    trades: [
      { status: "RESOLVED", realizedPnlUsdc: 2, totalCostUsdc: 5, openedAt: "2026-09-01T00:00:00Z" },
      { status: "RESOLVED", realizedPnlUsdc: -1, totalCostUsdc: 5, openedAt: "2026-09-02T00:00:00Z" },
      { status: "LIMIT_ORDER_EXPIRED", realizedPnlUsdc: 0, totalCostUsdc: 5, openedAt: "2026-09-03T00:00:00Z" },
      { status: "OPEN", realizedPnlUsdc: 0, totalCostUsdc: 5, openedAt: "2026-09-04T00:00:00Z" },
    ],
  });

  assert.equal(summary.closedFilledCount, 2, "the unfilled order is not a filled closed trade");
  assert.equal(summary.closedRealizedPnlUsdc, 1);
  assert.equal(summary.closedInvestedUsdc, 10, "the unfilled order's notional is not invested capital");

  // A partially filled order DID buy something, so it counts.
  const partial = evalPhp("paper_portfolio_history_summary($args)", {
    trades: [{ status: "LIMIT_ORDER_EXPIRED", partiallyFilled: true, realizedPnlUsdc: 3, totalCostUsdc: 4 }],
  });
  assert.equal(partial.closedFilledCount, 1);
  assert.equal(partial.closedInvestedUsdc, 4);
});

test("the overview row keeps its return when the trades are not loaded", () => {
  // What the overview actually receives: the summary, and no trades at all.
  const withoutTrades = browserRoi({
    trades: [],
    historySummary: { closedFilledCount: 2, closedRealizedPnlUsdc: 1, closedInvestedUsdc: 10 },
  });
  assert.ok(withoutTrades, "a row with no trades must still have a return");
  assert.equal(Math.round(withoutTrades.roi * 1000) / 1000, 0.1);
  assert.equal(withoutTrades.closedCount, 2);
  assert.equal(withoutTrades.invested, 10);

  // The selected portfolio still sums the trades it holds, which is the fresher answer
  // between one bot pass and the next.
  const withTrades = browserRoi({
    trades: [CLOSED({ realizedPnlUsdc: 4, totalCostUsdc: 8 })],
    historySummary: { closedFilledCount: 99, closedRealizedPnlUsdc: 99, closedInvestedUsdc: 99 },
  });
  assert.equal(withTrades.roi, 0.5, "the loaded trades decide, not the summary beside them");
  assert.equal(withTrades.closedCount, 1);

  // A portfolio that has closed nothing has no return to report -- absent, not zero, which
  // would rank it above every portfolio that has actually lost money.
  assert.equal(browserRoi({ trades: [], historySummary: { closedFilledCount: 0, closedInvestedUsdc: 0 } }), null);
  assert.equal(browserRoi({ trades: [] }), null, "a payload with no summary at all is not a zero return");
});

test("clicking ROI ranks every portfolio by it, across the default grouping", () => {
  const render = /function renderPortfolioOverview[\s\S]*?\n\}/.exec(APP);
  assert.ok(render, "the overview renderer must be findable");
  const block = /if \(state\.portfolioOverviewSort\?\.key === "roi"\) \{[\s\S]*?\n  \}/.exec(render[0]);
  assert.ok(block, "the ranking must live in the renderer");

  const sortRows = new Function("state", "rows", `${block[0]}\nreturn rows;`);
  const rows = () => [
    { mode: "on-losing", roi: { roi: -0.2 } },
    { mode: "off-best", roi: { roi: 0.5 } },
    { mode: "never-closed", roi: null },
    { mode: "on-middle", roi: { roi: 0.1 } },
  ];

  // Highest first, and a switched-off portfolio may outrank a running one -- comparing
  // returns means comparing all of them, or it is not a ranking.
  const desc = sortRows({ portfolioOverviewSort: { key: "roi", direction: "desc" } }, rows());
  assert.deepEqual(desc.map((row) => row.mode), ["off-best", "on-middle", "on-losing", "never-closed"]);

  // Lowest first, and the portfolio with no return stays at the bottom rather than leading
  // as if it had returned zero.
  const asc = sortRows({ portfolioOverviewSort: { key: "roi", direction: "asc" } }, rows());
  assert.deepEqual(asc.map((row) => row.mode), ["on-losing", "on-middle", "off-best", "never-closed"]);

  // Unsorted leaves the default order exactly as it was.
  const untouched = sortRows({ portfolioOverviewSort: null }, rows());
  assert.deepEqual(untouched.map((row) => row.mode), ["on-losing", "off-best", "never-closed", "on-middle"]);
});

test("the ROI header cycles highest, lowest, then back to the default order", () => {
  const handler = /const sortButton = event\.target\.closest\("\[data-overview-sort\]"\);[\s\S]*?renderPortfolioOverview\(\);/.exec(APP);
  assert.ok(handler, "the header click handler must be findable");
  const step = new Function("state", `
    const event = { target: { closest: () => ({}) } };
    const renderPortfolioOverview = () => {};
    ${handler[0]}
    return state.portfolioOverviewSort;
  `);

  const state = { portfolioOverviewSort: null };
  state.portfolioOverviewSort = step(state);
  assert.deepEqual(state.portfolioOverviewSort, { key: "roi", direction: "desc" });
  state.portfolioOverviewSort = step(state);
  assert.deepEqual(state.portfolioOverviewSort, { key: "roi", direction: "asc" });
  state.portfolioOverviewSort = step(state);
  assert.equal(state.portfolioOverviewSort, null,
    "a ranking you cannot leave is one you have to reload the page to undo");

  // And the header is a button, so it can be clicked at all.
  assert.match(APP, /data-overview-sort="roi"/);
});
