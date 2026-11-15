#!/usr/bin/env python3
"""Let a release reuse a full regression that passed on the same source tree.

Squash merges mean the commit landing on main is new while the files it carries
are identical to the pull request branch head. The tree sha is what identifies
those files, so a manual ``workflow_dispatch`` run of ``full-regression.yml``
on the branch covers the release just as well as a run on the merge commit.

``pick_run`` is the decision. ``main`` is the workflow step: it gathers the
metadata through the ``gh`` CLI and writes the ``passed`` job output. Any
failure is reported and answered with ``passed=false``, so the regression runs
in the release workflow exactly as it did before this script existed.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path

REPLAYABLE_EVENTS = frozenset({"push", "workflow_dispatch"})
CANDIDATE_RUNS = 40


def pick_run(
    runs: Iterable[Mapping[str, object]] | None,
    tree_of: Callable[[str], str | None],
    target_tree: str | None,
) -> object | None:
    """Return the id of the newest successful run taken from the same tree.

    ``runs`` is the candidate list, newest first, each entry carrying ``id``,
    ``head_sha``, ``event`` and ``conclusion``. ``tree_of`` resolves a commit to
    its tree sha, or ``None`` when it cannot. The tree of any given commit is
    looked up at most once; a commit with no tree, or one whose lookup raises,
    simply does not match.
    """
    if not target_tree or not runs:
        return None

    seen: dict[str, str | None] = {}

    def tree_for(head_sha: str) -> str | None:
        if head_sha not in seen:
            try:
                seen[head_sha] = tree_of(head_sha)
            except Exception:
                seen[head_sha] = None
        return seen[head_sha]

    for run in runs:
        if not isinstance(run, Mapping):
            continue
        if run.get("conclusion") != "success":
            continue
        if run.get("event") not in REPLAYABLE_EVENTS:
            continue
        head_sha = run.get("head_sha")
        if not head_sha:
            continue
        if tree_for(str(head_sha)) != target_tree:
            continue
        return run.get("id")
    return None


def _gh_json(arguments: list[str]) -> object:
    # gh api defaults to POST as soon as a -f field is present, which the runs
    # listing would fail on. Every read here is an explicit GET.
    result = subprocess.run(
        ["gh", "api", "--method", "GET", *arguments],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def _field(mapping: object, key: str) -> object:
    if isinstance(mapping, Mapping):
        return mapping.get(key)
    return None


def _tree_of(repository: str, cache: dict[str, str | None]) -> Callable[[str], str | None]:
    def tree_for(head_sha: str) -> str | None:
        if head_sha not in cache:
            commit = _field(_gh_json([f"repos/{repository}/git/commits/{head_sha}"]), "tree")
            sha = _field(commit, "sha")
            cache[head_sha] = sha if isinstance(sha, str) else None
        return cache[head_sha]

    return tree_for


def _runs(listing: object) -> list[Mapping[str, object]]:
    entries = _field(listing, "workflow_runs")
    if not isinstance(entries, list):
        return []
    return [entry for entry in entries if isinstance(entry, Mapping)]


def _write_output(passed: bool) -> None:
    destination = os.environ.get("GITHUB_OUTPUT")
    if not destination:
        return
    try:
        with Path(destination).open("a", encoding="utf-8") as output:
            output.write(f"passed={'true' if passed else 'false'}\n")
    except OSError as err:
        print(f"could not write the passed output: {err}")


def _describe(err: Exception) -> str:
    if isinstance(err, subprocess.CalledProcessError):
        return (err.stderr or "").strip() or f"gh api exited {err.returncode}"
    text = str(err).strip()
    return text or type(err).__name__


def main() -> int:
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    sha = os.environ.get("GITHUB_SHA", "")
    try:
        if not repository or not sha:
            raise RuntimeError("GITHUB_REPOSITORY and GITHUB_SHA are both required")
        target = _field(_gh_json([f"repos/{repository}/git/commits/{sha}"]), "tree")
        target_tree = _field(target, "sha")
        if not isinstance(target_tree, str) or not target_tree:
            raise RuntimeError(f"no tree sha for commit {sha}")
        listing = _gh_json(
            [
                f"repos/{repository}/actions/workflows/full-regression.yml/runs",
                "-f",
                "status=success",
                "-f",
                f"per_page={CANDIDATE_RUNS}",
            ]
        )
        runs = _runs(listing)
        chosen = pick_run(runs, _tree_of(repository, {}), target_tree)
    except Exception as err:  # any failure means: run the regression as today
        print(f"could not check for a reusable full-regression run: {_describe(err)}")
        print("The full regression will run in this workflow")
        _write_output(False)
        return 0

    if chosen is None:
        print(
            f"No successful full-regression run found on tree {target_tree}; "
            "the regression will run in this workflow"
        )
        _write_output(False)
        return 0

    matched = next(run for run in runs if run.get("id") == chosen)
    print(
        f"Reusing successful full-regression run {chosen} "
        f"on {matched.get('head_sha')} (same tree {target_tree})"
    )
    _write_output(True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
