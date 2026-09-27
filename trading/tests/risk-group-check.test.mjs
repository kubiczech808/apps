// Runs offline. The check's two reductions, and the distinction the whole diagnosis turns
// on: a key that ties two rows to ONE EVENT versus one that merely says they mention the
// same subject.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { eventScopedKeys, sharedKeys, rowMatches, EVENT_SCOPED_PREFIXES } from "../tools/risk-group-check.mjs";

test("a topic key is not evidence that two rows are one bet", () => {
  // riskProfile adds `topic:iran-war` on the word "israel" alone. That links an Israeli
  // football match to an oil market, which is a useful topic cluster and useless as proof
  // the two are the same wager -- and taking both sides of one fixture is exactly the
  // mistake that has to be caught.
  const israel = { riskGroupKeys: ["team:israel", "topic:iran-war", "market:will-israel-win-on-2026-09-27"] };
  const ireland = { riskGroupKeys: ["team:republic-of-ireland", "market:will-republic-of-ireland-win-on-2026-09-27"] };

  assert.deepEqual(eventScopedKeys(israel), ["market:will-israel-win-on-2026-09-27"]);
  const shared = sharedKeys(israel, ireland);
  assert.deepEqual(shared.all, [], "nothing links them today");
  assert.deepEqual(shared.eventScoped, []);

  // Add the event both belong to and they are linked, by a key that means one fixture.
  const withEvent = (row) => ({ riskGroupKeys: [...row.riskGroupKeys, "event:isr-irl-2026-09-27"] });
  const linked = sharedKeys(withEvent(israel), withEvent(ireland));
  assert.deepEqual(linked.eventScoped, ["event:isr-irl-2026-09-27"]);

  // A shared topic alone must never count as event-scoped, however many rows carry it.
  const topicOnly = sharedKeys(israel, { riskGroupKeys: ["topic:iran-war", "team:brent"] });
  assert.deepEqual(topicOnly.all, ["topic:iran-war"]);
  assert.deepEqual(topicOnly.eventScoped, [], "a topic is not a fixture");
});

test("the prefixes it trusts are the ones riskProfile builds from a slug", () => {
  // event:, match: and market: all come from the row's own identity in riskProfile. team:
  // and topic: come from the question text, and two different fixtures can share either.
  const bot = readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8");
  assert.match(bot, /addKey\(`market:\$\{normalizedSlug\}`/);
  assert.match(bot, /addKey\(`event:\$\{normalizedEventSlug\}`/);
  assert.match(bot, /addKey\(`match:\$\{pair\}`/);
  for (const prefix of ["event:", "match:", "market:"]) {
    assert.ok(EVENT_SCOPED_PREFIXES.includes(prefix), `${prefix} is built from the row's identity`);
  }
  assert.ok(!EVENT_SCOPED_PREFIXES.includes("topic:"));
  assert.ok(!EVENT_SCOPED_PREFIXES.includes("team:"));
});

test("the end-date filter is what narrows a team's season to one fixture", () => {
  // Israel plays a dozen times a season, so a question filter alone returns a dozen
  // unrelated matches and the two rows that are actually one bet get lost in them.
  const today = { question: "Will Israel win on 2026-09-27?", endDate: "2026-09-27T20:45:00Z" };
  const later = { question: "Will Israel win on 2026-10-11?", endDate: "2026-10-11T18:00:00Z" };
  const other = { question: "Will Brentford win on 2026-09-27?", endDate: "2026-09-27T20:45:00Z" };

  assert.ok(rowMatches(today, ["israel"], ["2026-09-27"]));
  assert.ok(!rowMatches(later, ["israel"], ["2026-09-27"]), "a different fixture is out");
  assert.ok(!rowMatches(other, ["israel"], ["2026-09-27"]), "the same instant is not enough");

  // No end filter means every fixture, which is how the earlier runs were made.
  assert.ok(rowMatches(later, ["israel"], []));
  // The slug counts as well. A walk of 22577 rows reported "0 match" for "will israel win"
  // while the fixture was plainly in the catalogue, because the stored question reads
  // "Israel vs. Republic of Ireland: Israel" and only the slug carries the other wording.
  const bySlug = { question: "Israel vs. Republic of Ireland: Israel", slug: "will-israel-win-on-2026-09-27", endDate: "2026-09-27T20:45:00Z" };
  assert.ok(rowMatches(bySlug, ["will-israel-win"], ["2026-09-27"]), "the slug is searched too");
  // A row with no recorded end date cannot satisfy an end filter.
  assert.ok(!rowMatches({ question: "Will Israel win?" }, ["israel"], ["2026-09-27"]));
});

test("it reads the active page, never the resolved scope", () => {
  const tool = readFileSync(new URL("../tools/risk-group-check.mjs", import.meta.url), "utf8");
  assert.match(tool, /scope=active/);
  assert.ok(!/scope=resolved/.test(tool));
});
