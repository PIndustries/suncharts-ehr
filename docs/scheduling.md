# Native scheduling and appointments

The standalone web **Schedule** covers a day or seven-day agenda, provider/date
filters, patient selection, booking, editing/rescheduling, facility/room/category
and notes, provider time blocks and removal, check-in, cancellation, no-show,
patient-chart handoff, encounter start, and attributed appointment history.
Times display in the browser's IANA timezone; the API stores UTC instants. The UI
rejects ambiguous/nonexistent DST local times; the API accepts explicit offsets.
This is a synthetic-data development preview, not complete calendar coverage.

## Contract and concurrency

See `/openapi.json`. `GET /api/v1/schedule?start=...&end=...&clinician_id=...`
returns half-open interval overlaps (maximum 31 days, maximum 1000 appointments
and 1000 active blocks; narrow filters when exceeded). Active owner/clinician
accounts populate `/schedule/providers`; imported users are not authentication
accounts. Scheduling writes require owner, clinician or front-desk roles; read-only
staff can view; patient credentials cannot access the staff schedule. OAuth uses
existing `clinical.read` / `clinical.write` scopes plus local role checks.

Appointment edits and `/appointments/{id}/actions` require a quoted `If-Match`.
Check-in, encounter start and signed completion also increment the appointment
version and append immutable snapshots. The original `/check-in` endpoint remains
for compatibility and is state-checked. Legacy gateway-only instances without
browser auth retain their trusted-identity booking boundary; the native browser
and OAuth service require an active local provider account.

New booking/block clients supply a stable `request_id`. Exact retries return the
same current resource; reusing an ID with different input conflicts. Legacy
minimal appointment payloads remain accepted without automatic retry safety.
All scheduling mutations and audits share a transaction. A tenant scheduling
advisory lock serializes conflict checks across instances: provider, patient and
named facility/room intervals cannot overlap other appointments, and provider
blocks cannot overlap active appointments/blocks. Cancelled/no-show appointments
release capacity; completed visits preserve their occupied interval. Adjacent
intervals are allowed. Textual facility/room identifiers use exact comparison;
a canonical facility/resource directory remains future work.

Only booked appointments can be edited. Booked/checked-in can be cancelled;
no-show applies only to booked appointments whose start is past. Terminal entries
are never deleted or reopened. In-progress/completed states follow the encounter
workflow, preventing an administrator from fabricating a signed visit. Blocks are
retained after removal with an immutable operator/reason cancellation record.
Existing appointments get an explicitly labeled upgrade baseline, not an inferred
original author or original booking time.

## Legacy mapping

Original appointment rows are already exported by `export_legacy.py` and imported
as immutable `kind=appointment` history with stable source identifiers. Import
**does not activate bookings**. The chart's **Review appointment mapping** opens
staff reconciliation, showing original time/provider/status/recurrence. The
operator selects the matching active native provider, verifies the occurrence,
source status and timezone, and creates one booked appointment with
`source_history_id`. Unique source linkage prevents duplicate activation; the
original payload remains available. Past/completed source encounters should remain
history until a separate encounter migration/reconciliation workflow is validated.

| legacy source field | Native mapping / required review |
| --- | --- |
| `pc_eid` / source UUID | Source identifier retained, immutable history linkage |
| `pc_pid` | Export patient-source reference → reviewed native patient identity |
| `pc_aid` | Explicit source-provider → active native clinician selection; never assume matching numeric IDs |
| `pc_eventDate`, `pc_startTime` | Source IANA timezone → explicit UTC instant; never assume browser timezone is the source timezone |
| `pc_duration` | Seconds added to the UTC start; positive, maximum 24 hours |
| `pc_endTime`, `pc_endDate` | Retained for comparison; review discrepancies and recurrence boundary |
| `pc_title` | Appointment title, maximum 200 characters |
| `pc_catid`, `pc_prefcatid` | Preserve source IDs; explicitly select native category text |
| `pc_facility`, `pc_billing_location`, `pc_room` | Preserve IDs; verify facility name/room before native resource use; billing location remains archival |
| `pc_hometext` | Scheduling notes, maximum 2000 characters |
| `pc_apptstatus` | Preserve custom source code; operator verifies booked status; never guess a code or fabricate completion |
| `pc_recurrtype`, `pc_recurrspec`, `pc_recurrfreq`, `pc_alldayevent`, `pc_multiple` | Preserve original series/multi-provider data; source-side expansion and occurrence review required |
| Tracker/encounter links, confirmations and reminder metadata | Preserve in source payload; do not infer a signed encounter or sent message |

`scripts/map_legacy_appointment.py --help` prepares a POST body from one original
nonrecurring source row. Supply explicit patient/provider/history UUIDs, source
IANA timezone, the installation's booked status, category and review reason. It
rejects unmatched statuses, recurrence/all-day events, invalid duration and
nonexistent clock-change times; ambiguous times require `--fold 0|1`. It never
calls an API. Treat its clinical output privately and review before submission.
The web form requires manual date/time for raw naive source dates; it only prefills
normalized instants carrying an explicit timezone offset.

Source schema versions and customizations must be inventoried per installation.

## Remaining capabilities

Recurring series/exceptions and multi-provider group events, working-hours templates
and free-slot search, drag/drop and month/resource grids, configured facilities and
calendar category/status administration, waitlists, portal self-booking, automated
reminders/confirmations, resource capacity/overbooking policy, tracker/wait-time
reports, FHIR Appointment/Schedule/Slot remain
pending. No production cutover, deployment or certification is claimed.
