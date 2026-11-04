#!/usr/bin/env python3
"""Build a bounded Discord webhook payload for public repository milestones."""

from __future__ import annotations

import argparse
import json
import re
from urllib.parse import urlparse


REPOSITORY = "PIndustries/suncharts-ehr"
PRODUCT = "SunCharts EHR"
KINDS = {"release", "image", "pull_request"}
STATUSES = {"succeeded", "failed", "merged"}
COLORS = {"succeeded": 0x42D86B, "merged": 0x42D86B, "failed": 0xE05252}


def clean(value: str, limit: int) -> str:
    value = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value[:limit]


def public_repository_url(value: str) -> str:
    parsed = urlparse(value)
    prefix = f"/{REPOSITORY}"
    if (
        parsed.scheme != "https"
        or parsed.netloc != "github.com"
        or not (parsed.path == prefix or parsed.path.startswith(prefix + "/"))
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("link must be a public suncharts-ehr GitHub URL")
    return value


def payload(kind: str, status: str, version: str, url: str) -> dict:
    if kind not in KINDS:
        raise ValueError("unsupported milestone kind")
    if status not in STATUSES:
        raise ValueError("unsupported milestone status")
    version = clean(version, 80)
    if not version:
        raise ValueError("version or public reference is required")
    url = public_repository_url(url)
    labels = {
        "release": "Public release",
        "image": "Public image publication",
        "pull_request": "Community update",
    }
    return {
        "username": "SunCharts Community",
        "allowed_mentions": {"parse": []},
        "embeds": [
            {
                "title": f"{PRODUCT} · {labels[kind]}",
                "description": f"**{version}** · {status}",
                "url": url,
                "color": COLORS[status],
                "footer": {"text": REPOSITORY},
            }
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True, choices=sorted(KINDS))
    parser.add_argument("--status", required=True, choices=sorted(STATUSES))
    parser.add_argument("--version", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(payload(args.kind, args.status, args.version, args.url), handle)
        handle.write("\n")


if __name__ == "__main__":
    main()
