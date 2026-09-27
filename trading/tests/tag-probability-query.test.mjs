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
