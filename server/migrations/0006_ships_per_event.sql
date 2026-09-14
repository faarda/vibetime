-- A session that ships four times in one day used to score one. The row could
-- not hold more: the primary key is (session_id, day), so a second ship the
-- same day had nowhere to go. That was never a decision, it fell out of
-- choosing the day as the grain in 0004.
--
-- Existing rows become 1, so every number announced so far stays exactly what
-- it was. New effort is what accrues past it.
ALTER TABLE ship_events ADD COLUMN ships INTEGER NOT NULL DEFAULT 1;
