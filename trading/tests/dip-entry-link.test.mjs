// Runs offline: dipEntryCandidateRows, polymarketUrl and recordDipEntryHit are the REAL
// functions out of paper-trading-bot.mjs, app.js and rpi-live-exit-worker.mjs, EXECUTED (the
// last with globalThis.fetch stubbed -- no network). The api.php side is checked structurally,
// the same way dip-hit-tags.test.mjs already checks the sibling `tags` field on this exact
// pipeline: the function is too gated (event-running, tag, shape, diversification, liquidity)
// to fixture end to end for one field, so the block that assigns the field is sliced out and
// matched instead of guessed at.
//
// "nejde se vubec prokliknout na eventy v polymarketu z open positions- ty eventy se zdaji byt
// fake. uz mely byt dohrane."
//
// Measured on production, 2026-09-19: 500/500 recorded dip-entry hits carried an empty slug
// and a null eventSlug ("dip 70+" 183 of them, "dip 70+ to 30-56" 170, "dip" 147). app.js's
// polymarketUrl() reads item.eventSlug, then item.slug, and falls back to the bare Polymarket
// homepage when neither is a usable slug -- which is indistinguishable, from the dashboard,
// from a fake or an already-resolved market. The matches were real; nothing ever carried their
// address this far.
//
// The chain, and where it lost the field, at every one of its four hops:
//   the observation already carries both (slug from the scan, eventSlug resolved through
//   marketEventSlug() -- necessary because a grouped event's own browsable slug often differs
//   from any one of its sub-markets', which is exactly the shape of the markets reported here:
//   "Imperial vs BESTIA - Map 2 Winner" is one outcome inside a larger tournament event)
//     -> api.php's live_dip_entry_watch_payload() builds $plans[] -- never read slug/eventSlug
//        off the observation, so every plan lacked both keys entirely
//     -> rpi-live-exit-worker.mjs's recordDipEntryHit() posts the plan -- forwarded slug,
//        never eventSlug, because the plan never had it to forward
//     -> api.php's record_dip_entry_hit() stores the hit -- never read eventSlug off the input,
//        so it would have been dropped even had the worker sent it
//     -> paper-trading-bot.mjs's dipEntryCandidateRows() rebuilds the candidate row the bot
//        actually opens a position from -- never set eventSlug, only slug
// Fixed at all four, so a slug captured at the top now actually reaches the row the dashboard
// renders.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");
const BOT_PATH = new URL("../tools/paper-trading-bot.mjs", import.meta.url);
const BOT_SOURCE = readFileSync(BOT_PATH, "utf8");
const bot = await import(BOT_PATH);
const APP_SOURCE = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");

process.env.TRADING_TRIGGER_KEY ||= "test-key";
const WORKER_PATH = new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url);
const WORKER_SOURCE = readFileSync(WORKER_PATH, "utf8");
const worker = await import(WORKER_PATH);

// Brace-matched, same helper live-exit-worker.test.mjs already uses -- slicing to "the next
// function" silently swallows the rest of the file once something is inserted between them.
function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at > 0, `function ${name} was not found`);
  const start = source.slice(Math.max(0, at - 6), at) === "async " ? at - 6 : at;
  let depth = 0;
  for (let index = source.indexOf("{", source.indexOf(")", start)); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} is unbalanced`);
}

const polymarketUrl = new Function(`${functionBody(APP_SOURCE, "polymarketUrl")}; return polymarketUrl;`)();

async function withCapturedFetch(run) {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, status: 200, json: async () => ({ ok: true, recorded: true }) };
  };
  try {
    const result = await run();
    return { result, captured };
  } finally {
    globalThis.fetch = original;
  }
}

// A dip exactly as it was reported: a sub-market inside a grouped esports event, where the
// market's own slug and the event's browsable slug are two different strings.
const HIT = {
  portfolioId: "paper-dip70",
  tokenId: "89440459262008703916183756529194926835900198927438145404709447335293865925827",
  conditionId: "0xabc",
  question: "Counter-Strike: Imperial vs BESTIA - Map 2 Winner",
  outcome: "Imperial",
  slug: "imperial-bestia-map-2-winner",
  eventSlug: "cs2-imperial-vs-bestia-circuit-x-curitiba",
  price: 0.6,
  openProbability: 0.78,
  volumeUsdc: 4200,
  tags: ["sports", "esports"],
  endDate: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
  at: new Date(Date.now() - 60 * 1000).toISOString(),
};
const STRATEGY = { id: "dip70", stakeUsdc: 5 };

test("a hit's slug and eventSlug both survive into the candidate row dipEntryCandidateRows builds", () => {
  const [row] = bot.dipEntryCandidateRows(STRATEGY, [HIT]);
  assert.ok(row, "the hit must survive row building");
  assert.equal(row.slug, "imperial-bestia-map-2-winner");
  assert.equal(row.eventSlug, "cs2-imperial-vs-bestia-circuit-x-curitiba");
});

test("the fixed row resolves through the real polymarketUrl to the event, not the homepage", () => {
  const [row] = bot.dipEntryCandidateRows(STRATEGY, [HIT]);
  assert.equal(polymarketUrl(row), "https://polymarket.com/event/cs2-imperial-vs-bestia-circuit-x-curitiba",
    "the EVENT slug, not the sub-market's own, is what a grouped event needs to be reachable");
});

test("BAIT: a hit missing eventSlug (slug alone) still links, but to the sub-market rather than the event", () => {
  const { eventSlug, ...withoutEventSlug } = HIT;
  const [row] = bot.dipEntryCandidateRows(STRATEGY, [withoutEventSlug]);
  assert.equal(row.eventSlug, "");
  assert.equal(polymarketUrl(row), "https://polymarket.com/event/imperial-bestia-map-2-winner",
    "still a link, just not necessarily the browsable one for a grouped event");
});

test("BAIT: a hit missing both slug and eventSlug -- the incident exactly as measured -- degrades to the bare homepage", () => {
  const row = bot.dipEntryCandidateRows(STRATEGY, [{ ...HIT, slug: "", eventSlug: "" }])[0];
  assert.equal(polymarketUrl(row), "https://polymarket.com/",
    "reproduces what every one of the 500 recorded hits pointed at before this fix");
});

test("BAIT: api.php's watch plan must publish the observation's slug and eventSlug", () => {
  const watch = API.slice(API.indexOf("function live_dip_entry_watch_payload"));
  const plan = watch.slice(watch.indexOf("$plans[] = ["), watch.indexOf("'preparedAt'"));
  assert.match(plan, /'slug' => \(string\) \(\$item\['slug'\] \?\? ''\)/,
    "the watch plan must carry the observation's own market slug");
  assert.match(plan, /'eventSlug' => \(string\) \(\$item\['eventSlug'\] \?\? ''\)/,
    "and its already-resolved event slug -- without this, only the sub-market's own slug can ever reach a hit");
});

test("BAIT: api.php must store eventSlug on the recorded hit, or the plan's fix never reaches disk", () => {
  const record = API.slice(API.indexOf("function record_dip_entry_hit"));
  const stored = record.slice(0, record.indexOf("'at' => gmdate"));
  assert.match(stored, /'slug' => \(string\) \(\$input\['slug'\] \?\? ''\)/);
  assert.match(stored, /'eventSlug' => \(string\) \(\$input\['eventSlug'\] \?\? ''\)/,
    "storing slug alone repeats the incident for every grouped-event market");
});

test("BAIT: a retained worker plan without verifiable opening evidence cannot create a paper hit", () => {
  const record = API.slice(API.indexOf("function record_dip_entry_hit"));
  const guard = record.slice(0, record.indexOf("$hits = read_dip_entry_hits"));
  assert.match(guard, /unverified opening quote; refusing to record a dip entry/);
  assert.match(guard, /dip_entry_opening_is_verifiable/,
    "the record endpoint must enforce the same opening-proof rule after a worker deployment");
  assert.match(guard, /marketCreatedAt/,
    "a pre-start quote alone is not enough when the scanner first found the market late");
});

test("BAIT: the worker must forward eventSlug from the plan it received", () => {
  const post = WORKER_SOURCE.slice(WORKER_SOURCE.indexOf("export async function recordDipEntryHit"));
  const body = post.slice(0, post.indexOf("signal: controller.signal"));
  assert.match(body, /slug: plan\.slug \|\| ""/);
  assert.match(body, /eventSlug: plan\.eventSlug \|\| ""/,
    "the field the plan carries has to be the field actually sent over the wire");
});

test("recordDipEntryHit really does send eventSlug over the wire, not just in the source text", async () => {
  const plan = {
    portfolioId: HIT.portfolioId, tokenId: HIT.tokenId, conditionId: HIT.conditionId,
    question: HIT.question, outcome: HIT.outcome, slug: HIT.slug, eventSlug: HIT.eventSlug,
    openProbability: HIT.openProbability, volumeUsdc: HIT.volumeUsdc, endDate: HIT.endDate, tags: HIT.tags,
  };
  const { result, captured } = await withCapturedFetch(() => worker.recordDipEntryHit(plan, 0.6));
  assert.equal(result.ok, true, "the call must actually go through with a trigger key configured");
  assert.ok(captured, "recordDipEntryHit must call fetch");
  const body = JSON.parse(captured.options.body);
  assert.equal(body.slug, HIT.slug);
  assert.equal(body.eventSlug, HIT.eventSlug, "the real request body must carry the resolved event slug");
});

test("BAIT: a plan with no eventSlug is forwarded as an empty string, matching how a missing field always reads", () => {
  const plan = { portfolioId: HIT.portfolioId, tokenId: HIT.tokenId, question: HIT.question, outcome: HIT.outcome, slug: HIT.slug };
  return withCapturedFetch(() => worker.recordDipEntryHit(plan, 0.6)).then(({ captured }) => {
    const body = JSON.parse(captured.options.body);
    assert.equal(body.eventSlug, "", "absent must read as empty, not null or undefined, so the PHP side's own ?? '' never has to guess");
  });
});

test("dipEntryCandidateRows is still the only builder, so the fix cannot drift into a second copy", () => {
  // The third parameter is the tokens this portfolio has already traded, so a hit that has
  // already produced a position cannot be rebuilt into a candidate. Written to accept it
  // while still failing on a SECOND builder, which is what this guards.
  assert.match(BOT_SOURCE, /export function dipEntryCandidateRows\(strategy, hits = DIP_ENTRY_HITS(?:, tradedTokenIds = null)?\)/);
  assert.equal(BOT_SOURCE.match(/function dipEntryCandidateRows\(/g)?.length, 1,
    "one builder, or the tests run one copy and production runs another");
});
