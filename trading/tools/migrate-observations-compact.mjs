/* Copy, verify and atomically activate the payload-free observation table. */
const url = String(process.env.TRADING_STORAGE_ADMIN_URL || "").trim();
const key = String(process.env.TRADING_TRIGGER_KEY || "").trim();
const batchSize = Math.max(50, Math.min(2000, Number(process.env.COMPACT_MIGRATION_BATCH_SIZE || 750) || 750));
const maxBatches = Math.max(1, Math.min(2000, Number(process.env.COMPACT_MIGRATION_MAX_BATCHES || 800) || 800));

if (!url || !key) throw new Error("TRADING_STORAGE_ADMIN_URL and TRADING_TRIGGER_KEY are required.");

async function call(operation, input = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Trading-Trigger-Key": key },
    body: JSON.stringify({ operation, ...input }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* error below */ }
  if (!response.ok || !json?.ok) throw new Error(json?.error || `${operation}: HTTP ${response.status}`);
  return json;
}

const prepared = await call("compact-observations-prepare");
console.log(JSON.stringify({ prepared: prepared.result }));
if (prepared.result?.alreadyCompact) process.exit(0);

let after = "";
let copied = 0;
let unreadable = 0;
for (let batch = 0; batch < maxBatches; batch += 1) {
  const result = await call("compact-observations-copy", { after, limit: batchSize });
  const state = result.batch || {};
  copied += Number(state.copied || 0);
  unreadable += Number(state.unreadable || 0);
  after = String(state.cursor || after);
  if ((batch + 1) % 20 === 0 || state.done) {
    console.log(JSON.stringify({ batch: batch + 1, copied, unreadable, cursor: after, done: Boolean(state.done) }));
  }
  if (state.done) break;
  if (batch + 1 === maxBatches) throw new Error(`Copy did not finish in ${maxBatches} bounded batches.`);
}

if (unreadable > 0) throw new Error(`${unreadable} source rows could not be decoded; refusing activation.`);
const verification = await call("compact-observations-verify");
console.log(JSON.stringify({ verification: verification.verification }));
if (!verification.verification?.verified) throw new Error("Compact copy did not verify; source table remains authoritative.");
const activated = await call("compact-observations-activate", { confirm: "ACTIVATE_PAYLOADLESS_OBSERVATIONS" });
console.log(JSON.stringify({ activated: activated.result }));
