-- SPDX-License-Identifier: AGPL-3.0-only
-- Most patients are follow-ups who need no intake form. Staff can mark an
-- appointment that way and undo the mark. The mark is its own row so an undo
-- keeps who cleared it and when; one active mark per appointment at a time.
CREATE TABLE previsit_intake_not_needed (
 tenant_id uuid NOT NULL, id uuid NOT NULL, appointment_id uuid NOT NULL,
 marked_by uuid NOT NULL,
 reason text NOT NULL DEFAULT '' CHECK (length(reason)<=200),
 created_at timestamptz NOT NULL DEFAULT now(),
 cleared_by uuid, cleared_at timestamptz,
 PRIMARY KEY (tenant_id,id),
 FOREIGN KEY (tenant_id,appointment_id) REFERENCES appointments(tenant_id,id)
);
CREATE UNIQUE INDEX previsit_not_needed_appointment ON previsit_intake_not_needed(tenant_id,appointment_id) WHERE cleared_at IS NULL;
