// Read-only diagnostic. Writes nothing, publishes nothing, places no orders, and never
// reads or prints a key: it compares ADDRESSES and signature-type NUMBERS only.
//
// Reported: a live position kept falling with the stop loss configured, watched, and
// firing. The worker's own state file showed the mechanism working end to end --
//
//   stopPrice 0.129981  triggerPrice 0.131981  bestBid 0.01  exitPrice 0.01  tickSize 0.01
//   crossing {"recoveredFraction":0.076934,"gapped":true}
//   type EXIT_REJECTED
//   response {"success":false,"status":400,
//             "error":"the order signer address has to be the address of the API KEY"}
//
// -- 106 rejections across 6 tokens, every one of them status 400 with that same message,
// and every attempt left terminal:false so the worker retried forever. So detection, tick
// rounding and gap-selling are all correct; the exchange is refusing to accept the order
// at all.
//
// That message is about WHO SIGNED. The CLOB derives an address from the order signature
// and requires it to be the address that owns the L2 API key. Both the executor and the
// worker build their credentials the same way -- createOrDeriveApiKey() from the same
// private key -- so the API key address is the same for both. What differs is
// signatureType, which is what decides whether the order's `signer` field is the EOA that
// owns the API key or the proxy/1271 contract that holds the funds.
//
// And the two paths get that number from different places:
//
//   live-order-executor.mjs  liveTradingConfig(): liveState.account.trading.signatureType
//                            ?? accountDiscovery.selectedSignatureType, then the env
//   rpi-live-exit-worker.mjs Number(process.env.POLYMARKET_SIGNATURE_TYPE || 3)
//
// The executor learns the account's real configuration from the published live state. The
// worker cannot: it takes the environment's value, and the workflow writes
// `secrets.POLYMARKET_SIGNATURE_TYPE || '3'`, so with that secret unset the worker signs
// as 3 no matter what the account actually is. Buys keep working, every protective sell is
// refused, and the difference is invisible because nothing compares the two.
//
// This prints both numbers side by side and says whether they agree.
const HOST = process.env.TRADING_HOST || "https://osobnizkusenosti.cz/trading";

// Mirrors the map both clients use, so the printed name is the one actually signed with.
const SIGNATURE_TYPE_NAMES = {
  0: "EOA          (maker = signer = the wallet's own address)",
  1: "POLY_PROXY   (maker = the proxy, signer = the EOA that owns the API key)",
  2: "GNOSIS_SAFE  (maker = the Safe, signer = the EOA that owns the API key)",
  3: "POLY_1271    (contract-validated signature)",
};

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const num = (value) => {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const describe = (value) => (value == null ? "(not set)" : `${value}  ${SIGNATURE_TYPE_NAMES[value] || "(unknown type)"}`);

async function main() {
  console.log(`Live exit signing diagnosis at ${new Date().toISOString()}`);
  console.log("Read-only: no order is placed, no key is read, only addresses and type numbers are printed.\n");

  const payload = await fetchJson(`${HOST}/api.php?action=state&target=live&t=${Date.now()}`);
  const liveState = payload?.state || payload || {};
  const trading = liveState?.account?.trading || {};
  const discovery = liveState?.accountDiscovery || {};

  console.log("== 1. what the ACCOUNT actually is, as discovered and published");
  console.log(`   account.trading.signatureType            ${describe(num(trading.signatureType))}`);
  console.log(`   accountDiscovery.selectedSignatureType   ${describe(num(discovery.selectedSignatureType))}`);
  console.log(`   account.trading.funderAddress            ${trading.funderAddress || "(not set)"}`);
  console.log(`   accountDiscovery.selectedFunderAddress   ${discovery.selectedFunderAddress || "(not set)"}`);
  console.log(`   account.address                          ${liveState?.account?.address || "(not set)"}`);

  // The executor's own resolution order, restated here rather than imported: importing it
  // would read POLYMARKET_* from this runner's environment, which is not the Pi's.
  const executorSignatureType = num(trading.signatureType) ?? num(discovery.selectedSignatureType);
  const executorFunder = trading.funderAddress || discovery.selectedFunderAddress || null;

  console.log(`\n== 2. what each path signs with`);
  console.log(`   live-order-executor.mjs  (buys, and they are being accepted)`);
  console.log(`      signatureType   ${describe(executorSignatureType)}`);
  console.log(`      funderAddress   ${executorFunder || "(falls back to its env default)"}`);
  console.log(`      source          liveState.account.trading, else accountDiscovery, else env`);
  console.log(`   rpi-live-exit-worker.mjs (protective sells, and they are being refused)`);
  console.log(`      signatureType   ${describe(num(process.env.POLYMARKET_SIGNATURE_TYPE) ?? 3)}`);
  console.log(`      source          POLYMARKET_SIGNATURE_TYPE only, defaulting to 3`);
  console.log(`                      -- the account's published configuration is never read`);

  console.log(`\n== 3. do they agree`);
  const workerSignatureType = num(process.env.POLYMARKET_SIGNATURE_TYPE) ?? 3;
  if (executorSignatureType == null) {
    console.log("   INCONCLUSIVE: the live state publishes no discovered signature type, so the");
    console.log("   executor is falling back to its own env default too. Compare the Pi's");
    console.log("   POLYMARKET_SIGNATURE_TYPE against the live workflow's before concluding.");
  } else if (executorSignatureType === workerSignatureType) {
    console.log(`   They agree on ${workerSignatureType}. The signer mismatch is NOT explained by`);
    console.log("   signatureType, and the private key or funder address is the next thing to check.");
  } else {
    console.log(`   NO. The account is ${executorSignatureType} and the worker signs as ${workerSignatureType}.`);
    console.log("   A protective sell signed under the wrong type presents a signer the API key does");
    console.log("   not own, which is exactly the 400 every exit came back with.");
  }

  console.log(`\n== 4. what is still exposed`);
  const positions = Array.isArray(liveState?.positions) ? liveState.positions : [];
  const open = positions.filter((position) => {
    const status = String(position?.status || "OPEN").toUpperCase();
    return !["WON", "LOST", "CLOSED", "REDEEMED", "CANCELED", "CANCELLED"].includes(status);
  });
  console.log(`   open positions  ${open.length}`);
  let exposed = 0;
  for (const position of open) {
    const cost = num(position?.totalCostUsdc) ?? num(position?.costUsdc) ?? num(position?.stakeUsdc);
    const value = num(position?.currentValueUsdc) ?? num(position?.marketValueUsdc);
    if (cost == null || value == null) continue;
    const loss = cost - value;
    if (loss <= 0) continue;
    exposed += 1;
    console.log(`      down ${loss.toFixed(2).padStart(6)} of ${cost.toFixed(2).padStart(6)}  ${String(position?.question || "").slice(0, 60)}`);
  }
  if (!exposed) console.log("      (no open position is currently showing a loss)");
}

main().catch((error) => {
  console.error(`diagnosis failed: ${error?.message || error}`);
  process.exitCode = 1;
});
