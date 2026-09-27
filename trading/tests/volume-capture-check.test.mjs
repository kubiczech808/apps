// Runs offline. The check's two pure reductions, plus the pairing between the fields it
// looks for and the fields the bot actually reads -- which is the whole point of it.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fieldPresence, storedCoverage, VOLUME_SOURCE_FIELDS } from "../tools/volume-capture-check.mjs";

const BOT = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");

test("the fields it probes are the fields the scan reads", () => {
  // marketVolumeSnapshotUsdc's ladder, and the two read straight off the market object.
  assert.match(BOT, /for \(const candidate of \[market\.volumeNum, market\.volume, market\.volume24hr\]\)/);
  assert.match(BOT, /liquidity: Number\(market\.liquidity \|\| 0\),/);
  assert.match(BOT, /volume24hr: Number\(market\.volume24hr \|\| 0\),/);
  for (const field of ["volumeNum", "volume", "volume24hr", "liquidity"]) {
    assert.ok(VOLUME_SOURCE_FIELDS.includes(field), `${field} is read by the bot and must be probed`);
  }
  // And the Num variants, because a nested market carrying liquidityNum but not liquidity is
  // exactly the failure that would store 0 and read as "no liquidity".
  assert.ok(VOLUME_SOURCE_FIELDS.includes("liquidityNum"));
});

test("presence is reported per field, and a missing field is not a zero", () => {
  const markets = [
    { volumeNum: 1200, liquidityNum: 300, volume24hr: 0 },
    { volumeNum: 0, liquidityNum: 50 },
    { liquidity: 900, volumeNum: 4 },
  ];
  const presence = fieldPresence(markets);
  assert.equal(presence.volumeNum.present, 3, "three carried it");
  assert.equal(presence.volumeNum.positive, 2, "one of those was zero");
  assert.equal(presence.liquidity.present, 1, "only the last market carries the name the bot reads");
  assert.equal(presence.liquidityNum.present, 2);
  // A field nothing carries reports as absent with no sample, rather than as a zero that
  // would read like a real measurement of nothing.
  assert.equal(presence.volumeClob.present, 0);
  assert.equal(presence.volumeClob.sample, null);
  // volume24hr: present on one market at 0, so present counts it and positive does not.
  assert.equal(presence.volume24hr.present, 1);
  assert.equal(presence.volume24hr.positive, 0);
});

test("coverage is split by age, because a capture that stopped today hides in a total", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");
  const rows = [
    // Scraped an hour ago with nothing captured: the failure being looked for.
    { firstObservedAt: "2026-09-27T11:00:00.000Z", volumeUsdc: 0, liquidity: 0, firstVolumeUsdc: 0 },
    { firstObservedAt: "2026-09-27T10:00:00.000Z", volumeUsdc: 0, liquidity: 0, firstVolumeUsdc: 0 },
    // Scraped last week with everything captured.
    { firstObservedAt: "2026-09-22T12:00:00.000Z", volumeUsdc: 5000, volume24hr: 400, liquidity: 900, firstVolumeUsdc: 5000, firstLiquidity: 900 },
    { firstObservedAt: "", volumeUsdc: 10, liquidity: 2, firstVolumeUsdc: 10, firstLiquidity: 2 },
  ];
  const [day, week, older] = storedCoverage(rows, now);
  assert.equal(day.rows, 2);
  assert.equal(week.rows, 1);
  assert.equal(older.rows, 1, "an undated row is old rather than recent -- it cannot claim to be new");
  assert.equal(week.volumeUsdc.positive, 1);
  assert.equal(week.liquidity.positive, 1);
  assert.equal(older.firstVolumeUsdc.positive, 1);

  // The distinction the whole check turns on. The two recent rows carry volumeUsdc and it is
  // zero: the field IS being saved, the markets simply have no volume yet. A count of rows
  // above zero reads that as a capture failure, which is a different fault with a different
  // fix -- and it is the answer somebody would act on.
  assert.equal(day.volumeUsdc.present, 2, "present: the writer wrote the field");
  assert.equal(day.volumeUsdc.positive, 0, "positive: but no market had any volume yet");
  // volume24hr is absent from both recent rows, which is what "not saved" looks like.
  assert.equal(day.volume24hr.present, 0);
  assert.equal(week.volume24hr.present, 1);
  // An empty string is not a saved number either.
  const [blank] = storedCoverage([{ firstObservedAt: "2026-09-27T11:00:00.000Z", volumeUsdc: "" }], now);
  assert.equal(blank.volumeUsdc.present, 0, "an empty value is missing, not a measurement");
});

test("it never asks for the resolved scope", () => {
  // That read exhausted the host's 512 MB limit on a live request, on the same api.php the
  // bots use. The active page is the one the dashboard already loads.
  const tool = readFileSync(new URL("../tools/volume-capture-check.mjs", import.meta.url), "utf8");
  assert.match(tool, /scope=active/);
  assert.ok(!/scope=resolved/.test(tool));
});
