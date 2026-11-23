-- "Suggest codes" now covers the services done at the encounter as well as its diagnoses, in the
-- same request and the same two assistant jobs. The first job lists the services the note says
-- were done; the EHR looks each one up in what the practice can bill; the second job chooses
-- among those codes. This column holds the services with their candidate codes while the request
-- waits for its second job, beside `problems` for the diagnoses. Existing requests have none.
ALTER TABLE diagnosis_suggestion_requests
 ADD COLUMN services jsonb CHECK (services IS NULL OR jsonb_typeof(services)='array');
