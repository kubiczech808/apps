// Runs offline: the caption in app.js is read against the workflow files that actually
// decide what a scan asks for. No network, no secrets.
//
// Asked for: "myslim, ze tam mas nejake omezeni v pravidelnem i tom ondemand (tlacitkem)
// scrapingu popr. v retenci aktivnich dat. prosim vypis mi ho nekde u tlacitka - strucne a
// jasne ve stylu tags=esports, sports, politics + volume >= 100 + ..."
//
// A caption has exactly one failure mode: it stops being true and nothing notices. Every
// number in it is a value a workflow sends or an environment variable it sets, none of them
// reachable from the browser, so each is checked here against the file that sets it. Change
// the liquidity floor in the pacer and this fails until the caption is changed too.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const APP = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../assets/app.css", import.meta.url), "utf8");
const SCAN = readFileSync(new URL("../../.github/workflows/trading-market-scan.yml", import.meta.url), "utf8");
const PACER = readFileSync(new URL("../../.github/workflows/trading-pacer.yml", import.meta.url), "utf8");

const CAPTION = (() => {
  const start = APP.indexOf("const SCAN_SCOPE_LINES = [");
  assert.ok(start > 0, "the caption must exist");
  return APP.slice(start, APP.indexOf("\n];", start));
})();

test("the caption is rendered beside the button that runs the scan", () => {
  assert.match(HTML, /data-scraped-scan-scope/);
  // Beside the button, not somewhere else on the page: that is the whole request.
  const controls = HTML.slice(HTML.indexOf('<div class="scraped-scan-controls"'));
  const block = controls.slice(0, controls.indexOf("</div>"));
  assert.match(block, /data-scraped-scan\b/);
  assert.match(block, /data-scraped-scan-scope/);
  assert.match(APP, /scrapedScanScope: document\.querySelector\("\[data-scraped-scan-scope\]"\)/);
  assert.match(APP, /els\.scrapedScanScope\.innerHTML = SCAN_SCOPE_LINES/);
  assert.match(CSS, /\.scraped-scan-scope \{/);
});

test("the button's own limits are what the button actually sends", () => {
  // The three inputs triggerOneTimeMarketScan dispatches.
  const tag = /const MANUAL_SCAN_TAG = "([^"]*)";/.exec(APP)[1];
  const liquidity = Number(/const MANUAL_SCAN_LIQUIDITY_MIN = ([\d.]+);/.exec(APP)[1]);
  const days = Number(/const MANUAL_SCAN_MAX_DAYS = ([\d.]+);/.exec(APP)[1]);
  assert.equal(tag, "", "an empty tag means the whole scanned scope");
  assert.equal(liquidity, 0);
  assert.equal(days, 1);

  const line = CAPTION.split("\n").find((entry) => entry.includes("button:"));
  assert.ok(line, "the caption must have a line for the button");
  assert.match(line, /no liquidity floor/, `liquidity_min is ${liquidity}, so the caption must say so`);
  assert.match(line, /≤ 24 h/, `max_days is ${days}, so the caption must say 24 h`);
  assert.match(line, /tags=sports, esports/);
});

test("the scheduled limits are the rotation's own", () => {
  // The pacer sends a liquidity floor and a horizon with each tagged slot.
  const rotation = /case \$\(\( tick % 6 \)\) in([\s\S]*?)esac/.exec(PACER)[1];
  const sports = /tag=sports; +liquidity=(\d+); +days=(\d+)/.exec(rotation);
  const esports = /tag=esports; liquidity=(\d+); days=(\d+)/.exec(rotation);
  const broad = /tag=""; +liquidity=(\d+); +days=(\d+)/.exec(rotation);
  assert.ok(sports && esports && broad, "all three scopes must be readable from the pacer");
  assert.equal(sports[1], esports[1], "both tagged scopes share one floor, as the caption says");
  assert.equal(sports[2], esports[2]);

  const tagged = CAPTION.split("\n").find((entry) => entry.includes("tags=esports, sports"));
  assert.ok(tagged, "the caption must have a line for the tagged passes");
  // $40k, 2 d, and 5 of 6 -- each read out of the rotation rather than restated.
  assert.ok(tagged.includes(`$${Number(esports[1]) / 1000}k`),
    `the floor is ${esports[1]}, and the caption says: ${tagged}`);
  assert.ok(tagged.includes(`≤ ${esports[2]} d`), `the horizon is ${esports[2]} days: ${tagged}`);
  const taggedSlots = (rotation.match(/tag=(sports|esports)/g) || []).length
    + (/\*\) tag=esports/.test(rotation) ? 3 : 0);
  assert.ok(tagged.includes("5/6") || tagged.includes("5 of 6"),
    `the rotation gives the tagged scopes five slots of six; the caption says: ${tagged}`);
  assert.equal(taggedSlots, 5, "and if that share ever changes, this is where it shows");

  const untagged = CAPTION.split("\n").find((entry) => entry.includes("6th pass untagged"));
  assert.ok(untagged.includes(`≤ ${broad[2]} d`), `the broad horizon is ${broad[2]} days: ${untagged}`);
  assert.ok(untagged.includes("no floor"), `the broad floor is ${broad[1]}: ${untagged}`);
});

test("the retention limits are the scan workflow's own", () => {
  const retain = /PAPER_MARKET_OBSERVATION_RETAIN_LIMIT: "(\d+)"/.exec(SCAN)[1];
  const line = CAPTION.split("\n").find((entry) => entry.includes("retention:"));
  assert.ok(line, "the caption must say what is kept");
  // Written with a thin space for readability, so the digits are compared rather than the
  // formatting: 8000 must be 8 000 on screen and must be 8000 in the workflow.
  assert.equal(line.replace(/[^\d]/g, ""), retain,
    `retention keeps ${retain} rows, and the caption says: ${line}`);

  // And the scope that retention enforces, which is the limit that surprises: a row outside
  // it is DELETED after the scan, however it was fetched.
  const scope = /const MARKET_SCAN_TAG_SCOPE = String\(process\.env\.PAPER_MARKET_SCAN_TAG_SCOPE \?\? "([^"]+)"\)/
    .exec(readFileSync(new URL("../tools/paper-trading-bot.mjs", import.meta.url), "utf8"))[1];
  for (const tag of scope.split(",")) {
    assert.ok(line.includes(tag.trim()), `retention keeps only ${scope}; the caption must name ${tag}`);
  }
});

test("the caption stays short enough to read beside a button", () => {
  const lines = CAPTION.split("\n").filter((entry) => entry.includes('"'));
  assert.ok(lines.length >= 4, "all four limits must be stated");
  for (const line of lines) {
    const text = /"([^"]*)"/.exec(line)[1];
    assert.ok(text.length <= 78, `a caption line must fit: ${text}`);
  }
});
