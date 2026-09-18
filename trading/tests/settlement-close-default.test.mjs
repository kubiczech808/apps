// Runs offline: api.php's own normalisers are executed. No network, no secrets.
//
// Asked for: "nastav close at certainity na 99.9 by default".
//
// It already was 99.9% in every config template. What it was not was the answer for a row
// that simply has no such key: that fell through the ?? to null, the normaliser turned null
// into 0, and 0 reads as off. So a portfolio created without ever touching the setting
// shipped with the close disabled while the default beside it said 99.9%.
//
// The distinction that has to survive is between ABSENT and an explicit 0: 0 is how a
// portfolio says it does not want the shortcut, and a default must not override that.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = readFileSync(new URL("../api.php", import.meta.url), "utf8");

function run(expression) {
  const directory = mkdtempSync(join(tmpdir(), "close-bid-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    const definitions = join(directory, "definitions.php");
    writeFileSync(definitions, API.slice(0, API.indexOf("\ntry {")) + "\n");
    return JSON.parse(execFileSync("php", ["-r",
      `chdir('${directory}'); require '${definitions}'; echo json_encode(${expression});`,
    ], { encoding: "utf8", cwd: directory }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the default is 99.9%", () => {
  assert.equal(run("DEFAULT_SETTLEMENT_CLOSE_BID"), 0.999);
});

test("a portfolio that never set it gets the default, not off", () => {
  // The row path: what a created portfolio's stored row looks like before anyone opens the
  // parameter form.
  assert.match(API, /array_key_exists\('settlementCloseBid', \$row\)\n\s+\? normalize_settlement_close_bid_value\(\$row\['settlementCloseBid'\]\)\n\s+: DEFAULT_SETTLEMENT_CLOSE_BID;/);
  // And the config path, where a save that omits the field must not silently switch it off.
  assert.match(API, /array_key_exists\('settlementCloseBid', \$input\)/);
});

test("an explicit off stays off", () => {
  // 0 is how a portfolio says it does not want the shortcut. A default that overrode that
  // would re-enable a close somebody deliberately turned off, on every portfolio at once.
  assert.equal(run("normalize_settlement_close_bid_value(0)"), 0);
  assert.equal(run("normalize_settlement_close_bid_value('0')"), 0);
  assert.equal(run("normalize_settlement_close_bid_value('')"), 0);
});

test("a set value is still honoured and still bounded", () => {
  assert.equal(run("normalize_settlement_close_bid_value(0.99)"), 0.99);
  assert.equal(run("normalize_settlement_close_bid_value(0.95)"), 0.95);
  // The ceiling is 0.999 and the floor 0.5: a close above certainty cannot fill, and one
  // far below it is a sale rather than a settlement shortcut.
  assert.equal(run("normalize_settlement_close_bid_value(1.5)"), 0.999);
  assert.equal(run("normalize_settlement_close_bid_value(0.1)"), 0.5);
});
