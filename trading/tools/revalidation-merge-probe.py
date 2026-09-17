#!/usr/bin/env python3
"""Ask the live-revalidation-merge endpoint what it actually answers.

Manual only. Nothing here changes the catalogue: the first call sends no updates at all,
and the second sends a verdict for a token id that cannot exist, so the merge matches
nothing and writes nothing. Both are the endpoint's own no-op paths.

It exists because a live execution's persist step started failing and the one line naming
the reason sits in the middle of a job log this container cannot fetch. Guessing produced
two hypotheses and a local test killed the second of them -- a 128 MB PHP handles the
19 MB catalogue decode fine -- so this asks the production endpoint instead of theorising
about it a third time.

Environment:
  TRADING_TRIGGER_KEY          the key the endpoint requires
  LIVE_REVALIDATION_MERGE_URL  optional override of the endpoint
"""
import json
import os
import urllib.error
import urllib.request

url = os.environ.get("LIVE_REVALIDATION_MERGE_URL") or (
    "https://osobnizkusenosti.cz/trading/api.php?action=live-revalidation-merge"
)
key = os.environ.get("TRADING_TRIGGER_KEY", "")
print(f"Endpoint: {url}")
print(f"Trigger key: {'configured, ' + str(len(key)) + ' characters' if key else 'NOT CONFIGURED'}\n")


def call(label, payload, headers):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    print(f"== {label}")
    print(f"   sent {len(body)} bytes: {json.dumps(payload)[:160]}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8", "replace")
            print(f"   HTTP {response.status} {response.headers.get('Content-Type')}")
            print(f"   final url: {response.geturl()}")
            print(f"   body: {raw[:600]}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        print(f"   HTTP {error.code} {error.headers.get('Content-Type')}")
        # The whole point: a PHP fatal or an HTML error page is what a JSON decode hides.
        print(f"   body: {raw[:900]}")
    except Exception as error:  # noqa: BLE001
        print(f"   transport failure: {type(error).__name__}: {error}")
    print()


authenticated = {"Content-Type": "application/json", "X-Trading-Trigger-Key": key}

# 1. Does the endpoint exist and does the key work? Sends nothing to merge.
call("empty update list (writes nothing)", {"updates": []}, authenticated)

# 2. Does the merge path itself run? This token cannot be in the catalogue, so every row is
#    skipped and no segment is written -- but the endpoint still loads and walks both.
call("one verdict for a token that does not exist (writes nothing)", {"updates": [{
    "tokenId": "probe-token-that-cannot-exist",
    "checkedAt": "2026-09-17T00:00:00.000Z",
    "marketPrice": 0.5,
}]}, authenticated)

# 3. Without the key, to tell "the endpoint is missing" apart from "the key is wrong": a
#    deployed endpoint refuses this with a JSON error, a missing one answers something else.
call("no key at all (expected: a JSON refusal)", {"updates": []}, {"Content-Type": "application/json"})
