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
    // A collapsed favourite was, by definition, seen BEFORE the fixture began -- that is
    // what makes 0.76 an OPENING price rather than a mid-game one. The fixture carried
    // neither time while nothing read them, so it stood for a row the rule must now refuse.
    // Both relative, so this cannot rot into a fixed date the way two resolution dates in
    // this suite already have.
    firstObservedAt: new Date(Date.now() - 6 * 3600000).toISOString(),
    eventStartTime: new Date(Date.now() - 3600000).toISOString(),
    marketClosed: false,
    acceptingOrders: true,
    resolutionEndDate: new Date(Date.now() + 3600000).toISOString(),
    ...overrides,
  };
}

// The reported defect, as a fixture: same numbers, but the row was first met AFTER kickoff,
// so its "opening" price is a mid-game one. Reported 2026-09-20 with a Marlins-Padres market
// that traded 50/50 for a week and was recorded as "opened at 75%" because the scan first
// saw it at 6-6 in extra innings.
const metMidGame = (overrides = {}) => collapsed({
  firstObservedAt: new Date(Date.now() - 1800000).toISOString(),
  eventStartTime: new Date(Date.now() - 3600000).toISOString(),
  ...overrides,
});

test("dip shortlist: the screen stops promising markets that never fell", () => {
  // The row the rule is for: opened at 76%, now quoted at 53%, fixture under way.
  assert.equal(shortlists(collapsed(), DIP_CONFIG), true,
    "a genuine dip inside the buy band has to reach the screen AND the run");

  // Cheap but never a favourite. This is what filled the candidates list with rows the bot
  // would refuse -- the portfolio's range is its buy band, so without the opening check
  // every cheap outcome qualified.
  assert.equal(shortlists(collapsed({ firstMarketProbability: 0.42 }), DIP_CONFIG), false,
    "an outcome that opened at 42% never fell and is not a dip");

  // The reported one, and the reason this whole check exists: the number is inside the band
  // and still means nothing, because it was not an opening price.
  assert.equal(shortlists(metMidGame(), DIP_CONFIG), false,
    "a 76% quote first taken after kickoff is a mid-game price, not an opening one");
  // Neither time known is also a refusal. The premise rests entirely on this one fact, and
  // an unverified premise is not one.
  assert.equal(shortlists(collapsed({ firstObservedAt: null, eventStartTime: null }), DIP_CONFIG), false,
    "with no first-seen time and no kickoff the premise cannot be checked at all");
  assert.equal(shortlists(collapsed({ firstMarketProbability: 0.95 }), DIP_CONFIG), false,
    "and one that opened above the band is not the fall this rule describes");

  // No opening price on record leaves the premise unverified, and an unverified premise is
  // not one. The bot refuses these; the screen must too.
  assert.equal(shortlists(collapsed({ firstMarketProbability: null }), DIP_CONFIG), false);

  // Before kick-off a low price is not a collapse, it is a different market.
  // The kickoff has to move with it: eventStartTime is what decides "under way", and leaving
  // it in the past while setting eventStarted false describes two different fixtures.
  assert.equal(shortlists(collapsed({
    eventStarted: false,
    eventStartTime: new Date(Date.now() + 3600000).toISOString(),
    resolutionEndDate: new Date(Date.now() + 86400000 * 2).toISOString(),
  }), DIP_CONFIG), false);

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
    // Seen before kickoff, which is what makes 0.76 an OPENING price. Without these two the
    // row is refused now, and rightly: a 76% quote first taken mid-fixture is a mid-game
    // price, which is the defect these times were added to catch.
    firstObservedAt: new Date(Date.now() - 6 * 3600000).toISOString(),
    eventStartTime: new Date(Date.now() - 3600000).toISOString(),
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

  // THE BOT'S OWN GATE, on a mid-game price. Added because deleting this check from
  // strategyEligibleCandidates broke nothing: the PHP shortlist and the reference rule each
  // had a test and the one layer that actually opens paper positions had none. A bait that
  // does not fail is a finding.
  //
  // Reported 2026-09-20 with two screenshots. A Marlins-Padres market traded 50/50 for a
  // week; at 6-6 in extra innings the Padres side was momentarily 75%, the scan met it
  // there, and that became "where this market opened". It never was the favourite.
  // "DIP ENTRY je range kde se trh musi nachazet na zacatku."
  const midGame = {
    ...row,
    firstObservedAt: new Date(Date.now() - 1800000).toISOString(),
    eventStartTime: new Date(Date.now() - 3600000).toISOString(),
  };
  assert.deepEqual(bot.portfolioFilterResult(midGame, strategy).reasons, [],
    "nothing else refuses it either, so the zero below is this check and no other");
  assert.equal(bot.sortEligibleForStrategy([midGame], strategy).length, 0,
    "a 76% quote first taken after kickoff is a mid-game price, not an opening one");

  // Unknowable is also a refusal: the whole rule rests on this one fact.
  assert.equal(bot.sortEligibleForStrategy([{ ...row, firstObservedAt: null }], strategy).length, 0);
  assert.equal(bot.sortEligibleForStrategy([{ ...row, eventStartTime: null }], strategy).length, 0);

  // And an ordinary portfolio inherits none of it.
  const plain = { ...strategy, dipEntryEnabled: false, minProbability: 0.3, maxProbability: 0.56 };
  assert.equal(bot.sortEligibleForStrategy([midGame], plain).length, 1,
    "only a dip portfolio asks where the market opened");
});

// Measured on paper-dip70 and paper-dip70live, 2026-09-19, with the record-side guard
// already deployed:
//
//   token 1359914012738562...  "Counter-Strike: 3DMAX vs M80 - Map 2 Winner"
//      WON   opened 16:36:08  entry 54.0%  mark 100.0%  pnl +4.26
//      OPEN  opened 18:29:50  entry 54.0%  mark  54.0%  pnl  0.00
//
// The market RESOLVED and the same token was bought again two hours later. Reported as
// "stejny trh se opakuje v kazdem poslednim execution behu. je jak v otevrenych pozicich,
// tak i v zavrenych."
//
// The guard inside dipEntryCandidateRows could not stop it: mergeDipEntryPool adds ordinary
// CATALOGUE rows to a dip portfolio's pool and those never pass through that builder. So
// the rule has to sit on the pool, after the merge, where both halves are in one list.
test("a dip portfolio never rebuys a market it has already traded, catalogue row or recorded hit", async () => {
  const bot = await import("../tools/paper-trading-bot.mjs");
  const price = 0.54;
  const shares = 5 / price;
  const row = (tokenId) => ({
    tokenId, question: `market ${tokenId}`, outcome: "Yes",
    status: "ELIGIBLE", selectionStatus: "ELIGIBLE",
    marketProbability: price, marketPrice: price, aiProbability: price,
    bestBid: price, bestAsk: price, spread: 0, volumeUsdc: 5000, liquidity: 5000,
    // The premise the dip gate checks, so these rows are admissible on every other ground
    // and the traded-token rule is the only thing that can refuse them.
    firstMarketProbability: 0.78, eventStarted: true,
    firstObservedAt: new Date(Date.now() - 6 * 3600000).toISOString(),
    eventStartTime: new Date(Date.now() - 3600000).toISOString(),
    marketClosed: false, acceptingOrders: true,
    endDate: new Date(Date.now() + 3600000).toISOString(),
    resolutionEndDate: new Date(Date.now() + 3600000).toISOString(), daysToResolution: 1 / 24,
    stakeUsdc: 5, shares, executableShares: shares, totalCostUsdc: 5,
    netGainIfWinUsdc: shares - 5, netYield: (shares - 5) / 5, riskReward: (shares - 5) / 5,
    expectedValueUsdc: shares * price - 5, marketExpectedValueUsdc: shares * price - 5,
    annualizedReturn: 50, potentialAnnualizedReturn: 50, marketAnnualizedReturn: 50,
    feeRate: 0, feesEnabled: false,
  });
  const dip = {
    id: "dip70", label: "dip", selectionOrder: "highest_ev_pa_first",
    selectionMetric: "expectedValueUsdc", stakeUsdc: 5, probabilitySource: "market",
    marketType: "all", minNetYield: 0, minProbability: 0.3, maxProbability: 0.56,
    liveEventMode: "only", dipEntryEnabled: true, dipEntryOpenMin: 0.7, dipEntryOpenMax: 0.99,
  };
  const catalogue = [row("already-won"), row("never-traded")];

  // Without the memory both get through, which is what makes the assertion below mean
  // something rather than passing on an empty pool.
  assert.equal(bot.sortEligibleForStrategy(catalogue, dip).length, 2);

  // The token whose position RESOLVED is the reported case: alreadyOpen() lets it back the
  // moment the trade leaves OPEN, and WON is exactly that.
  const traded = bot.tradedTokenIdSet({
    trades: [{ tokenId: "already-won", status: "WON", realizedPnlUsdc: 4.26 }],
  });
  const rows = bot.sortEligibleForStrategy(catalogue, dip, traded);
  assert.deepEqual(rows.map((item) => item.tokenId), ["never-traded"],
    "a resolved market must not come back through the catalogue half of the pool");

  // And an ordinary portfolio is untouched: re-entering a market it once held is rotation
  // working as intended, not a defect, so the rule is the dip rule's alone.
  const plain = { ...dip, dipEntryEnabled: false };
  assert.equal(bot.sortEligibleForStrategy(catalogue, plain, traded).length, 2,
    "only a dip portfolio has one-position-per-market-ever");
});
