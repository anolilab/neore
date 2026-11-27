# TASKS: SCHEDULE IDEAS (DAILY SUGGESTIONS) — REFERENCE

The rules are summarized in `backend/lunora/tasks/AGENTS.md`; this file holds the detail for `schedule-ideas.ts` and
`schedule-ideas-logic.ts`. Paths are relative to `backend/lunora/` (`tasks/` for the job's own files).

- Opt-in twice: `scheduleIdeasEnabled` and `memoryEnabled`, both absent = off. `dispatchScheduleIdeas` (a `shardSweeps()` entry, no cron) queues `generateScheduleIdeas` `once` while the user's UTC day is not taken, after taking the `schedule-ideas-queued` mark (later passes send nothing); `prepareScheduleIdeas` takes the day (`schedule-ideas` claim) in the same mutation that reads. A failed model call spends the day.
- **A skipped run spends nothing.** A switch off at delivery, or turned off before the model call (`confirmScheduleIdeas`, which also gives the day back), answers `{ skipped: true }`: `runJobOnce` releases its own claim and the queued mark is marked `skipped` (never deleted by the action, since `runJobOnce` still holds the job claim until the action returns); the sweep sends nothing while the job claim is held and replaces a `skipped` mark once it is gone, so turning the feature back on the same day runs it, once. Only a target that did nothing may answer so.
- **The job carries its day.** The sweep puts the UTC day in the job's args; the claims use it, never the delivery time, so a job delivered after midnight spends its own day. Right before the model call `confirmScheduleIdeas` re-reads the source chats with `readable`, and the messages of a chat locked or deleted meanwhile are dropped; with none left, no call.
- The model sees only the person's typed words: user rows' `typedText`, from chats tagged `chat` alone, not being deleted, and with no messenger, external, bot or host marker (`readable`). Never a run, sub-agent, eval, trigger or messenger thread: they are filtered BEFORE the chat cap, within a scan bound (`IDEA_THREADS_SCANNED`). A privacy marker anywhere in a turn (text, quote, attachment text) drops the whole turn; bounds are in `schedule-ideas-logic.ts`; a message with a secret is left out whole before it is cut.
- Proposals go through `insertTaskSuggestions` (validation, secrets, at most hourly schedules, the pending cap, both switches re-read). Logs carry counts only.
- Turning the switch OR memory off erases the waiting suggestions in that same settings save (`auth/functions.ts`); listing and accepting need both on. With memory off the switch can still be turned off, never on.
- The switch in the settings page ships with the suggestions list, not before: with no switch, nobody can turn the job on.
- **A branched chat is read along its active path only.** `prepareScheduleIdeas` reads a chat's last
  `IDEA_ROWS_READ_PER_THREAD` rows with `loadActivePathTail` (`agent/branch-rows.ts`) when the thread has an
  `activeLeafMessageId`, so a prompt the person edited away (a hidden sibling) is never sent; a chat with no stored leaf was
  never branched and is read newest-first as before. Never add a second walk.
- **Only a message that can be sent counts toward the cap.** `ideaMessageText` (privacy marker, secret, empty) runs when a
  candidate is collected, not only in `takeIdeaSources`, so chats full of secrets cannot stop the scan before a clean
  chat. The rows read stay bounded: at most `MAX_IDEA_SOURCE_THREADS` chats of `IDEA_ROWS_READ_PER_THREAD` rows.
- **The action never throws.** `prepareScheduleIdeas` runs inside the same `try` as the model call: a failure is logged
  (error kind and count only) and answered `null`. Only a switch that is off answers `{ skipped: true }`, which is what
  hands the job claim back. `isScheduleIdeasDay` rejects a shape-only date (`2026-13-01`) without throwing.
- **Accepted limits.** A privacy marker added to a sampled prompt in the seconds between `confirmScheduleIdeas` and the
  gateway call can still go out (closing it would make edits wait for in-flight sends); the text is the person's own earlier
  text, once a day. A failed `releaseKey` for a skipped job leaves the job claim held until it expires: that day's ideas are
  missed and the next day runs as usual; a retry would add a failure path to a once-a-day suggestion.
