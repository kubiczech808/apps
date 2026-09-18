#!/usr/bin/env python3
"""What a deploy may delete from the published directory, and when it must refuse to.

The bug this exists to fix, from trading-deploy.yml:

    for name in list_names(ftp):
        if name == "data":
            clean_data_dir(ftp)
            continue
    if name not in deploy_roots:        # <-- OUTSIDE the loop
        remove_tree(ftp, name)

Python leaves the loop variable bound to the LAST entry, so the removal ran exactly once,
against whichever name the server happened to list last. Every other stale directory was
never cleaned -- and the one that was deleted was chosen by directory order rather than by
intent. On an empty listing the name is unbound and the deploy dies with a NameError.

Simply indenting the `if` is not the fix on its own. It would turn a loop that deleted at
most one entry into one that deletes every entry not in deploy_roots, on a host that serves
a live site, in the same file that took the site down once already. So the decision is here,
where it can be executed by a test, and it refuses rather than guesses whenever the inputs
look wrong:

  * deploy_roots carrying nothing but "data" means no files were uploaded, so the whole
    published directory would read as stale
  * a candidate list larger than the roots themselves means the roots are probably wrong,
    not that the server is full of rubbish
  * names that are not simple entries are left alone rather than passed to a delete

A refusal costs a stale directory until someone looks. The other way costs the site.
"""

from __future__ import annotations

# Above this, the listing is more likely to be something other than a stale deploy -- a
# document root shared with another app, a backup folder someone put there -- and deleting
# it is not what this was written to do.
MAX_REMOVALS = 8


def stale_entries(names, deploy_roots, keep=("data",)) -> dict:
    """Which published entries a deploy may remove, or why it must not remove any."""
    listed = [str(name) for name in (names or [])]
    roots = {str(root) for root in (deploy_roots or set())}
    protected = set(keep) | roots

    if not listed:
        # Nothing listed is the shape that raised NameError before. It is also what a failed
        # or refused listing looks like, and deleting on the strength of it is exactly wrong.
        return {"remove": [], "refuse": "the published directory listed no entries at all"}

    # "data" plus nothing else means the upload set was empty, so every published entry would
    # be stale -- which is never true and always a sign the roots were built wrong.
    if not roots - set(keep):
        return {"remove": [], "refuse":
                "deploy_roots carries nothing but the kept names, so no files were uploaded"}

    candidates = []
    skipped = []
    for name in listed:
        if name in protected:
            continue
        # A name with a path separator, or one of the directory's own links, is not an entry
        # this may act on. Passing it to a recursive delete is how a cleanup escapes its
        # directory.
        if name in {".", ".."} or "/" in name or "\\" in name or name.strip() != name or not name:
            skipped.append(name)
            continue
        candidates.append(name)

    if len(candidates) > MAX_REMOVALS:
        return {"remove": [], "refuse":
                f"{len(candidates)} entries look stale, which is more than the {MAX_REMOVALS}"
                " a deploy should ever have to clean; the roots are more likely wrong",
                "candidates": candidates, "skipped": skipped}

    return {"remove": candidates, "refuse": None, "skipped": skipped}
