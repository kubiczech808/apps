#!/usr/bin/env node

const HOST = process.env.POLYMARKET_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.POLYMARKET_CHAIN_ID || 137);
const DRY_RUN = String(process.env.POLYMARKET_DRY_RUN ?? "true").toLowerCase() !== "false";

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readOrderArgs() {
  const tokenID = arg("token-id");
  const side = String(arg("side", "BUY")).toUpperCase();
  const price = Number(arg("price"));
  const size = Number(arg("size"));
  const tickSize = String(arg("tick-size", "0.01"));
  const negRisk = String(arg("neg-risk", "false")).toLowerCase() === "true";
  const orderType = String(arg("order-type", "GTC")).toUpperCase();

  if (!tokenID || !/^\d+$/.test(tokenID)) fail("--token-id must be a Polymarket CLOB token id");
  if (!["BUY", "SELL"].includes(side)) fail("--side must be BUY or SELL");
  if (!Number.isFinite(price) || price <= 0 || price >= 1) fail("--price must be between 0 and 1");
  if (!Number.isFinite(size) || size <= 0) fail("--size must be positive");
  if (!["GTC", "GTD", "FOK", "FAK"].includes(orderType)) fail("--order-type must be GTC, GTD, FOK, or FAK");

  const bankroll = Number(process.env.TRADING_BANKROLL_USDC || 0);
  const maxFraction = Number(process.env.MAX_ORDER_FRACTION || 0.05);
  const notional = side === "BUY" ? price * size : size;
  if (bankroll > 0 && notional > bankroll * maxFraction) {
    fail(`Order notional ${notional.toFixed(2)} exceeds max allocation ${(bankroll * maxFraction).toFixed(2)}`);
  }

  return { tokenID, side, price, size, tickSize, negRisk, orderType, notional };
}

function printJson(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const order = readOrderArgs();
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || process.env.POLYMARKET_DEPOSIT_WALLET_ADDRESS;
  const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 3);

  if (!privateKey || !funderAddress) {
    printJson({
      mode: "unsigned-draft",
      reason: "POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_ADDRESS are required to sign orders",
      order,
    });
    return;
  }

  const [{ ClobClient, Side, OrderType, SignatureTypeV2 }, { createWalletClient, custom }, { privateKeyToAccount }] =
    await Promise.all([
      import("@polymarket/clob-client-v2"),
      import("viem"),
      import("viem/accounts"),
    ]);

  const signatureTypeMap = {
    0: SignatureTypeV2.EOA,
    1: SignatureTypeV2.POLY_PROXY,
    2: SignatureTypeV2.GNOSIS_SAFE,
    3: SignatureTypeV2.POLY_1271,
  };

  const account = privateKeyToAccount(privateKey);
  const signer = createWalletClient({
    account,
    transport: custom({
      request: async ({ method }) => {
        throw new Error(`Unexpected JSON-RPC request while signing Polymarket order: ${method}`);
      },
    }),
  });
  const tempClient = new ClobClient({ host: HOST, chain: CHAIN_ID, signer });
  const creds = await tempClient.createOrDeriveApiKey();
  const client = new ClobClient({
    host: HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: signatureTypeMap[signatureType] ?? SignatureTypeV2.POLY_1271,
    funderAddress,
  });

  const signedOrder = await client.createOrder(
    {
      tokenID: order.tokenID,
      price: order.price,
      size: order.size,
      side: order.side === "BUY" ? Side.BUY : Side.SELL,
    },
    {
      tickSize: order.tickSize,
      negRisk: order.negRisk,
    },
  );

  if (DRY_RUN || !hasFlag("confirm-live")) {
    printJson({
      mode: "signed-dry-run",
      dryRun: DRY_RUN,
      requiresLiveFlag: !hasFlag("confirm-live"),
      order,
      signedOrder,
    });
    return;
  }

  const response = await client.postOrder(signedOrder, OrderType[order.orderType]);
  if (response?.error || response?.success === false || response?.status === "error") {
    printJson({ mode: "live-submit-rejected", order, response });
    process.exit(1);
  }
  printJson({ mode: "live-submit", order, response });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
