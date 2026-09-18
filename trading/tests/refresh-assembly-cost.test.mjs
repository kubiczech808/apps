// Runs offline: storage.php's real function is EXECUTED against a stub PDO and stub document
// reads. No database, no network, no credentials.
//
// This measures the one thing the MySQL cutover is blocked on. The paper bot rebuilds its
// whole state from summary=refresh; served from the database that read answers with
// `state:paper`, which holds the portfolios and their parameters but not their trades --
// each portfolio's trades are a document of their own and the refresh read names none. On
// 2026-09-12 it returned thirty-six portfolios with no trades, the bot published that back
// over the files, and every paper history was lost. api.php refuses the read from the
// database now, and the refusal says what would lift it: "until the database path can
// assemble every portfolio's trades within this hosting's memory."
//
// So the value of this function is entirely in whether its verdict can be trusted. A cost
// probe that says "fits" when it does not is worse than no probe: it is the evidence
// somebody flips the switch on.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORAGE = readFileSync(new URL("../storage.php", import.meta.url), "utf8");

function extractPhpFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > 0, `${signature} must exist in storage.php`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, "the function must be complete");
  return source.slice(start, end + 2);
}

// Only the PDO hint is relaxed; the body is the deployed one byte for byte. pdo_mysql is
// loaded here, so a stub class named PDO cannot be declared and PDO::query cannot be
// overridden compatibly by anything returning a fake statement.
const COST = extractPhpFunction(STORAGE, "function trading_storage_refresh_assembly_cost(PDO $pdo): array")
  .replace("function trading_storage_refresh_assembly_cost(PDO $pdo): array",
    "function trading_storage_refresh_assembly_cost($pdo): array");
assert.doesNotMatch(COST, /\bPDO\b/, "only the type hint may differ from the deployed body");

// The documents are BUILT IN PHP from a small spec rather than passed in as JSON. A fixture
// large enough to test the memory verdict is large enough that decoding it in the harness
// costs more than the function does -- the first version of this test died on its own
// fixture under a 16M limit, which measured the test and not the code.
function runCost(spec, { memoryLimit = "512M" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "refresh-cost-"));
  const script = join(dir, "run.php");
  writeFileSync(script, `<?php
${COST}

function trading_storage_bootstrap($pdo): void {}

// key => [trades, padding bytes per trade, wrapped?] or null for "the mirror never wrote it"
$SPEC = json_decode(${JSON.stringify(JSON.stringify(spec))}, true);

function trading_storage_document_get(string $key) {
    global $SPEC;
    $entry = $SPEC[$key] ?? null;
    if (!is_array($entry)) {
        return null;
    }
    [$count, $padding, $wrapped] = [$entry[0], $entry[1] ?? 0, $entry[2] ?? true];
    $trades = [];
    for ($index = 0; $index < $count; $index++) {
        $trades[] = [
            'tokenId' => 't' . $index,
            'status' => 'WON',
            'openedAt' => '2026-09-11T10:00:00.000Z',
            'note' => str_repeat('x', $padding),
        ];
    }
    $portfolio = ['displayName' => 'P', 'trades' => $trades];
    return $wrapped ? ['paperPortfolio' => $portfolio] : $portfolio;
}

class StubStatement {
    public function __construct(private array $rows) {}
    public function fetchAll(): array { return $this->rows; }
}

class StubPdo {
    public array $queries = [];
    public function __construct(private array $rows) {}
    public function query(string $sql): StubStatement {
        $this->queries[] = $sql;
        return new StubStatement($this->rows);
    }
}

// Only the keys the SQL would match: the stub stands in for the WHERE clause, and the
// clause itself is asserted separately.
$rows = [];
foreach (array_keys($SPEC) as $key) {
    if (str_starts_with($key, 'paper-portfolio:')) {
        $rows[] = ['document_key' => $key];
    }
}
$pdo = new StubPdo($rows);
$result = trading_storage_refresh_assembly_cost($pdo);
$result['sql'] = $pdo->queries[0] ?? '';
echo json_encode($result);
`);
  const out = execFileSync("php", ["-d", `memory_limit=${memoryLimit}`, script], { encoding: "utf8" });
  return JSON.parse(out);
}

// [trades, padding bytes per trade, wrapped in paperPortfolio?]
const portfolio = (trades, padding = 0, wrapped = true) => [trades, padding, wrapped];

test("it counts every stored portfolio and every trade in them", () => {
  const result = runCost({
    "paper-portfolio:a": portfolio(3),
    "paper-portfolio:b": portfolio(5),
    "state:paper": [0, 0],
    "portfolio-config": [0, 0],
  });
  assert.equal(result.documentsFound, 2, "only the per-portfolio documents");
  assert.equal(result.documentsLoaded, 2);
  assert.equal(result.trades, 8);
  assert.equal(result.largestPortfolio.key, "paper-portfolio:b");
  assert.equal(result.largestPortfolio.trades, 5);

  // The query asks for exactly those documents, so the stub above is standing in for a real
  // filter rather than hiding its absence.
  assert.match(result.sql, /document_key LIKE 'paper-portfolio:%'/);
  assert.match(result.sql, /^\s*SELECT/);
  assert.doesNotMatch(result.sql, /DELETE|UPDATE|INSERT|ALTER|DROP/i);
});

test("a document the mirror never wrote is named, not counted as empty", () => {
  // The dangerous reading. A portfolio whose document is missing contributes no trades, and
  // a probe that simply adds zero reports a cheap assembly that would in fact serve a
  // portfolio with no history -- which is the 2026-09-12 incident exactly.
  const result = runCost({
    "paper-portfolio:a": portfolio(4),
    "paper-portfolio:gone": null,
  });
  assert.equal(result.documentsFound, 2);
  assert.equal(result.documentsLoaded, 1);
  assert.deepEqual(result.documentsMissing, ["paper-portfolio:gone"]);
  assert.equal(result.trades, 4);
});

test("the older shape, where the document IS the portfolio, is read too", () => {
  const result = runCost({
    "paper-portfolio:old": portfolio(2, 0, false),
  });
  assert.equal(result.trades, 2, "a document without the paperPortfolio wrapper still counts");
});

test("the verdict fails when the assembled response would not comfortably fit", () => {
  // ~1.3 MB of trades under an 8M limit: it would technically fit and must still fail, because
  // the response has to be built beside everything else the request is holding and this host
  // serves other requests at the same time.
  const big = runCost({ "paper-portfolio:a": portfolio(400, 3000) }, { memoryLimit: "8M" });
  assert.ok(big.assembledBytes > 1_200_000, `the fixture must be large: ${big.assembledBytes}`);
  assert.equal(big.fits, false, "a measurement that only just fits is not a pass");
  assert.ok(big.headroomBytes < big.memoryLimitBytes);

  // And the same data under a real 512M limit passes, so "fits" is capable of being true --
  // a verdict that is always false would satisfy the assertion above and tell us nothing.
  const same = runCost({ "paper-portfolio:a": portfolio(400, 3000) }, { memoryLimit: "512M" });
  assert.equal(same.fits, true);
  assert.equal(same.assembledBytes, big.assembledBytes, "same data, only the limit differs");
});

test("the limit is parsed from the host, in the units the host writes it in", () => {
  // Bait for reading ini_get('memory_limit') as an integer: "512M" casts to 512, which makes
  // every assembly look catastrophically over budget and the verdict permanently false.
  const result = runCost({ "paper-portfolio:a": portfolio(2) }, { memoryLimit: "512M" });
  assert.equal(result.memoryLimit, "512M");
  assert.equal(result.memoryLimitBytes, 512 * 1048576);

  const smaller = runCost({ "paper-portfolio:a": portfolio(2) }, { memoryLimit: "64M" });
  assert.equal(smaller.memoryLimitBytes, 64 * 1048576);
});

test("the endpoint exposes it read-only, behind the key", () => {
  const api = readFileSync(new URL("../api.php", import.meta.url), "utf8");
  const start = api.indexOf("if ($operation === 'refresh-assembly-cost') {");
  assert.ok(start > 0, "the operation must be reachable");
  assert.match(api.slice(start, start + 300), /trading_storage_refresh_assembly_cost\(\$pdo\)/);

  const admin = api.slice(api.indexOf("if ($action === 'storage-admin') {"), start);
  assert.match(admin, /require_trading_trigger_key\(\);/);
  assert.match(admin, /REQUEST_METHOD'\] !== 'POST'/);
});
