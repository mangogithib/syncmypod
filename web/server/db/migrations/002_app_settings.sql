-- Instance-level configuration, editable from the Settings page.
--
-- Separate from the existing `settings` table, which is keyed by user_id and
-- holds per-user preferences. Provider credentials belong to the deployment as
-- a whole, not to whoever happens to be signed in, so they get their own table
-- rather than being hung off an arbitrary user row.
--
-- On secrets living in the database: this is not a new exposure. The instance
-- already stores Spotify OAuth access and refresh tokens here, and the
-- alternative - an .env file on the same disk - is equally plaintext. What it
-- buys is that configuring the app no longer needs SSH access and a container
-- restart, which for a self-hosted tool is the difference between a setting
-- being adjustable and being effectively frozen.
--
-- Values are JSONB rather than TEXT so a setting can grow from a string into a
-- structure without a migration.

CREATE TABLE app_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who last changed it. Useful the moment there is more than one account, and
  -- free to record now.
  updated_by BIGINT      REFERENCES users(id) ON DELETE SET NULL
);
