# PROJECTS — AGENT NOTES

## INVARIANTS

- **Rule files** (`projectRuleFiles` table, `rule-files.ts`, `rule-file-rows.ts`) — the owner's instructions for a
  project's runs, at most `MAX_RULE_FILES`, each `always` or `glob`. One `.global()` row per project holds the whole
  list, OFF the `projects` row: a metered `.global()` read is charged the whole row whatever it `select`s, so on the
  project row every list, pin, read and export would pay for up to 1 MB. Only the editor (`listProjectRuleFiles`), a
  run's setup (`getProjectContextForRun`, `tasks/internal.ts#runProjectFor`), a save and the export read it, always
  after the project's own check (`readProjectRuleFiles`); the table has no owner column, so organization moves,
  sharing and account merges follow the project. A new reader of the table is a decision: the source check in
  `functions.rule-files.test.ts` lists who touches it. A fork does not copy them.
- Deleting a project deletes its row (`agent.projects.deleteProject` → `eraseProjectRuleFiles`); account deletion
  erases it per project in `deleteUserWorkflowData`, before the project rows go.
- Changing them follows `updateProject` exactly: the owner only (`mayEditProject` in `edit-access.ts`, through
  `projectWithEditableSettings`), decided in the transaction that writes. Never widen one alone. `updateProject`
  re-checks the owner in its writing mutation (`settingsEditorId`).
- The legacy `context` text reads as the first `always` file (`projectRuleFiles`) everywhere: runs, the editor and
  the export. `defineMigration` does not reach `.global()` rows, so nothing rewrites it in bulk: the first
  `setProjectRuleFiles` saves it into the list and clears `context` in the same transaction; an unchanged one longer
  than a rule file may be stays in `context` (`keepContext`). A project with only a `context` gives a run exactly that
  text; keep that true when changing the rendering.
- A run's text comes from `projectRunContext` (`functions.ts`) only, framed `PROJECT CONTEXT:` by the caller: chat,
  edit and group runs through `getProjectContextForRun` (via `loadRunContext` or `streamAsync`), task runs from
  `tasks/internal.ts#runProjectFor` with no paths. A filter, budget or log change goes there, not in one caller.
  `glob` files match the names of the run message's attachments (`chatFiles.filename`), read one row at a time:
  `chatFiles` is `.global()`, each row charged whole with its `extractedText`, so past `RUN_FILE_NAMES_READ_BYTES` the
  rest go unmatched rather than the run failing. The rendered text past
  `MAX_RULE_TEXT_PER_RUN`, separators and the cut marker counted, is cut (marked) and later files left out, except a
  legacy `context`, which is never cut, as before, and not counted, so files kept beside it still reach runs. Only
  counts are logged, never file text.
- Glob matching is `matchesGlob`, never a `RegExp` built from a pattern: one constant-cost step per (pattern, path)
  position, spent from a per-run budget (`GLOB_MATCH_STEPS_PER_RUN`); past it nothing more matches.
- Size: `normalizeRuleFiles` caps the list at `MAX_RULE_FILES_BYTES` of stored JSON, which keeps the rule-file row
  under D1's 2 MB; the project row is not grown by a save.
- A save names the revision of the list it started from (`ruleFilesRevision`, over the list a legacy `context` first);
  `setProjectRuleFiles` reads the rule-file row on the primary and compares it in the transaction that writes, refusing
  a stale one (CONFLICT).
- A metered `.global()` read is charged the whole row whatever it `select`s (Lunora drops the `select`, charges, then
  projects), so a read that budgets its cost measures whole rows: `findProjectRowsMeasured` / `projectRowsReadBytes`.
  The export returns rule files only from their own pass (`attachProjectRuleFiles`, which counts both the project and
  the rule-file rows it reads), after the owned-projects page; past the budget a project is marked `ruleFilesOmitted`.
