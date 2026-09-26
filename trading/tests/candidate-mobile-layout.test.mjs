import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../assets/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../assets/app.css", import.meta.url), "utf8");

test("candidate cards keep state and tags with the market heading on mobile", () => {
  assert.match(app, /<td data-label="Market" class="candidate-market-cell">\s*<span class="order-chip candidate-precheck-chip/,
    "the state belongs beside the market, not in the precheck detail cell");
  assert.match(app, /candidate-precheck-chip[^]*?\$\{marketTagsInfo\(item\)\}\$\{marketAnchor\(item\)\}/,
    "state, tags and market name must be emitted as one heading group");
  assert.match(css, /\.candidate-market-cell > \.market-tags-button \{\s*float: right;\s*width: auto;/,
    "the tags control must stay compact rather than stretching across the card");
});

test("candidate card controls and timestamps fit without horizontal scrolling", () => {
  assert.match(css, /\.candidate-exclusion-control \{\s*display: inline-flex;\s*width: max-content;/,
    "the checkbox and Exclude text stay together");
  assert.match(css, /td\[data-label="Precheck"\]::before \{\s*content: none;/,
    "the old Precheck label cannot appear below Exclude");
  assert.match(css, /td\[data-label="End date"\] \{\s*grid-column: 1 \/ -1;/,
    "End date receives the standalone row before Analysis and Added / updated share one");
  assert.match(css, /td\[data-label="Analysis"\] \{\s*display: flex;\s*flex-wrap: wrap;\s*align-items: center;/,
    "the analysis icon and detail link are aligned on one line");
});
