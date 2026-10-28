#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Bound idle Cargo caches; keep executables and everything outside target/."""
import argparse
import contextlib
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import time
import tomllib

CACHES = ("deps", "incremental", "build", ".fingerprint", "examples")
PACKAGES = {"suncharts-engine", "suncharts-server"}
GIB = 1024 ** 3


def worktree_projects(projects):
    """Discover only registered worktrees of explicitly supplied repositories."""
    result = {Path(p).resolve() for p in projects}
    for project in sorted(result):
        root = subprocess.run(["git", "-C", str(project), "rev-parse", "--show-toplevel"],
                              check=True, capture_output=True, text=True, timeout=10).stdout.strip()
        suffix = project.relative_to(Path(root).resolve())
        listing = subprocess.run(["git", "-C", root, "worktree", "list", "--porcelain", "-z"],
                                 check=True, capture_output=True, text=True, timeout=10).stdout
        for field in listing.split("\0"):
            if field.startswith("worktree "):
                candidate = Path(field[9:]) / suffix
                if (candidate / "Cargo.toml").is_file():
                    result.add(candidate)
    return sorted(result)


def cache_stats(profile):
    size, newest = 0, 0.0
    for name in CACHES:
        path = profile / name
        if not path.is_dir() or path.is_symlink():
            continue
        for current, dirs, files in os.walk(path, followlinks=False):
            dirs[:] = [d for d in dirs if not (Path(current) / d).is_symlink()]
            for entry in [Path(current), *(Path(current) / f for f in files)]:
                info = entry.lstat()
                if stat.S_ISREG(info.st_mode):
                    size += info.st_size
                if not stat.S_ISLNK(info.st_mode):
                    newest = max(newest, info.st_mtime)
    return size, newest


def profiles(project):
    project = Path(os.path.abspath(os.path.expanduser(str(project))))
    if project.resolve() != project or not project.is_dir():
        raise ValueError("project must be a real canonical directory")
    manifest = project / "Cargo.toml"
    if manifest.is_symlink():
        raise ValueError("manifest must not be a symlink")
    with manifest.open("rb") as stream:
        if tomllib.load(stream).get("package", {}).get("name") not in PACKAGES:
            raise ValueError("only SunCharts engine/server projects are allowed")
    target = project / "target"
    if target.is_symlink():
        raise ValueError("target must not be a symlink")
    if not target.exists():
        return []
    candidates = [target / p for p in ("debug", "release")]
    # Cargo cross-compilation uses target/<triple>/<profile>.
    for child in target.iterdir():
        if child.is_dir() and not child.is_symlink() and child.name not in ("debug", "release"):
            candidates.extend(child / p for p in ("debug", "release"))
    return [p for p in candidates if p.is_dir() and not p.is_symlink()]


@contextlib.contextmanager
def cargo_lock(profile):
    # Cargo uses flock on this inode. Keep it in place while deleting caches so
    # a build starting after our scan waits instead of racing deletion.
    fd = os.open(profile / ".cargo-lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("invalid Cargo lock")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def clean(projects, *, apply=False, max_bytes=8 * GIB, days=7, min_free=15 * GIB):
    if not all(math.isfinite(x) for x in (max_bytes, days, min_free)) or max_bytes <= 0 or days <= 0 or min_free < 0:
        raise ValueError("invalid cache policy")
    report = {"checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "apply": apply, "removed_bytes": 0, "planned_bytes": 0,
              "cache_before_bytes": 0, "cache_after_bytes": 0, "items": []}
    # Validate every configured root before deleting anything.
    candidates = sorted({p for project in projects for p in profiles(project)})
    with contextlib.ExitStack() as locks:
        idle = []
        for profile in candidates:
            try:
                locks.enter_context(cargo_lock(profile))
            except BlockingIOError:
                report["items"].append({"profile": str(profile), "status": "active_build_skipped"})
                continue
            size, newest = cache_stats(profile)
            idle.append((newest, profile, size))
        total = sum(size for _, _, size in idle)
        report["cache_before_bytes"] = total
        cutoff = time.time() - days * 86400
        for newest, profile, size in sorted(idle):
            free = shutil.disk_usage(profile).free
            reason = ("expired" if size and newest < cutoff else
                      "budget" if total > max_bytes else
                      "low_disk" if free < min_free else None)
            if not size or reason is None:
                continue
            report["planned_bytes"] += size
            if apply:
                for name in CACHES:
                    path = profile / name
                    if path.is_dir() and not path.is_symlink():
                        shutil.rmtree(path)
                report["removed_bytes"] += size
            total -= size
            report["items"].append({"profile": str(profile), "status": "cleaned" if apply else "would_clean", "reason": reason, "bytes": size})
        report["cache_after_bytes"] = total if apply else report["cache_before_bytes"]
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", action="append", required=True)
    parser.add_argument("--apply", action="store_true", help="default is dry-run")
    parser.add_argument("--max-gib", type=float, default=8)
    parser.add_argument("--days", type=float, default=7)
    parser.add_argument("--min-free-gib", type=float, default=15)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--discover-worktrees", action="store_true")
    args = parser.parse_args()
    status = 0
    try:
        projects = worktree_projects(args.project) if args.discover_worktrees else args.project
        report = {"status": "ok", **clean(projects, apply=args.apply, max_bytes=args.max_gib * GIB,
                                        days=args.days, min_free=args.min_free_gib * GIB)}
    except Exception as error:
        status = 1
        report = {"status": "error", "error_type": type(error).__name__,
                  "detail": str(error)[:1000],
                  "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    output = json.dumps(report, indent=2) + "\n"
    if args.report:
        # Replace one bounded report rather than growing a maintenance log.
        temp = args.report.with_suffix(".tmp")
        temp.write_text(output)
        temp.chmod(0o600)
        temp.replace(args.report)
    print(output, end="")
    return status


if __name__ == "__main__":
    sys.exit(main())
