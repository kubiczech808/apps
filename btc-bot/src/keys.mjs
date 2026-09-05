// Keys that are known to be public, and what that disqualifies them from.
//
// `kubiczech808/apps` is a public repository. A dashboard key committed to it —
// including as a workflow default — is readable by anyone, permanently, and no
// amount of care later removes it from the history.
//
// That is an acceptable trade for a paper portfolio: the worst an outsider can
// do is pause a simulation. It stops being acceptable the moment the bot holds
// LN Markets credentials, and "remember to change the key first" is exactly the
// kind of thing nobody remembers six weeks later.
//
// So the rule is enforced instead of documented: a publicly-known key may guard
// paper, and may not guard money. Both the runner and api.php check this, since
// either one alone leaves the other as a way in.

export const PUBLIC_DEV_KEYS = ['ahoj1234567890']

export const isPublicKey = (key) => PUBLIC_DEV_KEYS.includes(String(key ?? ''))

export const PUBLIC_KEY_REFUSAL =
  'the dashboard key is one that is published in a public repository, so it cannot guard a funded account — ' +
  'set a BTC_BOT_KEY secret (it overrides the committed default) before switching to mainnet'
