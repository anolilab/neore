# PROJECTS — AGENT NOTES

## INVARIANTS

- **Rule files** (`projectRuleFiles` table, `rule-files.ts`, `rule-file-rows.ts`) — the owner's instructions for a
  project's runs, at most `MAX_RULE_FILES`, each `always`, `glob` or `auto`. One `.global()` row per project holds the whole
  list, OFF the `projects` row: a metered `.global()` read is charged the whole row whatever it `select`s, so on the
  project row every list, pin, read and export would pay for up to 1 MB. Only the editor (`listProjectRuleFiles`), a
  run's setup (`getProjectContextForRun`, `tasks/internal.ts#runProjectFor`), a save and the export read it, always
  after the project's own check (`readProjectRuleFiles`), so organization moves and sharing follow the project. The
  row's `userId` copies the project's owner for erasure only (and is merged with accounts). A new reader of the table is a decision: the source check in
  `functions.rule-files.test.ts` lists who touches it. A fork does not copy them.
- Deleting a project marks its row (`deletingAt`), deletes the project row, then erases its row
  (`agent.projects.deleteProject`): a `.global()` write does not roll back, so erasing first could leave a live project
  without its rules. A row a failed delete left marked is finished by the daily `sweepUnfinishedRuleFileErasures` once
  its project is gone (unmarked while it lives). Account deletion erases them with each page of projects in
  `eraseProjectsForUser` (`RULE_FILE_ROWS_PER_PAGE` per step, drained by the workflow), then by owner
  (`eraseProjectRuleFilesForUser`, orphans included) once no project is left; never in an earlier step, which a
  deletion stopped before the projects would leave live projects without their rules.
- A save refuses while the project's delete is under way (`deleteUnderway`, as the repository mutations do), and
  erases its own row when the project is gone after its write.
- Changing them follows `updateProject` exactly: the owner only (`mayEditProject` in `edit-access.ts`, through
  `projectWithEditableSettings`), decided in the transaction that writes. Never widen one alone. `updateProject`
  re-checks the owner in its writing mutation (`settingsEditorId`).
- The legacy `context` text reads as the first `always` file (`projectRuleFiles`) everywhere: runs, the editor and
  the export. `defineMigration` does not reach `.global()` rows, so nothing rewrites it in bulk: the first
  `setProjectRuleFiles` saves it into the list, marked carried (`carriedContext`, its fingerprint), then empties
  `context` while it is still that text (one `patchIf` on it: removing the column replaces the whole row, which could
  carry back an older title; an empty `context` reads as none); a `context` matching the mark (a failed clear, or the same text written again) is read nowhere, never named
  `legacyContextId` (`isLegacyContextFile`), and cleared by the next save; an unchanged one longer
  than a rule file may be stays in `context` (`keepContext`); a file sent under its id that differs from it is saved and
  the `context` cleared, never dropped. A project with only a `context` gives a run exactly that text; keep that true
  when changing the rendering.
- A run's text comes from `projectRunContext` (`functions.ts`) only, framed `PROJECT CONTEXT:` by the caller: chat,
  edit and group runs through `getProjectContextForRun` (via `loadRunContext` or `streamAsync`), task runs from
  `tasks/internal.ts#runProjectFor` with no paths. A filter, budget or log change goes there, not in one caller. Both
  read the project and its rule-file row on the primary: replicas at different points around a first save would give
  a run neither. A group turn's pause keeps the message's file ids (`GroupRunSnapshot.fileIds`) for later speakers.
  `glob` files match the names of the run message's attachments (`chatFiles.filename`), read `RUN_FILE_NAMES_PER_READ` rows at a time:
  `chatFiles` is `.global()`, each row charged whole with its `extractedText`, so past `RUN_FILE_NAMES_READ_BYTES` the
  rest go unmatched rather than the run failing. The rendered text past
  `MAX_RULE_TEXT_PER_RUN`, separators and the cut marker counted, is cut (marked) and later files left out, except a
  legacy `context`, which is never cut, as before, and not counted, so files kept beside it still reach runs. Only
  counts are logged, never file text.
- An `auto` file has a one-line `description` (`MAX_RULE_DESCRIPTION_LENGTH`). `selectRuleFiles` returns them apart
  (`instructions`), each costing its line of `renderInstructionList` (the header with the first) against
  `MAX_RULE_TEXT_PER_RUN`, never its text; an empty one is not listed. Their text travels with the run's one read
  (`getProjectContextForRun`, `runProjectFor`), and the model reads one with `instruction_read`
  (`chat/tools/instruction-read.ts`), built per run over those files: no database read, never another project's. It is
  a built-in candidate of `buildAgentTools` (`instructions`), so the cap, a skill, the permissions and an allowlist
  remove it like any tool; a bot's `allow` list keeps it, only an `exclude` naming it or an empty `allow` removes it; only a run whose tools still hold it lists them: a chat run with
  tools, its approval continuation (read anew from the project its snapshot recorded, `config.projectId`, never the
  thread's project by then), and a task run (`projectInstructions` on `runHeadlessAgent`). Edit (`streamAsync`) and group
  runs take the text only. A run that lists none takes `textWithoutInstructions` when present, the text chosen
  without the list's cost (`selectRuleFiles(…, false)`); a line that does not fit is skipped, never ends the selection,
  so one that lists none is that text already. Triggers have no project. Names may repeat, and may be another file's id: a name or bare id
  that fits more than one file is answered with their ids, never a guess; `id:<id>` names one file or none, never a
  name, and a save refuses a name opening it (`isRuleTitleReserved`) unless the file has it saved already: one saved
  before the check keeps it, the rest of the list still saves, and it is read by its id only (listed as
  `id:<its id>`, `listedName`).
- Never a `defineMigration` on `projectRuleFiles`: a shard's data migration has no `.global()` store (`adminWriter` in
  `_generated/shard.ts`), so it fails there. Keep a new field optional, so every stored row still fits.
- Glob matching is `matchesGlob`, never a `RegExp` built from a pattern: one constant-cost step per (pattern, path)
  position, spent from a per-run budget (`GLOB_MATCH_STEPS_PER_RUN`); past it nothing more matches.
- Size: `normalizeRuleFiles` caps the list at `MAX_RULE_FILES_BYTES` of stored JSON, which keeps the rule-file row
  under D1's 2 MB; the project row is not grown by a save.
- The save limits live in `rule-file-limits.ts` (imports nothing; the editor imports it as
  `@neore/backend/rule-file-limits`). A refusal at one carries `data.code` (`RULE_FILE_REFUSALS`) and the `fileId`, and
  the editor words it as its own check; the argument validator bounds names and patterns loosely so these reach it.
- A save names the revision of the list it started from (`ruleFilesRevision`, over the list a legacy `context` first);
  `setProjectRuleFiles` reads the rule-file row on the primary and refuses a stale one (CONFLICT). The write is guarded
  on that row (`writeProjectRuleFiles`: `patchIf` on its `version`, an insert on the unique index), so of two saves
  that checked the same revision the second is refused too.
- A metered `.global()` read is charged the whole row whatever it `select`s (Lunora drops the `select`, charges, then
  projects), so a read that budgets its cost measures whole rows: `findProjectRowsMeasured` / `projectRowsReadBytes`.
  The export returns rule files only from their own pass (`attachProjectRuleFiles`; each legacy `context` comes from
  the owned-projects page), after that page; its query re-reads the project row (one per query, for the read margin)
  and reads rule files only of one still the exporter's (a merge or move in between), counting both; past the budget a
  project is marked `ruleFilesOmitted`, still with that `context`. The exported contexts share
  `PROJECT_CONTEXT_EXPORT_BYTES` of the output (`gdpr/steps.ts`; a carried one is neither exported nor counted); one
  past it is left out, its project marked `ruleFilesOmitted` too. The rule files' read budget counts the bytes
  the triggers actually read (`collectAllTriggers` reports `readBytes`), not the triggers' allowance.
- **Import from a repository** (`rule-file-repo.ts`, `source-control/repo-rule-files.ts`): two actions, list then read, with the person's own GitHub
  token, for whoever may save the rule files (`repoForRuleFileImport`) and a repository the project lists. A listing pins one commit and walks git
  trees by SHA (never `ref:path`, never recursive; a cut tree is reported as `truncated`, and a rules folder whose cut tree shows no Markdown is still
  the one listed); the read takes that commit's SHA, never a branch, lists it again (found under this repository, `/git/commits/{sha}`) and reads only
  what that listing offers, by the blob SHA it gave (a link's only when, followed again, it ends there: never as another listed file's SHA, so a
  refused link stays refused; each hop a host request), never through the contents API. Each action stays within `HOST_FETCHES_PER_IMPORT` host requests, every redirect
  hop (`beforeRedirect`, charged after its origin is checked) and a 401's repeat included (`fetchBudget`, under the Workers 50-subrequest cap with its
  own lookups): past it a link is `budget`, a file `not_read`, a listing whose walk is cut `host_error`, never a thrown error. A symlink is followed
  only to another path of the same listing (a root file or the listed folder's), inside the repository (`resolveLinkTarget`); any other is listed
  `refused` with why (`LinkRefusal`) and its target never read; a listing holds at most `MAX_LISTED_FOLDER_FILES` of the folder's files, by path, and
  counts the rest (`omitted`). They read only `isImportablePath` paths (root `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, Markdown right in one `RULE_FOLDERS`
  folder), within `REPO_RULE_FILE_MAX_BYTES` and `MAX_RULE_FILE_LENGTH` characters each (a folder's file without its front matter,
  `RULE_FILE_FRONT_MATTER`, as the import counts; a root file whole) and `REPO_RULE_FILES_READ_BYTES` downloaded, charged before each blob and kept
  with the blobs across a 401's repeat (`repoReadLedger`), and store nothing: the editor turns the text into drafts with the upload's rules
  (`importRuleTexts`; an instruction-file name is `always` only at the top), leaving out and counting what a save would refuse (count, length, list
  size) and cutting a name past `MAX_RULE_TITLE_LENGTH` (`fitTitle`), renaming one a save reserves (`unreservedTitle`), and reading one pick per
  `draftKey`: a link's target path (`linkOf`, else its own; never the blob SHA) plus root-or-rules-folder, so a link imports once, but equal bytes
  under two names, or a root and a folder file linked together, stay two drafts.
