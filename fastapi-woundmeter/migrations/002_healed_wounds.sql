-- A wound is marked HEALED only by explicit clinician confirmation; a later non-zero approved
-- measurement (or a clinician's reopen action) returns it to ACTIVE. History is never removed.
ALTER TABLE wounds ADD COLUMN healed_at_utc TEXT;
ALTER TABLE wounds ADD COLUMN healed_by_subject TEXT REFERENCES users(subject);
ALTER TABLE wounds ADD COLUMN reopened_at_utc TEXT;
