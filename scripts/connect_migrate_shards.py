#!/usr/bin/env python3
"""Deterministically split the large connect_migrate contract across CI workers."""

from __future__ import annotations

import argparse
import subprocess
from collections.abc import Iterable


SHARD_COUNT = 6


def partition(test_names: Iterable[str], shard_count: int = SHARD_COUNT) -> list[list[str]]:
    if shard_count < 1:
        raise ValueError("shard_count must be positive")
    shards = [[] for _ in range(shard_count)]
    for index, test_name in enumerate(sorted(set(test_names))):
        shards[index % shard_count].append(test_name)
    return shards


def discover() -> list[str]:
    result = subprocess.run(
        [
            "cargo",
            "test",
            "--locked",
            "--test",
            "connect_migrate",
            "--",
            "--list",
            "--format=terse",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    tests = []
    for line in result.stdout.splitlines():
        name, separator, kind = line.rpartition(": ")
        if separator and kind == "test":
            tests.append(name)
    if not tests:
        raise RuntimeError("cargo did not discover any connect_migrate tests")
    return tests


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--shard", type=int, required=True)
    parser.add_argument("--shard-count", type=int, default=SHARD_COUNT)
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    if not 0 <= args.shard < args.shard_count:
        parser.error("shard must be between zero and shard-count minus one")
    selected = partition(discover(), args.shard_count)[args.shard]
    if not selected:
        raise RuntimeError(f"connect_migrate shard {args.shard} is empty")
    print(f"connect_migrate shard {args.shard + 1}/{args.shard_count}: {len(selected)} tests")
    for test_name in selected:
        print(test_name)
    if args.list:
        return 0
    for test_name in selected:
        subprocess.run(
            [
                "cargo",
                "test",
                "--locked",
                "--test",
                "connect_migrate",
                test_name,
                "--",
                "--exact",
            ],
            check=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
