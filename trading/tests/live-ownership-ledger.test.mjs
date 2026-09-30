import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const API = readFileSync(new URL("../api.php", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("live ownership has a durable trade-ledger source", () => {
  const start = STORAGE.indexOf("function trading_storage_live_trade_ownership");
  assert.ok(start > 0);
  const body = STORAGE.slice(start, STORAGE.indexOf("\n}\n", start));
  assert.match(body, /FROM trading_trades/);
  assert.match(body, /account = "live"/);
  assert.match(body, /portfolio_id <> ""/);
  assert.match(body, /token_id IS NOT NULL/);
  assert.match(body, /LIMIT '\s*\.\s*\$limit/);
});

test("the ownership endpoint reads the durable ledger after rolling sources", () => {
  const call = API.indexOf("foreach (trading_storage_live_trade_ownership(20000) as $entry)");
  const response = API.indexOf("respond([", call);
  assert.ok(call > 0 && response > call);
  assert.match(API.slice(call, response), /stored-trade-ledger/);
  assert.match(API.slice(call, response), /entryPrice/);
  assert.match(API.slice(call, response), /openedAt/);
});
