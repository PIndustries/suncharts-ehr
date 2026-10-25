#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Prepare a reviewed single source system appointment; never send requests or infer identities.

Input is one original pc_* appointment row. All identity/status/category mappings
and the source IANA timezone must be supplied explicitly. Recurrences must first
be expanded with the source calendar into individual, verified occurrences.
"""
import argparse
import datetime as dt
import json
import pathlib
import uuid
from zoneinfo import ZoneInfo


def mapped_booking(row, *, patient_id, clinician_id, source_history_id, timezone,
                   source_booked_status, category, facility, room, reason, fold=None):
    for value in (patient_id, clinician_id, source_history_id):
        uuid.UUID(str(value))
    if str(row.get("pc_apptstatus", "")) != source_booked_status:
        raise ValueError("Source status is not the explicitly mapped booked status")
    if str(row.get("pc_recurrtype", "")) != "0" or str(row.get("pc_alldayevent", "0")) != "0":
        raise ValueError("Recurring/all-day events need source-side occurrence expansion and review")
    local = dt.datetime.fromisoformat(str(row["pc_eventDate"]) + "T" + str(row["pc_startTime"]))
    if local.tzinfo is not None:
        raise ValueError("Source date/time must be naive; supply its IANA timezone separately")
    zone = ZoneInfo(timezone)
    candidates = [local.replace(tzinfo=zone, fold=f) for f in (0, 1)]
    valid = [v for v in candidates if v.astimezone(dt.timezone.utc).astimezone(zone).replace(tzinfo=None) == local]
    if not valid:
        raise ValueError("Source local time does not exist because of a clock change")
    if valid[0].utcoffset() != valid[-1].utcoffset() and fold is None:
        raise ValueError("Source local time is ambiguous; explicitly select --fold 0 or 1")
    start = candidates[fold or 0].astimezone(dt.timezone.utc)
    seconds = int(row["pc_duration"])
    if seconds <= 0 or seconds > 86400:
        raise ValueError("Source duration must be 1 to 86400 seconds")
    if not category.strip() or not reason.strip() or (room and not facility):
        raise ValueError("Explicit category/reason and facility for a named room are required")
    return {"request_id": str(uuid.uuid4()), "source_history_id": str(source_history_id),
            "patient_id": str(patient_id), "clinician_id": str(clinician_id),
            "starts_at": start.isoformat(), "ends_at": (start + dt.timedelta(seconds=seconds)).isoformat(),
            "title": str(row.get("pc_title") or "Office visit"), "category": category,
            "facility": facility, "room": room, "notes": str(row.get("pc_hometext") or ""), "reason": reason}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--row", required=True, type=pathlib.Path)
    for name in ("patient-id", "clinician-id", "source-history-id", "timezone", "source-booked-status", "category", "reason"):
        p.add_argument("--" + name, required=True)
    p.add_argument("--facility", default="")
    p.add_argument("--room", default="")
    p.add_argument("--fold", type=int, choices=[0, 1])
    args = vars(p.parse_args())
    row = json.loads(args.pop("row").read_text())
    try:
        proposal = mapped_booking(row, **args)
    except (ValueError, KeyError) as error:
        p.exit(1, f"Mapping needs review: {error}\n")
    print(json.dumps(proposal))  # Clinical output: redirect privately, never commit real records.


if __name__ == "__main__":
    main()
