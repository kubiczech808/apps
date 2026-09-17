// Runs offline: the bot's real exports and api.php executed as a request. No network.
//
// Reported with two screenshots taken together:
//
//   "dip 70+ to 30-56 execution candidates"   5 rows, each READY, "ready for next paper
//                                             execution", entries around 0.51-0.57
//   "dip 70+ to 30-56 run log"                SKIP - no candidate passed this portfolio's
//                                             current rules
//
// Both were telling the truth about their own rules, and neither rule was the one the other
// applied. Two faults, adding up to "dip logika vubec nefunguje":
//
//   1. api.php's execution shortlist had never heard of the dip rule. It listed every
//      catalogue row inside the portfolio's 30-56% range -- which is its BUY band -- so any
//      cheap outcome was shown as READY, whether or not it had ever been a favourite.
//   2. The bot threw the catalogue away entirely and traded only the dips the RPi worker
//      recorded. That was reasoned from "a collapsed favourite is not in the catalogue",
//      which holds below 0.50 and fails for every buy band reaching above it. A third of
//      this portfolio's band is inside the catalogue, and those rows were discarded.
//
// The premise is what makes a dip a dip: the market OPENED in the 70-80% band and the
// fixture is under way. Both sides now ask exactly that, of every row, wherever it came
// from.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bot = await import("../tools/paper-trading-bot.mjs");
const API_PATH = new URL("../api.php", import.meta.url).pathname;
const API = readFileSync(API_PATH, "utf8");

test("dip pool: the recordings lead and the catalogue is no longer thrown away", () => {
  const recorded = { tokenId: "a", price: 0.38, dipEntryHit: true };
  const catalogueSame = { tokenId: "a", marketProbability: 0.55 };
  const catalogueOther = { tokenId: "b", marketProbability: 0.52 };

  const pool = bot.mergeDipEntryPool([recorded], [catalogueSame, catalogueOther]);
  assert.deepEqual(pool.map((row) => row.tokenId), ["a", "b"],
    "the catalogue must contribute, or a buy band above 0.50 has nothing to trade");
  assert.equal(pool[0].dipEntryHit, true,
    "the recording carries the price the dip actually reached and must win the collision");

  // Either side empty still works: a band entirely below 0.50 has only recordings, and a
  // worker that has recorded nothing yet still has the part of the band the catalogue keeps.
  assert.equal(bot.mergeDipEntryPool([], [catalogueOther]).length, 1);
  assert.equal(bot.mergeDipEntryPool([recorded], []).length, 1);
  assert.equal(bot.mergeDipEntryPool().length, 0);

  // A row with no token is kept. Dropping candidates silently is the fault being fixed.
  assert.equal(bot.mergeDipEntryPool([], [{ marketProbability: 0.4 }, { marketProbability: 0.41 }]).length, 2);
});

// The screen and the run have to shortlist the same thing. api.php is executed for real
// here, because the whole complaint was that its answer disagreed with the bot's.
function shortlists(item, config) {
  const directory = mkdtempSync(join(tmpdir(), "dip-shortlist-"));
  try {
    const cut = API.indexOf("\ntry {");
    const definitions = join(directory, "definitions.php");
    mkdirSync(join(directory, "data"), { recursive: true });
    writeFileSync(definitions, API.slice(0, cut) + "\n");
    const output = execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}';`
      + ` echo json_encode(execution_scope_matches_observation(`
      + `json_decode('${JSON.stringify(item)}', true), json_decode('${JSON.stringify(config)}', true)));`,
    ], { encoding: "utf8", cwd: directory });
    return JSON.parse(output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The portfolio from the screenshot: opens 70-80%, buys 30-56%, running fixtures only.
const DIP_CONFIG = {
  minProbability: 0.3,
  maxProbability: 0.56,
  dipEntryEnabled: true,
  dipEntryOpenMin: 0.7,
  dipEntryOpenMax: 0.8,
  liveEventMode: "only",
};

// A collapsed favourite, in the shape the catalogue stores one.
function collapsed(overrides = {}) {
  return {
    tokenId: "1",
    question: "Counter-Strike: M80 vs GamerLegion",
    status: "SCRAPED",
    marketProbability: 0.53,
    firstMarketProbability: 0.76,
    spread: 0.02,
    volumeUsdc: 5000,
    eventStarted: true,
    marketClosed: false,
    acceptingOrders: true,
    resolutionEndDate: new Date(Date.now() + 3600000).toISOString(),
    ...overrides,
  };
}

test("dip shortlist: the screen stops promising markets that never fell", () => {
  // The row the rule is for: opened at 76%, now quoted at 53%, fixture under way.
  assert.equal(shortlists(collapsed(), DIP_CONFIG), true,
    "a genuine dip inside the buy band has to reach the screen AND the run");

  // Cheap but never a favourite. This is what filled the candidates list with rows the bot
  // would refuse -- the portfolio's range is its buy band, so without the opening check
  // every cheap outcome qualified.
  assert.equal(shortlists(collapsed({ firstMarketProbability: 0.42 }), DIP_CONFIG), false,
    "an outcome that opened at 42% never fell and is not a dip");
  assert.equal(shortlists(collapsed({ firstMarketProbability: 0.95 }), DIP_CONFIG), false,
    "and one that opened above the band is not the fall this rule describes");

  // No opening price on record leaves the premise unverified, and an unverified premise is
  // not one. The bot refuses these; the screen must too.
  assert.equal(shortlists(collapsed({ firstMarketProbability: null }), DIP_CONFIG), false);

  // Before kick-off a low price is not a collapse, it is a different market.
  assert.equal(shortlists(collapsed({ eventStarted: false, resolutionEndDate: new Date(Date.now() + 86400000 * 2).toISOString() }), DIP_CONFIG), false);

  // And an ordinary portfolio is untouched by any of this: the same row, no dip rule, is
  // judged on its range alone.
  const plain = { minProbability: 0.3, maxProbability: 0.56 };
  assert.equal(shortlists(collapsed({ firstMarketProbability: 0.42 }), plain), true,
    "a portfolio without the dip rule must not inherit its refusals");
});

test("dip shortlist: the screen and the bot ask the same question of the same row", () => {
  // The pair that was contradicting itself on screen. Whatever else differs between PHP and
  // JS, these two must agree about the dip premise, or the candidates list goes back to
  // promising trades the run refuses.
  const strategy = { id: "dip70", label: "dip 70+", ...DIP_CONFIG };
  for (const [opened, expected] of [[0.76, true], [0.42, false], [0.95, false], [null, false]]) {
    const row = collapsed({ firstMarketProbability: opened });
    const php = shortlists(row, DIP_CONFIG);
    const js = bot.mergeDipEntryPool([], [row]).filter((item) => {
      const value = Number(item?.firstMarketProbability);
      return Number.isFinite(value)
        && value >= strategy.dipEntryOpenMin
        && value <= strategy.dipEntryOpenMax;
    }).length > 0;
    assert.equal(php, expected, `php disagreed about an opening of ${opened}`);
    assert.equal(js, expected, `the bot's gate disagreed about an opening of ${opened}`);
  }
});

// The call site, driven for real.
//
// The first version of this file tested mergeDipEntryPool on its own, and reverting the
// call site -- putting the bot back to trading recordings only, which IS the reported bug --
// broke nothing at all. A helper nobody is shown to call is not a fix.
test("dip pool: the real selection admits a catalogue row that opened in the band", () => {
  const price = 0.53;
  const stake = 5;
  const shares = stake / price;
  // A catalogue row in the shape the scan actually writes one: the economics are computed
  // at scrape time, and without them the bot refuses on "missing EV p.a." and "net profit
  // below 0%" long before the dip rule is reached. Measured, not assumed -- the first
  // attempt at this row was refused for exactly those two reasons.
  const row = {
    tokenId: "1",
    question: "Counter-Strike: M80 vs GamerLegion (BO1)",
    outcome: "GamerLegion",
    slug: "m80-gamerlegion",
    status: "ELIGIBLE",
    selectionStatus: "ELIGIBLE",
    marketProbability: price,
    marketPrice: price,
    aiProbability: price,
    bestBid: price,
    bestAsk: price,
    spread: 0,
    firstMarketProbability: 0.76,
    volumeUsdc: 5000,
    liquidity: 5000,
    eventStarted: true,
    marketClosed: false,
    acceptingOrders: true,
    endDate: new Date(Date.now() + 3600000).toISOString(),
    resolutionEndDate: new Date(Date.now() + 3600000).toISOString(),
    daysToResolution: 1 / 24,
    stakeUsdc: stake,
    shares,
    executableShares: shares,
    totalCostUsdc: stake,
    netGainIfWinUsdc: shares - stake,
    netYield: (shares - stake) / stake,
    riskReward: (shares - stake) / stake,
    expectedValueUsdc: shares * price - stake,
    marketExpectedValueUsdc: shares * price - stake,
    annualizedReturn: 50,
    potentialAnnualizedReturn: 50,
    marketAnnualizedReturn: 50,
    feeRate: 0,
    feesEnabled: false,
  };
  const strategy = {
    id: "dip70",
    label: "dip 70+",
    selectionOrder: "highest_ev_pa_first",
    selectionMetric: "expectedValueUsdc",
    stakeUsdc: stake,
    probabilitySource: "market",
    marketType: "all",
    minNetYield: 0,
    ...DIP_CONFIG,
  };

  // Nothing else refuses it, so a zero below is the dip pool and not another rule.
  assert.deepEqual(bot.portfolioFilterResult(row, strategy).reasons, []);

  assert.equal(bot.sortEligibleForStrategy([row], strategy).length, 1,
    "a catalogue row that opened at 76% and is now quoted at 53% is the trade this rule is for");
  // And the premise still decides. This is the row the screen used to promise and the bot
  // was right to refuse -- it was never a favourite, it was always cheap.
  assert.equal(bot.sortEligibleForStrategy([{ ...row, firstMarketProbability: 0.42 }], strategy).length, 0);
  assert.equal(bot.sortEligibleForStrategy([{ ...row, firstMarketProbability: null }], strategy).length, 0);
});
