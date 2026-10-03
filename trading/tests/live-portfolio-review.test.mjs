// Runs offline: the review's own functions, executed, and the whole tool against a local
// stand-in for the host. No network, no credentials.
//
// What can go wrong here is a count that looks like evidence and is not: trades from before
// the rule changed counted for the new rule, a "twin" that differs in its band, one market
// counted once per portfolio that bought it. One test each.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  dipBacktest,
  evidence,
  liveCandidates,
  openedSince,
  resolvedRows,
  rulePeers,
  ruleSignature,
  settingsSince,
  signatureDiff,
} from "../tools/live-portfolio-review.mjs";

const DIP = {
  displayName: "dip 70+ ->45-56 live", dipEntryEnabled: true, dipEntryOpenMin: 0.65, dipEntryOpenMax: 0.999,
  minProbability: 0.45, maxProbability: 0.56, excludedMarketShapes: ["other", "spread"],
  includeOnlyMarketTags: ["tennis"], stakeUsdc: 5, automationEnabled: true,
};

test("ruleSignature: one rule saved two ways reads the same", () => {
  const typed = ruleSignature({ ...DIP, dipEntryOpenMin: 65, minProbability: "45", maxProbability: 56,
    excludedMarketShapes: ["Spread", "other"], liveEventMode: "" });
  assert.deepEqual(typed, ruleSignature(DIP), "percent or fraction, set order and case, empty or missing");
  assert.deepEqual(ruleSignature({ excludeOverUnderMarkets: true }).excludedMarketShapes, ["over-under"],
    "the legacy over-under switch is an excluded shape");
  assert.equal(ruleSignature({ maxResolutionDays: 2 }).maxResolutionHours, 48, "days read as hours");
  assert.equal(ruleSignature({ dipEntryOpenMin: 0.7 }).dipEntryOpenMin, null, "an opening band means nothing without the dip rule");
});

test("signatureDiff: the stake, the name and the switch are not the rule; the band is", () => {
  const sameRule = { ...DIP, displayName: "other name", stakeUsdc: 10, automationEnabled: false, archived: true };
  assert.deepEqual(signatureDiff(ruleSignature(DIP), ruleSignature(sameRule)), []);
  assert.deepEqual(signatureDiff(ruleSignature(DIP), ruleSignature({ ...DIP, maxProbability: 0.6 })), ["maxProbability"]);
  assert.deepEqual(signatureDiff(ruleSignature(DIP), ruleSignature({ ...DIP, excludedMarketShapes: ["other"] })), ["excludedMarketShapes"]);
});

test("liveCandidates: every live portfolio not archived, under the ids its trades and history use", () => {
  const candidates = liveCandidates({
    livePortfolios: { dip704060live: DIP, old: { ...DIP, archived: true } },
    live: { minProbability: 0.9 },
    live5050: { archived: true },
    paper: { dip70: DIP },
  });
  assert.deepEqual(candidates.map(({ mode, historyId }) => [mode, historyId]),
    [["live-custom-dip704060live", "live-custom-dip704060live"], ["live", "live"]]);
});

test("settingsSince: the last change to a RULE field of THIS portfolio, or a stated lower bound", () => {
  const records = [
    { changedAt: "2026-09-20T10:00:00Z", changes: [{ strategyId: "live-custom-a", field: "maxProbability" }] },
    { changedAt: "2026-09-30T13:30:00Z", changes: [
      { strategyId: "live-custom-a", field: "dipEntryOpenMin" }, { strategyId: "live-custom-a", field: "excludedMarketShapes" }] },
    { changedAt: "2026-10-01T09:00:00Z", changes: [{ strategyId: "live-custom-a", field: "stakeUsdc" }] },
    { changedAt: "2026-10-02T09:00:00Z", changes: [{ strategyId: "live-custom-a", field: "displayName" }] },
    { changedAt: "2026-10-02T10:00:00Z", changes: [{ strategyId: "live-custom-b", field: "minProbability" }] },
  ];
  assert.deepEqual(settingsSince(records, "live-custom-a"),
    { since: "2026-09-30T13:30:00Z", lowerBound: false, fields: ["dipEntryOpenMin", "excludedMarketShapes"] },
    "a new stake or name does not restart the evidence, another portfolio's change is not this one's");
  assert.deepEqual(settingsSince(records, "live-custom-none"), { since: "2026-09-20T10:00:00Z", lowerBound: true, fields: [] });
});

test("openedSince and resolvedRows: only resolved trades opened under the current rule count", () => {
  const rows = resolvedRows([
    { tokenId: "1", status: "REDEEMED", realizedPnlUsdc: 4, openedAt: "2026-09-29T10:00:00Z" },
    { tokenId: "2", status: "WON", pnlUsdc: 4, openedAt: "2026-10-01T10:00:00Z" },
    { tokenId: "3", status: "OPEN", realizedPnlUsdc: null, openedAt: "2026-10-01T11:00:00Z" },
    { tokenId: "4", status: "LOST", realizedPnlUsdc: -5 },
  ]);
  assert.deepEqual(rows.map((row) => row.tokenId), ["1", "2", "4"], "an open position is not a result");
  assert.equal(rows[1].realizedPnlUsdc, 4, "the older pnl field is read too");
  assert.deepEqual(openedSince(rows, "2026-09-30T13:30:00Z").map((row) => row.tokenId), ["2"],
    "before the change, or with no opening time, it is not evidence for this rule");
});

test("evidence: a market three portfolios bought is one market", () => {
  const trade = (portfolioId) => ({ tokenId: "9", portfolioId, realizedPnlUsdc: 4, totalCostUsdc: 5, openedAt: "2026-10-01T10:00:00Z" });
  const item = evidence([trade("a"), trade("b"), trade("c"), { tokenId: "8", realizedPnlUsdc: -5, totalCostUsdc: 5, openedAt: "2026-10-01T10:00:00Z" }]);
  assert.equal(item.rows, 4);
  assert.equal(item.markets, 2);
  assert.equal(item.wins, 1);
  assert.equal(item.pnl, -1);
});

test("rulePeers: an identical rule is a twin, a different band is only near, a different kind is neither", () => {
  const peers = rulePeers(DIP, {
    twin: { ...DIP, displayName: "paper", stakeUsdc: 1 },
    wider: { ...DIP, maxProbability: 0.6 },
    plain: { minProbability: 0.45, maxProbability: 0.56 },
  });
  assert.deepEqual(peers.exact.map((peer) => peer.id), ["twin"]);
  assert.deepEqual(peers.near.map((peer) => [peer.id, peer.diff]), [["wider", ["maxProbability"]]]);
});

function cacheRow(index, { opening = 0.8, price = 0.53, won = true, question = `Player ${index} vs Rival ${index}` } = {}) {
  return {
    tokenId: `t${index}`, question, outcome: `Player ${index}`, slug: `atp-p${index}`, status: "complete", usableOpening: true,
    openingInBand: true, openingPrice: opening, resolvedAt: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T12:00:00Z`,
    entries: { 0.55: { enteredAt: "2026-09-01T12:00:00Z", entryPrice: price, feeUsdc: 0, pnlUsdc: won ? 5 / price - 5 : -5, outcome: won ? "WIN" : "LOSS" } },
  };
}

test("dipBacktest: the current rule replayed exactly, and a better band named only past the market minimum", () => {
  // 30 markets opening 70+ and 30 opening 66%: the current 65+ rule sees all 60, a 70+ rule 30.
  const rows = [
    ...Array.from({ length: 30 }, (_, index) => cacheRow(index, { opening: 0.8, won: index % 5 !== 0 })),
    ...Array.from({ length: 30 }, (_, index) => cacheRow(100 + index, { opening: 0.66, won: index % 3 !== 0 })),
  ];
  const result = dipBacktest(new Map([["tennis", rows]]), DIP);
  assert.equal(result.clean.trades, 60, "every market the 65-99 / 45-56 rule takes");
  assert.equal(result.best.stats.trades >= 50, true, "only a cell with 50+ markets may be recommended");
  assert.equal(result.best.current, true, "here the current cell is the best qualifying one");
  const narrow = dipBacktest(new Map([["tennis", rows.slice(0, 30)]]), DIP);
  assert.equal(narrow.best, null, "with 30 markets nothing qualifies, however good it looks");
});

test("dipBacktest: a better band with 50+ markets is named when the current one loses money it does not need to", () => {
  // 60 favourites that opened at 80% all came back; 30 that opened at 66% all lost.
  const rows = [
    ...Array.from({ length: 60 }, (_, index) => cacheRow(index, { opening: 0.8, won: true })),
    ...Array.from({ length: 30 }, (_, index) => cacheRow(100 + index, { opening: 0.66, won: false })),
  ];
  const result = dipBacktest(new Map([["tennis", rows]]), DIP);
  assert.equal(result.current.clean.length, 90, "the current 65+ rule takes all 90");
  assert.deepEqual(result.best.open, [0.7, 0.99], "70+ leaves the 66% openers out");
  assert.equal(result.best.current, false);
  assert.equal(result.best.stats.trades, 60);
});

// The whole tool against a local stand-in for the host. The live portfolio changed its rule
// on 2026-09-30; two of its three trades predate that and must not count for the new rule.
test("end to end: evidence counts only the current rule, twins add their markets, the summary closes the log", async () => {
  const config = {
    livePortfolios: { dip704060live: DIP, gone: { ...DIP, archived: true } },
    paper: { twin: { ...DIP, displayName: "paper twin", stakeUsdc: 1 }, wider: { ...DIP, maxProbability: 0.6 } },
  };
  const history = { records: [
    { changedAt: "2026-09-30T13:30:00Z", changes: [{ strategyId: "live-custom-dip704060live", field: "dipEntryOpenMin" }] },
    { changedAt: "2026-09-25T08:00:00Z", changes: [{ strategyId: "twin", field: "minProbability" }] },
  ] };
  const closedTrades = [
    { tokenId: "a", status: "REDEEMED", realizedPnlUsdc: -4.88, totalCostUsdc: 5, openedAt: "2026-09-30T04:39:29Z", portfolioId: "live-custom-dip704060live" },
    { tokenId: "b", status: "REDEEMED", realizedPnlUsdc: 4.1, totalCostUsdc: 5, openedAt: "2026-09-28T10:00:00Z", portfolioId: "live-custom-dip704060live" },
    { tokenId: "c", status: "REDEEMED", realizedPnlUsdc: 4.2, totalCostUsdc: 5, openedAt: "2026-10-01T10:00:00Z", portfolioId: "live-custom-dip704060live" },
    { tokenId: "z", status: "REDEEMED", realizedPnlUsdc: 1, totalCostUsdc: 5, openedAt: "2026-10-01T10:00:00Z", portfolioId: "live" },
  ];
  const paperTrades = {
    twin: [
      { tokenId: "c", status: "WON", realizedPnlUsdc: 4.2, totalCostUsdc: 5, openedAt: "2026-10-01T10:01:00Z" },
      { tokenId: "d", status: "LOST", realizedPnlUsdc: -5, totalCostUsdc: 5, openedAt: "2026-10-02T10:00:00Z" },
      { tokenId: "e", status: "WON", realizedPnlUsdc: 4, totalCostUsdc: 5, openedAt: "2026-09-20T10:00:00Z" },
    ],
    wider: [{ tokenId: "f", status: "WON", realizedPnlUsdc: 3, totalCostUsdc: 5, openedAt: "2026-10-02T10:00:00Z" }],
  };
  const cache = { markets: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`t${index}`, cacheRow(index)])) };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://local");
    const action = url.searchParams.get("action");
    let body = null;
    if (action === "portfolio-config") body = { config };
    else if (action === "portfolio-config-history") body = history;
    else if (action === "state" && url.searchParams.get("target") === "live") body = { closedTrades };
    else if (action === "state" && url.searchParams.get("target") === "paper") {
      const id = url.searchParams.get("strategy_id");
      body = { state: { paperPortfolios: { [id]: { trades: [], closedTrades: paperTrades[id] || [] } } } };
    } else if (url.pathname.endsWith("/data/dip-backtest-tennis-cache.json")) body = cache;
    response.statusCode = body ? 200 : 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const tool = fileURLToPath(new URL("../tools/live-portfolio-review.mjs", import.meta.url));
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tool], { env: {
        PATH: process.env.PATH, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
        TRADING_HOST: `http://127.0.0.1:${server.address().port}`,
      } });
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.stderr.on("data", (chunk) => { text += chunk; });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}: ${text}`))));
    });
    assert.match(output, /live portfolios not archived: 1/, "the archived one is not reviewed");
    assert.match(output, /rule unchanged since 2026-09-30T13:30:00Z \(changed: dipEntryOpenMin\)/);
    assert.match(output, /live, all time \(any rule\)\s+3 markets/);
    assert.match(output, /live, under this exact rule\s+1 markets/, "the two trades before the change are not this rule's");
    assert.match(output, /paper twin twin\s+2 markets/, "the twin's trade from before ITS change is dropped too");
    assert.match(output, /REAL, this rule \(live \+ twins\)\s+2 markets/, "market c, bought live and by the twin, counts once");
    assert.match(output, /backtest \[tennis\], all\s+12 markets/);
    assert.match(output, /no band pair in the grid reaches 50 clean markets/);
    assert.match(output, /near: paper wider \[maxProbability\]/);
    const summary = output.slice(output.lastIndexOf("=== summary"));
    assert.match(summary, /live-custom-dip704060live\s+real\s+2 /);
  } finally {
    server.close();
  }
});
