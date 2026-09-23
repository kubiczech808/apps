import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../.github/workflows/trading-dip-history-backtest.yml", import.meta.url), "utf8");

test("historical DIP backtest continues in serialized batches until its report is complete", () => {
  assert.match(workflow, /actions: write/, "the workflow needs permission to queue its successor");
  assert.match(workflow, /cancel-in-progress: false/, "a queued successor must not cancel its publisher");
  assert.match(workflow, /name: Queue next historical batch/);
  assert.match(workflow, /node tools\/queue-dip-backtest-batch\.mjs/);
});
