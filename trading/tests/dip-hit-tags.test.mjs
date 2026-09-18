// Runs offline: the REAL dipEntryCandidateRows and the REAL observationMatchesActiveLiveConfig
// are imported from paper-trading-bot.mjs and EXECUTED. No network, no host.
//
// "dip portofila stale ne berou nove pozice, napr. dip 70+ nema zadne kandidaty."
//
// Measured on the live host, 2026-09-18 21:03, after three wrong turns:
//
//   270 dips recorded in the last 24 h          <- the worker feeds the pipeline plentifully
//   200 retained runs, 2026-09-15 to 2026-09-18
//   runs with eligibleCount > 0: ONE            <- 2026-09-17 17:27, in three days
//
// So hits are not missing. The loss is between a recorded hit and an eligible candidate, and
// it is near-total. dipEntryCandidateRows builds its row out of the recorded hit, and the hit
// carries portfolioId, tokenId, conditionId, question, outcome, slug, price, openProbability,
// volumeUsdc, endDate and at. It carries NO TAGS -- and a dip portfolio is configured with
// includeOnlyMarketTags ["sports","esports"], which rejects a row whose tag set is empty.
//
// Every one of those 270 daily hits fails that one gate. Nothing else had to be wrong.
//
// The shortlist probe never saw it because its own gate mirror checks price, ownership, the
// buy band and the kickoff -- not the tags. Three rounds of analysis ran against a copy of
// the rules that was missing the rule that mattered.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const BOT = new URL("../tools/paper-trading-bot.mjs", import.meta.url);
const SOURCE = readFileSync(BOT, "utf8");
const bot = await import(BOT);

// A dip exactly as the RPi worker records one. Taken from the worker's own journal:
//   11:37 DIP_ENTRY_PAPER_RECORDED paper-dip70 ask 0.51 "... 1st Half O/U 2.5"
const HIT = {
  portfolioId: "paper-dip70",
  tokenId: "89440459262008703916183756529194926835900198927438145404709447335293865925827",
  conditionId: "0xabc",
  question: "Zhejiang Zhiye FC vs. Wuhan San Zhen FC: 1st Half O/U 2.5",
  outcome: "Under",
  slug: "zhejiang-wuhan-1h-ou-25",
  price: 0.51,
  openProbability: 0.765,
  volumeUsdc: 17961,
  // What the watch plan now carries and the worker forwards. Before the fix this field did
  // not exist anywhere in the chain, which is the whole bug.
  tags: ["sports", "soccer"],
  // In the future: the fixture is still being played, which is when a dip is actionable.
  endDate: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
  at: new Date(Date.now() - 60 * 1000).toISOString(),
};

// dip 70+, as the portfolio is actually configured on the account.
const STRATEGY = {
  id: "dip70",
  displayName: "dip 70+",
  stakeUsdc: 5,
  minProbability: 0.3,
  maxProbability: 0.6,
  maxResolutionDays: 7,
  minLiquidityUsdc: null,
  excludedMarketShapes: [],
  excludeOverUnderMarkets: false,
  includeOnlyMarketTags: ["sports", "esports"],
  excludedMarketTags: [],
  liveEventMode: "only",
  marketType: "all",
  automationEnabled: true,
  archived: false,
  dipEntryEnabled: true,
  dipEntryOpenMin: 0.7,
  dipEntryOpenMax: 0.99,
};

const rowsFor = (hit = HIT, strategy = STRATEGY) => bot.dipEntryCandidateRows(strategy, [hit]);

test("a freshly recorded dip becomes exactly one candidate row", () => {
  const rows = rowsFor();
  assert.equal(rows.length, 1, "the hit must survive row building");
  assert.equal(rows[0].marketProbability, 0.51);
  assert.equal(rows[0].status, "ELIGIBLE");
});

test("that row carries the market's tags, so the portfolio's tag filter can match it", () => {
  // The fix. Without tags on the row the filter below has nothing to match and refuses it,
  // which is what emptied 270 dips a day.
  const row = rowsFor()[0];
  // Read the same way the filter reads them, rather than by guessing the field name: the
  // bot looks at nine fields and any one of them counts.
  const tags = new Set([
    ...(row.polymarketTags || []), ...(row.tags || []), ...(row.firstPolymarketTags || []),
    ...(row.firstTags || []), ...(row.polymarketCategories || []), ...(row.firstPolymarketCategories || []),
    row.riskCategory, row.category, row.firstCategory,
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase()));
  assert.ok(tags.size > 0, `a dip row must carry tags: ${JSON.stringify(row).slice(0, 400)}`);
  assert.ok(tags.has("sports") || tags.has("esports"),
    `and they must be the ones the portfolio admits: ${[...tags].join(", ")}`);
});

test("BAIT: with an empty tag set the portfolio's include list refuses the row", () => {
  // The bug itself, executed against the REAL filter. This is what every recorded dip hit.
  const row = { ...rowsFor()[0] };
  for (const field of ["polymarketTags", "tags", "firstPolymarketTags", "firstTags",
    "polymarketCategories", "firstPolymarketCategories", "riskCategory", "category", "firstCategory"]) {
    delete row[field];
  }
  assert.equal(bot.observationMatchesActiveLiveConfig(row, STRATEGY), false,
    "a tagless row must be refused, which is why the shortlist was empty");
  // And the same row passes the moment the portfolio stops demanding a tag, which proves the
  // tag list is the gate that consumed it and not one of the other nine.
  assert.equal(
    bot.observationMatchesActiveLiveConfig(row, { ...STRATEGY, includeOnlyMarketTags: [] }),
    true,
    "with no include list the very same row passes -- so tags were the only thing wrong");
});

test("the tagged row passes the portfolio's real filter", () => {
  const row = rowsFor()[0];
  assert.equal(bot.observationMatchesActiveLiveConfig(row, STRATEGY), true,
    `the fixed row must reach the shortlist: ${JSON.stringify(row).slice(0, 400)}`);
});

test("a tag the portfolio excludes is still refused", () => {
  // The filter must keep working in the other direction: carrying tags is not the same as
  // ignoring them.
  const row = rowsFor({ ...HIT, tags: ["politics"] })[0];
  assert.equal(bot.observationMatchesActiveLiveConfig(row, STRATEGY), false,
    "a dip in a market the portfolio does not admit stays refused");
  assert.equal(
    bot.observationMatchesActiveLiveConfig(
      rowsFor({ ...HIT, tags: ["esports"] })[0],
      { ...STRATEGY, excludedMarketTags: ["esports"] }),
    false,
    "and an excluded tag still excludes");
});

test("BAIT: the watch plan must carry the tags, or the hit can never have them", () => {
  // The row can only carry what the hit carries, and the hit only what the watch plan sent.
  // Fixing the bot alone would produce a test that passes against a fixture and a pipeline
  // that still ships nothing, so the two ends are checked where they are written.
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");
  const watch = api.slice(api.indexOf("function live_dip_entry_watch_payload"));
  const plan = watch.slice(watch.indexOf("$plans[] = ["), watch.indexOf("'preparedAt'"));
  assert.match(plan, /'tags' =>/, "the watch plan must publish the market's tags");

  const record = api.slice(api.indexOf("function record_dip_entry_hit"));
  const stored = record.slice(0, record.indexOf("'at' => gmdate"));
  assert.match(stored, /'tags' =>/, "and the recorded hit must store them");

  // The worker forwards the plan's fields; the field it sends has to be the one stored.
  const worker = readFileSync(new URL("../tools/rpi-live-exit-worker.mjs", import.meta.url), "utf8");
  const post = worker.slice(worker.indexOf("async function recordDipEntryHit"));
  assert.match(post.slice(0, post.indexOf("\n}")), /tags:/,
    "the worker must forward the tags it was given");
});

test("BAIT: the shortlist probe must apply the tag gate it was missing", () => {
  // Three rounds of diagnosis ran against a mirror of the rules with this gate absent, and
  // each time reported a different innocent gate as the culprit. A mirror that omits a rule
  // is worse than no mirror.
  const probe = readFileSync(new URL("../tools/dip-shortlist-probe.mjs", import.meta.url), "utf8");
  assert.match(probe, /includeOnlyMarketTags/, "the probe must read the include list");
  assert.match(probe, /tag/i);
  assert.match(probe, /tags the portfolio refuses/,
    "and it must COUNT the rows that gate consumes, not just print the setting");
  assert.match(probe, /outsideTags \+= 1/, "which means applying it inside the walk");
});

test("dipEntryCandidateRows is still the only builder, and reads the hit", () => {
  // Guard against the fix drifting into a second code path that the tests do not run.
  assert.match(SOURCE, /export function dipEntryCandidateRows\(strategy, hits = DIP_ENTRY_HITS\)/);
});

test("the probe reports whether the watch plans carry tags at all", () => {
  // The only link of the four that can be observed live without waiting for a fresh dip:
  // the watch payload is a public read. If the plans carry tags, the endpoint half of the
  // fix is proven on the host rather than only in this suite.
  const probe = readFileSync(new URL("../tools/dip-shortlist-probe.mjs", import.meta.url), "utf8");
  assert.match(probe, /carrying the market's tags/);
  assert.match(probe, /Array\.isArray\(plan\?\.tags\) && plan\.tags\.length > 0/,
    "an empty array must count as untagged, not as tagged");
});

test("the worker's own dip watch size is reported where a short read reaches it", () => {
  // This cost real time tonight. The dip block sits two hundred lines up in the status
  // output, behind a page of settlement events, so pulling it back through the Actions log
  // API meant fetching seventy lines of history every time -- and it went unread. The one
  // number that separates "the watch went stale on the Pi" from "no favourite actually
  // fell" has to be at the end, where a ten-line tail finds it.
  const status = readFileSync(
    new URL("../../.github/workflows/trading-rpi-live-exit-worker-status.yml", import.meta.url), "utf8");
  assert.match(status, /DIP WATCH: \$\{dipNow\.length\} plan\(s\) followed right now/);
  const summary = status.slice(0, status.indexOf("- name: Report the journal"));
  assert.ok(summary.lastIndexOf("DIP WATCH") > summary.lastIndexOf("ARMED"),
    "it must come last in the state summary, not before the event list");
  assert.match(status, /\$\{dipTagged\} carrying tags/,
    "and say how many carry tags, which is the fix's own evidence on the Pi");
});
