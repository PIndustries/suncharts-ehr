# Scheduling and reminders

## Calendar and patient flow

Schedule opens in Month the first time. Choose Day, Week, Month or List in the
toolbar to switch immediately. The EHR remembers your view, providers, locations,
status filter and row density for this practice in this browser.

The toolbar stays visible as you scroll. On a larger screen the mini calendar
and filters stay beside the appointments. On a phone, use **Filters** in the
toolbar to open them. Use **Today** or the arrows to move through the calendar.

Day shows the practice’s opening hours and extends to include earlier or later
visits. Week shows a time grid, Month shows up to three visits per day, and List
shows seven days as rows. Clicking an empty time starts a booking.

Every view uses one appointment card: time, patient, visit type, provider, status
and markers for what the visit still needs — intake form, insurance eligibility for
the coverage that pays first, copay, patient balance, visit note, charges and a
first-visit flag. Markers come from `GET /api/v1/schedule/markers`, one read per
visible range. Insurance, copay, balance and charge markers are omitted for staff
whose access policy hides patient billing (insurance also needs claims access);
the note marker needs clinical access. Counts in the summary line filter the view.

Selecting a card opens the appointment panel: check in, start or continue the visit,
send or review the intake form, check eligibility, collect the copay, reschedule,
cancel or open the chart. Each action uses the same route as the chart. **Check
insurance for today** runs the one-click eligibility check for each visit that has
none, one at a time, under the server's freshness rules and request limit.

Book or reschedule with a provider, time, visit category and optional facility,
room and notes. Active directory locations appear as suggestions; existing text
locations remain supported. In the Week view a booked appointment can be dragged to
another time; **Pick a new time on the calendar** does the same with a click, and in
the Day view the provider column is part of the choice. Review the proposed move and
supply a reason before saving. **Reschedule or edit** does all of this from the
keyboard.

The server checks overlapping provider, patient and named-room bookings and provider
blocks. Adjacent intervals are allowed. Completed visits preserve their occupied
interval; cancellations and no-shows release capacity. Inactive provider profiles
cannot receive new bookings. Arrival, encounter start and signing use separate
state transitions; started appointments cannot be dragged.

Times are stored as UTC instants and displayed in the browser's IANA timezone.
The UI rejects ambiguous or nonexistent local times at clock changes. An API client
must supply explicit offsets.

## Practice visit types

Practice owners manage visit types in **Practice administration → Visit types**.
Each type has a name, category and default length from 5 to 480 minutes. Owners
can include suggested ICD-10-CM diagnoses and CPT or HCPCS procedures. Procedure
suggestions may include units, modifiers and drug details. An owner can retire a
type or restore it for future bookings.

Selecting a type on a booking, walk-in or recurring series saves the version in
use at that moment. Rescheduling preserves that selection. Updating the practice
default applies to future selections. Staff review the suggested codes in the
encounter, edit or remove individual lines, and save the ones that apply. The
existing service-date fee rules price saved procedure lines.

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
