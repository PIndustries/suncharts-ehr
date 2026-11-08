-- Preserve complete official HCPCS continuation descriptions.
ALTER TABLE terminology_codes DROP CONSTRAINT terminology_codes_display_check;
ALTER TABLE terminology_codes ADD CONSTRAINT terminology_codes_display_check CHECK (length(display) BETWEEN 1 AND 10000);
