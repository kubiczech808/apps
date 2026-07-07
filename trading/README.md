# Polymarket Trading PoC

This PoC keeps public market discovery separate from private order execution.

## Public UI

`index.html` and `api.php` only read public Polymarket market data. They never receive a private key and never submit live orders.

## Local executor

Install dependencies inside `trading/`:

```powershell
npm install
```

Create a local `.env.local` or provide environment variables matching `.env.example`.

Dry-run signed order:

```powershell
npm run order:poc -- --token-id TOKEN_ID --side BUY --price 0.50 --size 10 --tick-size 0.01
```

Live submit requires both:

```powershell
$env:POLYMARKET_DRY_RUN = "false"
npm run order:poc -- --token-id TOKEN_ID --side BUY --price 0.50 --size 10 --tick-size 0.01 --confirm-live
```

Do not paste private keys into chat, GitHub issues, or committed files.

## Required GitHub Secrets for API trading smoke test

Create these repository secrets before running `Polymarket Order Smoke`:

- `POLYMARKET_PRIVATE_KEY`: private key for a dedicated trading/session wallet, never a main wallet.

The current Google/Magic proxy account uses these non-secret workflow defaults:

- Funder address: `0x3252de913d9323667f21f4d88fa1f996fc282293`
- Signature type: `1` (`POLY_PROXY`)
- Dry-run bankroll: `100`
- Max order fraction: `0.05`

Optional only if we later choose not to derive L2 credentials from the private key:

- `POLYMARKET_API_KEY`
- `POLYMARKET_API_SECRET`
- `POLYMARKET_API_PASSPHRASE`

The private key is still required for order creation because Polymarket orders are signed EIP-712 messages.

## First live API proof

Use a dedicated wallet with a small balance, for example 5-20 USDC.

1. Run `Polymarket Order Smoke` with `live_confirm=false`.
2. Confirm it returns `signed-dry-run`.
3. Run a tiny order with `live_confirm=true`, conservative price, and size small enough to stay below `MAX_ORDER_FRACTION`.
4. Verify the order appears in Polymarket and can be cancelled.
