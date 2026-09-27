// Runs offline: the query tool's request shape and its reporting, checked against api.php.
// No network.
//
// This tool exists because its predecessor pulled the whole resolved archive over HTTP and
// exhausted the host's 512 MB PHP limit on a live request. So the things worth testing are
// not arithmetic -- it has none -- but that it asks the cheap endpoint, with parameters that
// endpoint accepts, and that it reports which data path answered.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { rankedRows, byTag, impliedWinnerEntry, accuracyEdge, subtractShapes } from "../tools/tag-probability-query.mjs";

const TOOL = readFileSync(new URL("../tools/tag-probability-query.mjs", import.meta.url), "utf8");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

test("it asks the folded endpoint, not the archive scan that exhausted the host", () => {
  assert.match(TOOL, /action=resolved-tag-probability-analysis/,
    "the folded per-tag endpoint is the cheap path");
  assert.ok(!/summary=scraped/.test(TOOL),
    "the full-archive read is what ran the host out of memory and must not be here");
  // api.php's own note on this endpoint, quoted so the reason travels with the test.
  // The comment wraps across two lines in the source, so the halves are matched separately
  // rather than as one string -- a quote assertion that fails on a line break tests the
  // formatting, not the intent.
  assert.match(API, /one tag analysis must stay a/);
  assert.match(API, /small database query, not another scan of the full resolved archive/);
});

test("the parameters it sends are the ones api.php reads and accepts", () => {
  // tag, shape and mode, by those names.
  assert.match(API, /\$tag = strtolower\(trim\(\(string\) \(\$_GET\['tag'\] \?\? ''\)\)\);/);
  assert.match(API, /\$_GET\['shape'\]/);
  assert.match(API, /\$_GET\['mode'\]/);
  assert.match(TOOL, /&tag=\$\{encodeURIComponent\(tag\)\}/);
  assert.match(TOOL, /&shape=\$\{encodeURIComponent\(SHAPE\)\}/);
  assert.match(TOOL, /&mode=\$\{encodeURIComponent\(MODE\)\}/);

  // And a tag it would send has to satisfy the endpoint's own validation, or the answer is
  // a 400 that reads like "this tag has no data".
  const pattern = /\^\[a-z0-9\]\[a-z0-9-\]\{0,79\}\$/;
  assert.match(API, pattern, "the endpoint validates the tag against this");
  const accepts = (tag) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(tag);
  assert.ok(accepts("tha"), "tha must be askable");
  assert.ok(accepts("tha1"), "and so must tha1 -- which of them exists is the question");
  assert.ok(!accepts("*"), "a wildcard is not a tag here, so it must never be sent as one");
  assert.ok(!accepts(""), "nor an empty string");
});

test("it reports which data path answered, and does not assume the response shape", () => {
  // statsSource distinguishes the cheap stored read from the heavy fallback scan. Without
  // printing it, a run that quietly took the expensive path looks identical to one that did
  // not -- and the expensive path is what must not be repeated.
  assert.match(API, /\$statsSource = 'archive';/);
  assert.match(API, /\$statsSource = 'stored';/);
  assert.match(TOOL, /"statsSource"/, "the tool must surface which path ran");

  // And it prints the keys it was handed rather than only the ones it expected. Three
  // interface mismatches in this session were invisible because a tool assumed its input
  // and reported the resulting emptiness as a finding.
  assert.match(TOOL, /response keys:/);
  assert.match(TOOL, /no row array found in the response; printing it whole/);
});

// The ranking half. Built from the real response's own shape: "combinations" is an integer
// count and "best" is the list, which the first run of this got backwards and reported as
// "no rows" against 21,535 of them.
const RESPONSE = {
  ok: true,
  statsSource: "stored",
  cells: 17077,
  combinations: 21535,
  best: [
    { tag: "uefa-super-cup", shape: "other", horizon: "*", probability: 50, trades: 93, wins: 81, stakedUsdc: 475.06, pnlUsdc: 271.23, returnPct: 57.09 },
    { tag: "uefa-super-cup", shape: "*", horizon: "<= 3 h", probability: 50, trades: 93, wins: 81, stakedUsdc: 475.06, pnlUsdc: 271.23, returnPct: 57.09 },
    { tag: "soccer", shape: "outright", horizon: "*", probability: 60, trades: 4200, wins: 3100, stakedUsdc: 21000, pnlUsdc: 900.5, returnPct: 4.29 },
    { tag: "*", shape: "outright", horizon: "*", probability: 60, trades: 9000, wins: 6600, stakedUsdc: 45000, pnlUsdc: 1800, returnPct: 4.0 },
    { tag: "uefa-super-cup", shape: "*", horizon: "*", probability: 55, trades: 40, wins: 35, stakedUsdc: 204, pnlUsdc: 96.1, returnPct: 47.1 },
  ],
  worst: [{ tag: "politics", shape: "other", horizon: "*", probability: 50, trades: 61, wins: 20, stakedUsdc: 310, pnlUsdc: -120.4, returnPct: -38.8 }],
};

test("the rows are read from 'best' -- 'combinations' is a count, not the list", () => {
  const rows = rankedRows(RESPONSE);
  assert.equal(rows.length, 5, "the list is under best");
  assert.equal(rows[0].tag, "uefa-super-cup");
  // The count must never be mistaken for the list: Array.isArray(21535) is false, so a
  // reader that looked at "combinations" first would fall through to "no rows".
  assert.ok(!Array.isArray(RESPONSE.combinations));
  assert.deepEqual(rankedRows({ ok: true, combinations: 21535 }), [],
    "a response with only the count carries no rows to print");
});

test("byTag keeps one row per tag -- the best-earning one -- and ranks by nominal P/L", () => {
  const ranked = byTag(RESPONSE.best);
  assert.deepEqual(ranked.map((row) => row.tag), ["soccer", "uefa-super-cup"],
    "soccer earns more in absolute terms despite the far lower return per dollar");
  const cup = ranked.find((row) => row.tag === "uefa-super-cup");
  assert.equal(cup.pnlUsdc, 271.23, "the tag's best-earning setup, not its last-seen one");
  assert.ok(!ranked.some((row) => row.tag === "*"),
    "the any-tag aggregate is not a tag and would otherwise top every table");
});

// The plausibility check. The settled archive systematically holds the winning side of a
// market, so a row's win rate cannot be read on its own -- but a row's own money says what
// its winners were priced at, and a sample cannot honestly win far more often than it paid
// to. This is what separates a setup from an artefact on this data.
test("a row's own money reveals what its winners were priced at", () => {
  // Ten trades at 50c, five won. Each win returns $10 on a $5 stake, so P/L is zero on $50
  // staked, and the winners were priced at 5*5/(0+50) = 0.50 -- which is exactly right.
  const fair = { trades: 10, wins: 5, stakedUsdc: 50, pnlUsdc: 0 };
  assert.equal(impliedWinnerEntry(fair), 0.5);
  assert.equal(accuracyEdge(fair), 0, "a fairly priced sample has no edge to explain");

  // The shape the archive actually produced: sixty trades quoted at 72c, sixty wins.
  const contaminated = { trades: 60, wins: 60, stakedUsdc: 300, pnlUsdc: 116.67 };
  assert.ok(Math.abs(impliedWinnerEntry(contaminated) - 0.72) < 0.001,
    "the price is recoverable from the money even though the row never states it");
  assert.ok(accuracyEdge(contaminated) > 0.27,
    "and winning every time at 72c is 28 points more often than the price paid for");

  // A real but modest edge stays modest, so the check does not simply reject everything:
  // ten trades at 50c winning six times.
  const modest = { trades: 10, wins: 6, stakedUsdc: 50, pnlUsdc: 10 };
  assert.equal(impliedWinnerEntry(modest), 0.5);
  assert.ok(Math.abs(accuracyEdge(modest) - 0.1) < 1e-9);

  assert.equal(impliedWinnerEntry({ trades: 10, wins: 0, stakedUsdc: 50, pnlUsdc: -50 }), null,
    "a sample with no winners cannot say what its winners paid");
});

test("everything-else is the remainder, component by component", () => {
  const all = { trades: 100, wins: 80, stakedUsdc: 500, pnlUsdc: 60 };
  const outright = { trades: 40, wins: 30, stakedUsdc: 200, pnlUsdc: 10 };
  const overUnder = { trades: 35, wins: 30, stakedUsdc: 175, pnlUsdc: 25 };
  const rest = subtractShapes(all, [outright, overUnder]);
  assert.deepEqual(rest, { trades: 25, wins: 20, stakedUsdc: 125, pnlUsdc: 25 });
  // Subtracting only the totals and re-deriving the rest from a ratio would lose this: the
  // remainder's return is 20%, double the outright leg's, and that is the point of splitting.
  assert.equal(Number((rest.pnlUsdc / rest.stakedUsdc).toFixed(2)), 0.2);
  assert.equal(subtractShapes(all, [all]), null, "a remainder of nothing is not a row");
  assert.equal(subtractShapes(null, [outright]), null);
});

test("an impossible remainder is refused, not printed", () => {
  // The first run of the sweep printed "uel - everything else 134.4%" because the
  // all-shapes row it subtracted from was a shape-specific row that had survived the
  // duplicate collapse. Wins above trades is the signature of subtracting rows that do not
  // describe the same sample, and an impossible number presented as a setup is worse than
  // a gap in the table.
  const all = { trades: 83, wins: 83, stakedUsdc: 420, pnlUsdc: 25.59 };
  const overUnder = { trades: 51, wins: 40, stakedUsdc: 258, pnlUsdc: -18.74 };
  assert.equal(subtractShapes(all, [overUnder]), null,
    "43 wins out of 32 trades is not a row, it is a contradiction");

  // And a remainder that is merely unusual still comes through, so the guard is not a
  // silent filter on anything surprising.
  const honest = { trades: 83, wins: 70, stakedUsdc: 420, pnlUsdc: 25.59 };
  assert.deepEqual(subtractShapes(honest, [overUnder]), { trades: 32, wins: 30, stakedUsdc: 162, pnlUsdc: 44.33 });
});

test("the sweep reads only the shape it asked for", () => {
  // A tag's total printed as 126 trades while its own over-under leg held 4,556 came from
  // accepting whichever row for that tag appeared first, whatever shape it carried.
  const tool = readFileSync(new URL("../tools/tag-probability-query.mjs", import.meta.url), "utf8");
  assert.match(tool, /if \(row\.shape !== shape\) continue;/,
    "the rollup must match the requested shape, not merely the requested tag");
  assert.match(tool, /if \(row\.horizon !== "\*" \|\| row\.tag === "\*"\) continue;/);
});

test("volume is not a dimension the fold keeps, and the tool does not pretend otherwise", () => {
  // Asked: "jestli v tom hraje roli pocatecni volume". The stored cells are keyed by
  // probability, tag, shape and horizon only, so a volume split cannot come from this path
  // at any cost -- it is absent, not merely expensive. Saying so is the answer; inventing a
  // proxy for it would be a number somebody sets a live portfolio by.
  const storage = readFileSync(new URL("../storage.php", import.meta.url), "utf8");
  assert.match(storage, /\(cell_key, scope, probability, tag, shape, horizon, trades, wins, staked_usdc, pnl_usdc, updated_at\)/,
    "if a volume column is ever added here, this test is the reminder to use it");
  const tool = readFileSync(new URL("../tools/tag-probability-query.mjs", import.meta.url), "utf8");
  assert.match(tool, /Volume\n\/\/ is NOT -- the fold's cells are \(probability, tag, shape, horizon\)/);
});
