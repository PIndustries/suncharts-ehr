# Scheduling and reminders

## Calendar and patient flow

Schedule includes day/seven-day agendas, a month calendar and a week calendar
with provider columns and 30-minute slots. Provider/date filters apply to each
view. Appointments link to their patient and encounter.

Book or reschedule with a provider, time, visit category and optional facility,
room and notes. Active directory locations appear as suggestions; existing text
locations remain supported. Booked appointments can be dragged to another time or
provider. Review the proposed move and supply a reason before saving. A keyboard
**Choose calendar slot to move** action provides the same review.

The server checks overlapping provider, patient and named-room bookings and provider
blocks. Adjacent intervals are allowed. Completed visits preserve their occupied
interval; cancellations and no-shows release capacity. Inactive provider profiles
cannot receive new bookings. Arrival, encounter start and signing use separate
state transitions; started appointments cannot be dragged.

Times are stored as UTC instants and displayed in the browser's IANA timezone.
The UI rejects ambiguous or nonexistent local times at clock changes. An API client
must supply explicit offsets.

## Recurring appointments

Daily, weekly and monthly series contain 2–52 explicitly reviewed occurrences,
with an interval of 1–12. Preview lists each occurrence and its conflicts; creation
rechecks the complete plan and books all occurrences atomically or none.

Each occurrence is an ordinary versioned appointment. Editing one creates an
exception without regenerating the series. Cancelling upcoming visits requires
the current series version and full occurrence-version list; past, started and
otherwise ineligible members remain unchanged.

Series preserve the selected local start time and timezone across clock changes.
Monthly series use the original day or the final day of a shorter month. Infinite
recurrence and bulk rescheduling of an entire series are not supported.

## Reminder setup

New future bookings receive 24-hour and 2-hour reminder definitions. Past reminder
windows are recorded as missed; historical appointments are not backfilled. Staff
can add custom reminders. Rescheduling supersedes unsent reminders and generates
new ones; cancellation, arrival and completion suppress unsent sends.

Record the patient's permission and verification of the exact saved destination.
Matching an email address is not consent. Changing contact details invalidates
verification. Phone reminders are staff tasks; automated SMS is not implemented.

In **Schedule → Reminders → Sender settings**, choose:

- **SunCharts Connect:** managed email for a connected, entitled practice. See
  [connected services](integrations.md).
- **Own Resend account:** enter a key and sender address. The key must list domains,
  send emails and retrieve sent emails. Test the saved sender against its exact
  verified domain, then explicitly enable delivery. Saving changes pauses sends.

Credentials are encrypted with the installation's master key. Follow the
[backup and recovery instructions](operations.md#credentials-and-backups).

## Delivery and recovery

Messages contain a generic subject and appointment time, without patient names,
MRNs, clinical notes or visit reasons. The recipient and appointment time still
require appropriate provider arrangements and consent.

Provider acceptance and confirmed delivery are separate states. Workers retrieve
provider evidence before marking a message delivered. Unknown outcomes retain
the same request identity; retries stop after five attempts or 23 hours. An
uncertain request without a provider ID requires review, not a blind resend.
Changing senders does not reroute an already-attempted message.

Patient confirmations, self-service preferences, message templates and provider
webhook ingestion are not implemented.

## API limits

Use [the OpenAPI contract](../api/openapi.json) for request bodies and actions.
Schedule reads cover at most 31 days and 1,000 appointments/blocks each. Narrow
filters when the limit is exceeded. Series lists return at most 100 entries with
`has_more`. Updates require quoted versions; exact idempotent creation retries use
stable request UUIDs. On a network failure, reload before retrying a mutation.

Working-hours templates, free-slot search, waitlists and portal booking remain
on the [roadmap](roadmap.md).
