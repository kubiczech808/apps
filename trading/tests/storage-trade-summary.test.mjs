// Runs offline: no secrets, no network, no database. api.php is executed as a real
// request against a stubbed storage.php.
//
// Added the day the paper trade histories were lost. Every paper portfolio's trades now
// begin within four seconds of 2026-09-12T08:54:03Z and the published segment files were
// overwritten with that same state, so the mirror is the only place a pre-existing row
// could still be. The ingest upserts by trade_key and deletes nothing, which is exactly
// why it is worth asking -- but only if asking is cheap and cannot itself change anything.
//
// So this drives the request end to end and checks two things that matter more than the
// numbers: that the operation answers at all, and that it is READ-ONLY. A diagnostic
// reached for in the middle of a data-loss incident must not be able to make it worse.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;
const API = readFileSync(API_PATH, "utf8");

const TRIGGER_KEY = "test-trigger-key";

// The rows a mirror that still holds pre-reset history would return: a portfolio whose
// first trade predates the reset, beside one that only has today's.
const SUMMARY_ROWS = [
  { account: "paper", portfolioId: "underwaycopy", total: 41, open: 2, closed: 39,
    realized: -3.2, firstOpenedAt: "2026-08-29 11:02:00", lastUpdatedAt: "2026-09-12 08:54:50" },
  { account: "paper", portfolioId: "leagueoflegends", total: 1, open: 1, closed: 0,
    realized: 0, firstOpenedAt: "2026-09-12 09:49:45", lastUpdatedAt: "2026-09-12 09:49:45" },
];

function request({ operation = "trade-summary", key = TRIGGER_KEY, method = "POST" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "trade-summary-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeFileSync(join(directory, "config.php"), `<?php return ['trigger_key' => '${TRIGGER_KEY}'];`);
    // A PDO the action will accept, and a record of every statement it is asked to run --
    // which is how "read-only" is checked rather than asserted.
    writeFileSync(join(directory, "storage.php"), `<?php
      function trading_storage_pdo() { return new PDO('sqlite::memory:'); }
      function trading_storage_bootstrap($pdo): void {}
      // trading_storage_diagnostics() is declared by api.php itself, so it is not stubbed.
      function trading_storage_is_active(): bool { return false; }
      function trading_storage_trade_summary(): array {
        file_put_contents(__DIR__ . '/calls.log', "trade_summary\\n", FILE_APPEND);
        return json_decode(<<<'JSON'
${JSON.stringify(SUMMARY_ROWS)}
JSON, true);
      }
      function trading_storage_observation_counts(): array { return ['SCRAPED' => 0, 'RESOLVED' => 0]; }
      function trading_storage_event_stream_stats(): array { return []; }
      function trading_storage_observation_freshness(): array { return []; }
      function trading_storage_meta_get(string $key) { return null; }
      function trading_storage_meta_set(string $key, $value): void {
        file_put_contents(__DIR__ . '/calls.log', "meta_set\\n", FILE_APPEND);
      }
      function trading_storage_document_get(string $key) { return null; }
      function trading_storage_document_put(string $k, string $t, array $p): void {
        file_put_contents(__DIR__ . '/calls.log', "document_put\\n", FILE_APPEND);
      }
      function trading_storage_event_append(string $s, ?string $p, array $q, ?string $o = null): void {
        file_put_contents(__DIR__ . '/calls.log', "event_append\\n", FILE_APPEND);
      }
    `);
    // The request is assembled in a prelude rather than on the command line, because
    // api.php has to be the MAIN script: the CLI maps php://input to stdin only for the
    // script it runs, and request_payload() reads the body from there. Injecting $_GET via
    // `php -r ... require api.php` left the body empty, so the operation silently became
    // the default one -- which is the kind of pass a test is supposed to catch.
    writeFileSync(join(directory, "body.json"), JSON.stringify({ operation }));
    // The CLI serves php://input as empty -- measured, not assumed -- so the body is
    // delivered by replacing the php:// wrapper for the length of the request. api.php
    // uses php:// for exactly one thing, php://input in request_payload(), so nothing
    // else is affected. Without this the body arrived empty and the operation silently
    // became the default one, which is the kind of pass a test exists to catch.
    writeFileSync(join(directory, "prelude.php"), `<?php
      class TestInputStream {
        public $context;
        private $offset = 0;
        private $body = '';
        public function stream_open($path, $mode, $options, &$opened) {
          $this->body = (string) file_get_contents(__DIR__ . '/body.json');
          return true;
        }
        public function stream_read($count) {
          $chunk = substr($this->body, $this->offset, $count);
          $this->offset += strlen($chunk);
          return $chunk;
        }
        public function stream_eof() { return $this->offset >= strlen($this->body); }
        public function stream_stat() { return ['size' => strlen($this->body)]; }
        public function stream_seek($offset, $whence = SEEK_SET) { $this->offset = $offset; return true; }
        public function stream_tell() { return $this->offset; }
      }
      stream_wrapper_unregister('php');
      stream_wrapper_register('php', 'TestInputStream');
      $_GET['action'] = 'storage-admin';
      $_SERVER['REQUEST_METHOD'] = '${method}';
      $_SERVER['HTTP_X_TRADING_TRIGGER_KEY'] = '${key}';
    `);
    const output = execFileSync("php", [
      "-d", `auto_prepend_file=${join(directory, "prelude.php")}`,
      join(directory, "api.php"),
    ], { encoding: "utf8" });
    let calls = "";
    try {
      calls = readFileSync(join(directory, "calls.log"), "utf8");
    } catch {
      calls = "";
    }
    return { output, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the mirror can be asked what trades it still holds", () => {
  // This is the real dispatch: api.php's own routing, its own key guard, its own
  // respond(). Only storage.php is a stub.
  const { output, calls } = request();
  const payload = JSON.parse(output.slice(output.indexOf("{")));
  assert.equal(payload.ok, true, `the operation must answer: ${output.slice(0, 400)}`);
  assert.equal(payload.operation, "trade-summary");
  assert.ok(Array.isArray(payload.trades), `the rows must come back: ${JSON.stringify(payload).slice(0, 300)}`);
  assert.equal(payload.trades.length, 2);

  // The number this was built to see: a first trade older than the reset means the row
  // survived it, and a restore is possible. Without it there is nothing to restore from.
  const surviving = payload.trades.find((row) => String(row.portfolioId) === "underwaycopy");
  assert.ok(surviving, `the portfolio must be reported by id: ${JSON.stringify(payload.trades)}`);
  assert.equal(surviving.total, 41);
  assert.ok(String(surviving.firstOpenedAt) < "2026-09-12T08:54",
    "a first-opened stamp is what says whether anything predates the reset");

  assert.equal(calls.trim(), "trade_summary",
    `a diagnostic run during a data-loss incident must read and nothing else, but it called: ${calls}`);
});

test("it refuses without the key, and refuses a GET", () => {
  // The same guard as every other storage-admin operation. Checked by running it, because
  // an operation added in a hurry is exactly the one that ends up outside the guard.
  const wrongKey = request({ key: "not-the-key" });
  const refused = JSON.parse(wrongKey.output.slice(wrongKey.output.indexOf("{")));
  assert.equal(refused.ok, false, "an unauthenticated call must not be answered with data");
  assert.equal(wrongKey.calls.trim(), "", "and it must not have reached the database at all");

  const viaGet = request({ method: "GET" });
  const refusedGet = JSON.parse(viaGet.output.slice(viaGet.output.indexOf("{")));
  assert.equal(refusedGet.ok, false, "storage-admin is POST only");
  assert.match(String(refusedGet.error), /POST/);
});
