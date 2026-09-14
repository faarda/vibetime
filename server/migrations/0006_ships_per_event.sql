-- A second ship on the same day had nowhere to go: the key is (session_id, day).
-- Existing rows become 1, so numbers already announced do not move.
ALTER TABLE ship_events ADD COLUMN ships INTEGER NOT NULL DEFAULT 1;
