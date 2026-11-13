-- Owner decisions for imported patients who look like a chart the clinic already has:
-- attach the imported records to that chart, or create a new chart.
ALTER TABLE migration_jobs ADD COLUMN patient_decisions jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(patient_decisions) = 'object');
