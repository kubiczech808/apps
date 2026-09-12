// Runs offline: no secrets, no network, no database. api.php is executed as a real request
// with a real segment file on disk and a stubbed storage.php standing in for the mirror.
//
// The preview before the restore. Two numbers come out of it and only one is the obvious
// one: "how many trades come back" is the point, but "how many of the trades the state has
// RIGHT NOW are missing from the database" is what decides whether restoring is safe at
// all. Overwriting a portfolio from a source that is missing today's trades would trade one
// loss for another, and on 2026-09-12 one loss was already enough.
//
// So both directions are driven here, with the second one deliberately made non-zero.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_PATH = new URL("../api.php", import.meta.url).pathname;
const TRIGGER_KEY = "test-trigger-key";
const PORTFOLIO = "underwaycopy";

// The separator storage.php joins the identity with: implode("\x1F", ...). Named rather
// than inlined because a raw control character in source is invisible in a diff, and this
// one byte is the whole reason the two independent key computations agree.
const UNIT_SEPARATOR = "\x1f";

// The same identity api.php files a trade under. Written out here rather than imported
// because the test has to be able to disagree with the implementation -- that is the whole
// point of comparing two sets by key.
function tradeKey({ account = "paper", portfolioId = PORTFOLIO, tokenId, roundTrip = 1 }) {
  return createHash("sha256")
    .update([account, portfolioId, `token:${tokenId}`, String(Math.max(1, roundTrip))].join(UNIT_SEPARATOR))
    .digest("hex");
}

// The REAL key function, lifted out of storage.php and injected into the stub below.
//
// Both sides of every comparison are then computed independently: PHP's own implementation
// against the one written out above. A change to either that the other does not follow
// shows up as a mismatch, rather than as agreement between two copies of one mistake --
// which is the only way a set comparison can be trusted to mean anything.
const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");
const REAL_TRADE_KEY = (() => {
  const start = STORAGE.indexOf("function trading_storage_trade_key(array $trade): string");
  assert.ok(start > 0, "trading_storage_trade_key must be findable in storage.php");
  const end = STORAGE.indexOf("\n}", start);
  assert.ok(end > start, "and it must be a complete function");
  return STORAGE.slice(start, end + 2);
})();

const publishedTrade = (tokenId, openedAt) => ({
  tokenId, openedAt, status: "PENDING_RESOLUTION", roundTrip: 1, shares: 5,
});

function preview({ publishedTrades, storedKeys, portfolio = PORTFOLIO, ask = portfolio }) {
  const directory = mkdtempSync(join(tmpdir(), "restore-preview-"));
  try {
    mkdirSync(join(directory, "data"), { recursive: true });
    copyFileSync(API_PATH, join(directory, "api.php"));
    writeFileSync(join(directory, "config.php"), `<?php return ['trigger_key' => '${TRIGGER_KEY}'];`);

    // A real segmented state on disk: a core carrying nothing but the manifest, and one
    // portfolio segment beside it. This is the shape the hosting actually has.
    writeFileSync(join(directory, "data", "paper-state.json"), JSON.stringify({
      schemaVersion: 7,
      paperPortfolios: {},
      stateSegments: { [`portfolio:${portfolio}`]: { file: `paper-state.portfolio-${portfolio}.json` } },
    }));
    writeFileSync(join(directory, "data", `paper-state.portfolio-${portfolio}.json`), JSON.stringify({
      paperPortfolio: { displayName: "Underway copy", trades: publishedTrades },
    }));

    writeFileSync(join(directory, "storage.php"), `<?php
      ${REAL_TRADE_KEY}
      function trading_storage_pdo() { return new PDO('sqlite::memory:'); }
      function trading_storage_bootstrap($pdo): void {}
      function trading_storage_is_active(): bool { return false; }
      function trading_storage_observation_counts(): array { return ['SCRAPED' => 0, 'RESOLVED' => 0]; }
      function trading_storage_event_stream_stats(): array { return []; }
      function trading_storage_observation_freshness(): array { return []; }
      function trading_storage_meta_get(string $key) { return null; }
      function trading_storage_document_get(string $key) { return null; }
      function trading_storage_document_put(string $k, string $t, array $p): void {
        file_put_contents(__DIR__ . '/calls.log', "document_put\\n", FILE_APPEND);
      }
      function trading_storage_trade_upsert(array $trade): void {
        file_put_contents(__DIR__ . '/calls.log', "trade_upsert\\n", FILE_APPEND);
      }
      function trading_storage_event_append(string $s, ?string $p, array $q, ?string $o = null): void {}
      function trading_storage_trade_keys_for(string $account, string $portfolio): array {
        file_put_contents(__DIR__ . '/calls.log', "trade_keys_for\\n", FILE_APPEND);
        return json_decode(<<<'JSON'
${JSON.stringify(storedKeys)}
JSON, true);
      }
    `);

    writeFileSync(join(directory, "body.json"), JSON.stringify({ operation: "restore-preview", portfolio: ask }));
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
      $_SERVER['REQUEST_METHOD'] = 'POST';
      $_SERVER['HTTP_X_TRADING_TRIGGER_KEY'] = '${TRIGGER_KEY}';
    `);
    const output = execFileSync("php", [
      "-d", `auto_prepend_file=${join(directory, "prelude.php")}`,
      join(directory, "api.php"),
    ], { encoding: "utf8" });
    let calls = "";
    try {
      calls = execFileSync("cat", [join(directory, "calls.log")], { encoding: "utf8" });
    } catch {
      calls = "";
    }
    return { payload: JSON.parse(output.slice(output.indexOf("{"))), calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The real shape of the incident: a handful of trades published today, hundreds in the
// database, and the today ones present in BOTH because the mirror kept running.
const TODAY = [
  publishedTrade("111", "2026-09-12T08:54:06.000Z"),
  publishedTrade("222", "2026-09-12T10:00:19.000Z"),
];
const STORED_WITH_HISTORY = {
  [tradeKey({ tokenId: "111" })]: { status: "PENDING_RESOLUTION", tokenId: "111", roundTrip: 1, openedAt: "2026-09-12 08:54:06" },
  [tradeKey({ tokenId: "222" })]: { status: "OPEN", tokenId: "222", roundTrip: 1, openedAt: "2026-09-12 10:00:19" },
  [tradeKey({ tokenId: "old-1" })]: { status: "WON", tokenId: "old-1", roundTrip: 1, openedAt: "2026-09-11 18:48:20" },
  [tradeKey({ tokenId: "old-2" })]: { status: "LOST", tokenId: "old-2", roundTrip: 1, openedAt: "2026-09-11 20:11:02" },
  [tradeKey({ tokenId: "old-3" })]: { status: "WON", tokenId: "old-3", roundTrip: 1, openedAt: "2026-09-12 06:30:00" },
};

test("the preview counts what comes back and what is only in the state", () => {
  const { payload, calls } = preview({ publishedTrades: TODAY, storedKeys: STORED_WITH_HISTORY });
  assert.equal(payload.ok, true, `the preview must answer: ${JSON.stringify(payload).slice(0, 400)}`);
  assert.equal(payload.publishedTrades, 2);
  assert.equal(payload.storedTrades, 5);
  assert.equal(payload.wouldRestore, 3, "the three trades the state lost");
  assert.equal(payload.publishedButNotStored, 0,
    "today's trades are in the mirror too, which is what makes a restore safe here");
  assert.equal(payload.oldestRestored, "2026-09-11 18:48:20");
  assert.equal(payload.newestRestored, "2026-09-12 06:30:00");

  // A preview is a preview. Nothing may be written by it, least of all during an incident.
  assert.equal(calls.trim(), "trade_keys_for",
    `the preview must only read, but it called: ${calls}`);
});

test("a trade the database does not have is counted, and counted loudly", () => {
  // The case that must never be silent: restoring over this portfolio would drop token 999.
  // The number exists so that a restore can be refused before it happens rather than
  // explained afterwards.
  const { payload } = preview({
    publishedTrades: [...TODAY, publishedTrade("999", "2026-09-12T10:30:00.000Z")],
    storedKeys: STORED_WITH_HISTORY,
  });
  assert.equal(payload.publishedTrades, 3);
  assert.equal(payload.publishedButNotStored, 1,
    "a published trade missing from the mirror has to show up here");
  assert.equal(payload.wouldRestore, 3, "and it must not change what the restore brings back");
});

test("the trade key is the market and the round trip, so a re-entry is not the same trade", () => {
  // Portfolios re-enter the same market. If the key collapsed those into one row, a restore
  // would quietly merge two trades into one and the counts here would look tidy while doing
  // it -- so the round trip is part of the identity on both sides.
  const reentry = { ...publishedTrade("111", "2026-09-12T11:00:00.000Z"), roundTrip: 2 };
  const { payload } = preview({
    publishedTrades: [...TODAY, reentry],
    storedKeys: {
      ...STORED_WITH_HISTORY,
      [tradeKey({ tokenId: "111", roundTrip: 2 })]: { status: "OPEN", tokenId: "111", roundTrip: 2, openedAt: "2026-09-12 11:00:00" },
    },
  });
  assert.equal(payload.publishedTrades, 3, "a second round trip on the same token is a second trade");
  assert.equal(payload.publishedButNotStored, 0);
  assert.equal(payload.storedTrades, 6);
});

test("a portfolio with no published segment says so, instead of reading as empty", () => {
  // "Nothing to restore" and "you asked about a portfolio that is not there" are the same
  // zero, and only one of them is a reason for a restore driver to stop. The state on disk
  // holds underwaycopy; the question is about something else.
  const { payload } = preview({ publishedTrades: TODAY, storedKeys: {}, ask: "not-a-portfolio" });
  assert.equal(payload.ok, true, "the request is well formed, so it answers");
  assert.equal(payload.segmentFound, false, "and it must say the segment is not there");
  assert.equal(payload.publishedTrades, 0);
  assert.equal(payload.wouldRestore, 0);

  // While the portfolio that IS published reports the opposite, from the same code path.
  const real = preview({ publishedTrades: TODAY, storedKeys: STORED_WITH_HISTORY });
  assert.equal(real.payload.segmentFound, true);
});
