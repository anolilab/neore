# PROJECTS — AGENT NOTES

## INVARIANTS

- **Rule files** (`projects.ruleFiles`, `rule-files.ts`) — the owner's instructions for a project's runs, at most
  `MAX_RULE_FILES`, each `always` or `glob`. They live ON the project row, so reading, deletion and organization moves
  follow the project with no table of their own. Project rows the other procedures return leave them out (`publicProject`).
- Changing them follows `updateProject` exactly: the owner only (`mayEditProject` in `edit-access.ts`, through
  `projectWithEditableSettings`), re-checked in the writing transaction (`settingsEditorId`). Never widen one alone.
- The legacy `context` text reads as the first `always` file (`projectRuleFiles`) everywhere: runs, the editor and
  the export. `defineMigration` does not reach `.global()` rows, so nothing rewrites it in bulk: the first
  `setProjectRuleFiles` saves it into the list and clears `context` in the same patch; an unchanged one longer than a
  rule file may be stays in `context` (`keepContext`). A project with only a
  `context` gives a run exactly that text; keep that true when changing the rendering.
- A run gets its files through `getProjectContextForRun` only (chat, edit and group runs via `loadRunContext` or
  `streamAsync`, tasks via `runProjectFor`), framed `PROJECT CONTEXT:` by the caller. `glob` files match the names of
  the run message's attachments (`chatFiles.filename`, read with `select` so the extracted text is not loaded). Text
  past `MAX_RULE_TEXT_PER_RUN` is cut (marked) and later files left out, except a legacy `context`, which is never cut,
  as before. Only counts are logged, never file text.
- Glob matching is `matchesGlob`, never a `RegExp` built from a pattern: one constant-cost step per (pattern, path)
  position, spent from a per-run budget (`GLOB_MATCH_STEPS_PER_RUN`); past it nothing more matches.
- Size: `normalizeRuleFiles` caps the list at `MAX_RULE_FILES_BYTES` of stored JSON. A rule-file save that grows the
  whole row (a kept `context`, a workflow) past `MAX_PROJECT_ROW_BYTES` is refused where it is written,
  `assertProjectRowFits` in `agent.projects.updateProject`; other patches are not checked there.
- A save names the revision of the list it started from (`ruleFilesRevision`); `agent.projects.updateProject`
  compares it in the transaction that writes and refuses a stale one (CONFLICT).
- The export reads rule files in their own pass (`attachProjectRuleFiles`), after the owned-projects page, which must
  keep not reading the heavy columns; past the budget a project is marked `ruleFilesOmitted`.
