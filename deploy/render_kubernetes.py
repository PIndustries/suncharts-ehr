#!/usr/bin/env python3
"""Render one tenant's dev Kubernetes runtime without accepting secrets."""

import argparse
import json
import re
import sys
import uuid
from pathlib import Path
from urllib.parse import urlsplit

IMAGE = re.compile(r"^ghcr\.io/pindustries/suncharts-ehr@sha256:[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]*$")
DNS = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def uuid_value(value: object, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError) as error:
        raise ValueError(f"{field} must be a UUID") from error


def https_origin(value: str, field: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{field} must be an HTTPS origin")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError(f"{field} must not contain a path, query or fragment")
    return value.rstrip("/")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("request", type=Path)
    parser.add_argument("--cluster-issuer", default="letsencrypt-staging")
    parser.add_argument("--ingress-class", default="nginx")
    parser.add_argument("--ingress-namespace", default="ingress-nginx")
    parser.add_argument("--connect-origin", default="https://connect.suncharts.app")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    request = json.loads(args.request.read_text())
    required = {"contract_version", "request_id", "order_id", "tenant_id", "clinician_id", "hostname", "owner_email", "expected_version", "image_reference"}
    if set(request) - (required | {"region"}) or not required.issubset(request):
        raise ValueError("request fields do not match provisioning contract v1")
    if request["contract_version"] != "1":
        raise ValueError("unsupported provisioning contract")
    image = str(request["image_reference"])
    if not IMAGE.fullmatch(image):
        raise ValueError("image_reference must be the published GHCR image by sha256 digest")
    expected_version = str(request["expected_version"]).strip()
    if not VERSION.fullmatch(expected_version):
        raise ValueError("expected_version must use YY.MM.DD.BUILD with a positive build number")
    tenant = uuid_value(request["tenant_id"], "tenant_id")
    uuid_value(request["request_id"], "request_id")
    uuid_value(request["order_id"], "order_id")
    clinician = uuid_value(request["clinician_id"], "clinician_id")
    hostname = str(request["hostname"]).lower()
    if not DNS.fullmatch(hostname):
        raise ValueError("hostname is invalid")
    owner = str(request["owner_email"]).strip().lower()
    if len(owner) > 320 or "@" not in owner or any(c in owner for c in "\r\n\0\""):
        raise ValueError("owner_email is invalid")
    for field in ("cluster_issuer", "ingress_class", "ingress_namespace"):
        if not NAME.fullmatch(getattr(args, field)):
            raise ValueError(f"--{field.replace('_', '-')} is invalid")

    namespace = f"sc-ehr-{tenant.replace('-', '')}"
    values = {
        "__NAMESPACE__": namespace,
        "__TENANT_ID__": tenant,
        "__CLINICIAN_ID__": clinician,
        "__IMAGE_REFERENCE__": image,
        "__PUBLIC_URL_JSON__": json.dumps(f"https://{hostname}"),
        "__IMAGE_REFERENCE_JSON__": json.dumps(image),
        "__EXPECTED_VERSION_JSON__": json.dumps(expected_version),
        "__OWNER_EMAIL_JSON__": json.dumps(owner),
        "__CONNECT_CLOUD_URL_JSON__": json.dumps(https_origin(args.connect_origin, "connect origin")),
        "__HOSTNAME_JSON__": json.dumps(hostname),
        "__CLUSTER_ISSUER__": args.cluster_issuer,
        "__INGRESS_CLASS__": args.ingress_class,
        "__INGRESS_NAMESPACE__": args.ingress_namespace,
    }
    template = Path(__file__).with_name("kubernetes").joinpath("runtime.template.yaml").read_text()
    for token, value in values.items():
        template = template.replace(token, value)
    if "__" in template:
        raise ValueError("unresolved Kubernetes template token")
    if args.output:
        args.output.write_text(template)
    else:
        sys.stdout.write(template)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"render failed: {error}", file=sys.stderr)
        raise SystemExit(2)
