-- Lunora migration: drop_emails
-- Generated at 2026-11-05T14:37:38.161Z
-- This file was produced by `lunora migrate generate`. Review carefully before applying.
--
-- `emails` (a `.global()` table) left the schema in #542; nothing reads or writes it. The runtime never drops a
-- table, so its D1 table stays until this runs. Nothing applies it automatically (neither `lunora deploy` nor
-- CI): run it once per stage, by hand, after the deploy that carries #542:
--   pnpm --filter @neore/backend exec wrangler d1 execute <the stage's D1 database> --remote --file=lunora/migrations/<this file>

-- DROP TABLE emails
DROP TABLE IF EXISTS "emails";
