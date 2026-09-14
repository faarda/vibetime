-- The server can now check whether a claimed ship day actually earned itself,
-- instead of taking the client's word for it. To do that it needs the same
-- state the CLI keeps: the stats snapshot at the last credited event.

ALTER TABLE sessions ADD COLUMN event_baseline_commits INTEGER;
ALTER TABLE sessions ADD COLUMN event_baseline_lines_added INTEGER;
ALTER TABLE sessions ADD COLUMN event_baseline_lines_removed INTEGER;
ALTER TABLE sessions ADD COLUMN event_baseline_files INTEGER;

-- Sessions that already hold credited events get their CURRENT stats as the
-- baseline: everything up to now is spent, so nothing already counted can be
-- counted a second time. Errs toward under-counting, which is the safe side.
UPDATE sessions SET
  event_baseline_commits = commits,
  event_baseline_lines_added = lines_added,
  event_baseline_lines_removed = lines_removed,
  event_baseline_files = files_touched
WHERE EXISTS (SELECT 1 FROM ship_events WHERE ship_events.session_id = sessions.id);

-- Everything else starts from zero, exactly like a fresh CLI baseline, so a
-- session that has never been credited can still earn its first event.
UPDATE sessions SET
  event_baseline_commits = 0,
  event_baseline_lines_added = 0,
  event_baseline_lines_removed = 0,
  event_baseline_files = 0
WHERE event_baseline_commits IS NULL;
