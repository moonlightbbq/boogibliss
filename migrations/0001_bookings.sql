-- Durable record of every booking attempt.
--
-- The mailbox used to be the only record a booking ever happened, so anything
-- rejected before the mail send (bot trap, validation, a failed send) vanished
-- with no trace beyond a Workers Log line that ages out in days. That is why
-- nobody could answer "how many submissions has the form received".
--
-- Rejections are recorded too, deliberately: a submission the form threw away
-- is exactly the thing worth counting.
CREATE TABLE IF NOT EXISTS bookings (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  reason       TEXT,
  name         TEXT,
  email        TEXT,
  phone        TEXT,
  event_type   TEXT,
  event_date   TEXT,
  guest_count  TEXT,
  location     TEXT,
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_bookings_created_at ON bookings (created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_outcome ON bookings (outcome);
