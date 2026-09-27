// Runs offline: the two sports passes are executed with Gamma stubbed, and the requests they
// would send are inspected. No network.
//
// Measured on the settled archive and reported from the candidates list: soccer rows were
// first seen 1.0 to 4.5 hours AFTER their own kickoff -- every one of them inside the
// six-hour grace scanEventRequestParams adds -- while fixtures starting later the same day
// were never reached at all. Ordered by endDate ascending, that grace puts already-running
// matches at the front of the pre-start page, and on a busy afternoon there are more of them
// than the page holds. A pre-start pass whose page is full of started matches captures
// nothing it exists to capture, and the settled statistics then have no pre-kickoff soccer
// to measure.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const BOT = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist`);
  // Keep the `async` keyword. Slicing from `function` alone drops it, and the body's own
  // `await` then fails to parse -- which is a broken harness reported as a broken function.
  if (source.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} must be a complete function`);
  return source.slice(start, end + 2);
}

// The deployed request builders, with only the constants and the fetch they lean on stubbed.
function harness({ maxDays = 7, graceHours = 6, windowHours = 12, batchLimit = 150 } = {}) {
  const factory = new Function(`
    const MARKET_SCAN_MAX_DAYS = ${maxDays};
    const MARKET_SCAN_END_DATE_GRACE_HOURS = ${graceHours};
    const MARKET_SCAN_LIQUIDITY_MIN = 40000;
    const MARKET_SCAN_LIVE_WINDOW_HOURS = ${windowHours};
    const MARKET_SCAN_EVENT_BATCH_LIMIT = ${batchLimit};
    const MARKET_SCAN_CATEGORY_TAGS = [{ id: "1", slug: "sports" }, { id: "64", slug: "esports" }];
    const MARKET_SCAN_LIVE_TAG_SLUGS = ["sports", "esports"];
    const sent = [];
    const annotateCategoryScanMarkets = (batch) => batch;
    const loadEventMarketScanBatch = async (params, meta) => {
      sent.push({ params: scanEventRequestParams(params), scope: meta?.scope, category: meta?.category });
      return [];
    };
    ${extractFunction(BOT, "scanEventRequestParams")}
    ${extractFunction(BOT, "marketScanLiveTags")}
    ${extractFunction(BOT, "loadLiveMarketScanBatch")}
    ${extractFunction(BOT, "loadImminentDipMarketScanBatch")}
    return { sent, loadLiveMarketScanBatch, loadImminentDipMarketScanBatch };
  `);
  return factory();
}

test("the pre-start pass asks only for fixtures that have not started", () => {
  const bot = harness();
  const before = Date.now();
  return bot.loadImminentDipMarketScanBatch().then(() => {
    const after = Date.now();
    assert.equal(bot.sent.length, 2, "one request per live tag, and no more: this runs every scrape");
    for (const { params, scope, category } of bot.sent) {
      assert.equal(scope, "dip_prestart");
      assert.ok(["sports", "esports"].includes(category));
      const min = Date.parse(params.end_date_min);
      assert.ok(min >= before && min <= after,
        `the window must start at now, not in the past: ${params.end_date_min}`);
      // Ordered soonest-first, so the page holds the next kickoffs rather than any kickoffs.
      assert.equal(params.order, "endDate");
      assert.equal(params.ascending, "true");
      // And it is still bounded by the same 12-hour horizon.
      const max = Date.parse(params.end_date_max);
      assert.ok(max - after > 11.5 * 3600000 && max - after <= 12.5 * 3600000);
      assert.ok(!("live" in params), "the pre-start half must not ask for live markets");
    }
  });
});

test("the live pass keeps the grace, because a match just ended can still be trading", () => {
  const bot = harness();
  const before = Date.now();
  return bot.loadLiveMarketScanBatch().then(() => {
    assert.equal(bot.sent.length, 2);
    for (const { params, scope } of bot.sent) {
      assert.equal(scope, "live");
      assert.equal(params.live, "true");
      const min = Date.parse(params.end_date_min);
      assert.ok(before - min > 5.5 * 3600000 && before - min <= 6.5 * 3600000,
        `the live pass must still reach back six hours: ${params.end_date_min}`);
    }
  });
});

test("neither pass costs more requests than before, and neither touches the rotation", () => {
  // The constraint the change had to respect: limited hardware, and an esports cadence that
  // works. Two bounded calls per pass, per tag, exactly as before -- the only thing that
  // moved is which fixtures land on the pre-start page.
  const bot = harness({ batchLimit: 150 });
  return bot.loadImminentDipMarketScanBatch()
    .then(() => bot.loadLiveMarketScanBatch())
    .then(() => {
      assert.equal(bot.sent.length, 4, "two passes, two tags, one request each");
      for (const { params } of bot.sent) {
        assert.equal(params.limit, 150, "the page size is untouched");
        assert.ok(!("liquidity_min" in params), "and both still opt out of the rotation's floor");
      }
    });
});
