// Runs offline. The check's two reductions, and the distinction the whole diagnosis turns
// on: a key that ties two rows to ONE EVENT versus one that merely says they mention the
// same subject.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { eventScopedKeys, sharedKeys, EVENT_SCOPED_PREFIXES } from "../tools/risk-group-check.mjs";

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

test("it reads the active page, never the resolved scope", () => {
  const tool = readFileSync(new URL("../tools/risk-group-check.mjs", import.meta.url), "utf8");
  assert.match(tool, /scope=active/);
  assert.ok(!/scope=resolved/.test(tool));
});
