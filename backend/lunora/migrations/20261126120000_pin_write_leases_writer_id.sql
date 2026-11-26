-- Lunora migration: pin_write_leases_writer_id
--
-- `pinWriteLeases` (a `.global()` table) gained a `writerId` column (`lib/account-moves.ts`). The provisioner creates a missing table but never
-- adds a column to one that exists, so a D1 store that already holds the table from an earlier build has no `writerId` column, and a pin write
-- against it fails. This adds the column.
--
-- Nothing applies it automatically (neither `lunora deploy` nor CI): run it once per stage, by hand, BEFORE the deploy that carries this change.
-- The pin insert writes `writerId`, so on a store whose table predates the column every pin write fails from the deploy until this runs.
-- Run it only on a store whose `pinWriteLeases` table predates it (`PRAGMA table_info(pinWriteLeases)` lacks `writerId`). SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so running it twice on the same store fails with "duplicate column name". A store created by this build already
-- has the column, and needs nothing:
--   pnpm --filter @neore/backend exec wrangler d1 execute <the stage's D1 database> --remote --file=lunora/migrations/20261126120000_pin_write_leases_writer_id.sql

-- ADD COLUMN writerId TEXT
ALTER TABLE "pinWriteLeases" ADD COLUMN "writerId" TEXT;
