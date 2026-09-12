// Runs offline: no secrets, no network, no hosting.
//
// 2026-09-12, run #7078. The bot read a state in which all 36 paper portfolios existed with
// their correct names and parameters and not one of them held a trade. It opened fresh
// positions against free=100 on every portfolio -- its own run digest says so, line after
// line -- and published that over the hosting thirty seconds later. Every trade from before
// 08:54:03Z was gone from the published files; 6,447 of them survive only because the
// database mirror upserts and never deletes.
//
// Every individual read path was already fail-closed: a 500 throws, an unreadable segment
// throws, a 404 on a portfolio segment throws. None of them covers a read that SUCCEEDS and
// comes back empty, and that is the one that happened.
//
// So these drive readState() for real, with fetch stubbed, and assert on what it does with
// an empty answer.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOT_URL = new URL("../tools/paper-trading-bot.mjs", import.meta.url);

// A state shaped exactly like the one that was read: portfolios present, trades absent.
function emptyState(portfolioCount = 36) {
  const paperPortfolios = {};
  for (let index = 0; index < portfolioCount; index += 1) {
    paperPortfolios[`portfolio${index}`] = {
      displayName: `Portfolio ${index}`,
      portfolio: { equityUsdc: 100, freeCapitalUsdc: 100, openRiskUsdc: 0 },
      trades: [],
    };
  }
  return { schemaVersion: 7, generatedAt: "2026-09-12T08:53:50.000Z", trades: [], paperPortfolios };
}

function stateWithTrades() {
  const state = emptyState(36);
  state.paperPortfolios.portfolio0.trades = [
    { openedAt: "2026-09-08T11:58:44.000Z", status: "WON", tokenId: "1", slug: "a" },
  ];
  return state;
}

// readState() with the network stubbed. The module is imported fresh each time because it
// reads its configuration into consts at load.
async function readStateWith({ state, allowEmpty = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "empty-state-"));
  const output = join(directory, "paper-state.json");
  const previousFetch = globalThis.fetch;
  const previous = {
    url: process.env.PAPER_STATE_URL,
    out: process.env.PAPER_OUTPUT_PATH,
    allow: process.env.PAPER_ALLOW_EMPTY_STATE,
    segments: process.env.PAPER_STATE_SEGMENT_BASE_URL,
    statik: process.env.PAPER_STATIC_STATE_URL,
    execution: process.env.PAPER_EXECUTION_PASS,
  };
  try {
    writeFileSync(output, JSON.stringify({ schemaVersion: 7, paperPortfolios: {} }));
    process.env.PAPER_STATE_URL = "https://example.invalid/api.php?action=state&target=paper&summary=refresh";
    process.env.PAPER_OUTPUT_PATH = output;
    process.env.PAPER_ALLOW_EMPTY_STATE = allowEmpty ? "true" : "false";
    delete process.env.PAPER_STATE_SEGMENT_BASE_URL;
    delete process.env.PAPER_STATIC_STATE_URL;
    delete process.env.PAPER_EXECUTION_PASS;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => state,
      text: async () => JSON.stringify(state),
    });
    // A cache-busting query so each case gets its own module instance.
    const bot = await import(`${BOT_URL.href}?empty-state-case=${Math.random()}`);
    return { value: await bot.readStateForTests(), error: null };
  } catch (error) {
    return { value: null, error };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries({
      PAPER_STATE_URL: previous.url,
      PAPER_OUTPUT_PATH: previous.out,
      PAPER_ALLOW_EMPTY_STATE: previous.allow,
      PAPER_STATE_SEGMENT_BASE_URL: previous.segments,
      PAPER_STATIC_STATE_URL: previous.statik,
      PAPER_EXECUTION_PASS: previous.execution,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a successful read that comes back empty stops the run", async () => {
  // The read that actually happened. Nothing failed: HTTP 200, every portfolio present,
  // every trade gone.
  const { value, error } = await readStateWith({ state: emptyState(36) });
  assert.equal(value, null, "an empty state must not be handed back as something to trade from");
  assert.ok(error, "it has to throw: returning it is what published the emptiness");
  assert.match(String(error.message), /36 paper portfolios and no trades/,
    `the refusal must name what it saw: ${error.message}`);

  // And it must be THE error, not one wrapped in a different explanation.
  //
  // This assertion exists because of a bait that did not fail: removing the rethrows that
  // let the refusal escape readState's two fallback catches broke nothing, since the run
  // still ended up failing closed -- with a message saying the published state was
  // "unavailable". It was not unavailable. It answered, completely and instantly, with
  // nothing in it, and on the morning this happens the message is the only thing telling
  // whoever reads it which of those two it was.
  assert.ok(String(error.message).startsWith("Refusing to continue: the state read from"),
    `the refusal must not be relabelled as a transport failure: ${error.message}`);
  assert.doesNotMatch(String(error.message), /unavailable/,
    "an empty answer is not an absent one, and the two need different fixes");
});

test("one surviving trade is enough to make the state credible again", async () => {
  // The guard is about "no trades ANYWHERE", not about any particular portfolio being
  // empty -- most portfolios legitimately hold nothing most of the time.
  const { value, error } = await readStateWith({ state: stateWithTrades() });
  assert.equal(error, null, `a state with history must pass: ${error?.message}`);
  assert.ok(value?.paperPortfolios, "and it must come back assembled");
  assert.equal(value.paperPortfolios.portfolio0.trades.length, 1);
});

test("a new installation is not an emptied one", async () => {
  // One portfolio and no trades is a real state on day one. Thirty-six is not.
  const { error } = await readStateWith({ state: emptyState(1) });
  assert.equal(error, null, `a single fresh portfolio must not be refused: ${error?.message}`);
});

test("the refusal can be overridden on purpose, and only on purpose", async () => {
  // Portfolios really can be reset deliberately. That has to be sayable, out loud, in the
  // run that does it -- and never the default.
  const { value, error } = await readStateWith({ state: emptyState(36), allowEmpty: true });
  assert.equal(error, null, `the opt-out must work: ${error?.message}`);
  // At least the 36 that were sent -- normalizeState also adds the four built-in defaults,
  // which is exactly why the guard judges the payload rather than the normalized state.
  assert.ok(Object.keys(value.paperPortfolios).length >= 36,
    `the state must still come back whole: ${Object.keys(value.paperPortfolios).length}`);
});
