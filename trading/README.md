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
- `POLYMARKET_DEPOSIT_WALLET_ADDRESS`: Polymarket deposit wallet/funder address.
- `POLYMARKET_SIGNATURE_TYPE`: use `3` for the current deposit-wallet flow unless you know the account uses another wallet type.
- `TRADING_BANKROLL_USDC`: total bankroll used by the safety check, for example `100`.
- `MAX_ORDER_FRACTION`: max order fraction of bankroll, default recommendation `0.05`.

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
