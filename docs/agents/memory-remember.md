# REMEMBER — AGENT NOTES — REFERENCE

The rule is summarized in `backend/lunora/memory/AGENTS.md`, which agents load automatically; this file holds the detail.
Paths are relative to `backend/lunora/`.

## The request

- The `remember` tool (`chat/tools/remember.ts`) takes no input: the model only triggers it. `memory/remember.ts` reads
  the turn's own prompt (`runTurn.promptMessageId`) and runs `extractMemories` in its `requested` mode over the typed
  prompt alone. That run is the turn's one extraction: it finds every fact as usual and marks those the message
  explicitly asks to remember (`asked`, saved as `requested`; the rest `auto`), through extraction's gate and write.
- Only the message that started the reply is read, never a steer. The hint and the tool tell the model to ask the user
  to send a mid-reply request as a new message.
- A typed prompt past the read window (`EXTRACTION_USER_MESSAGE_CHARS`) reaches the model as its first and last halves
  (`promptStartAndEnd`), so a request typed after a long preamble is seen. Its quotes are checked against the whole
  typed prompt (`readPrompt`).
- An asked fact needs 4 non-space characters ("User skis"); others 10.

## One request per prompt

- A claim (`REMEMBER_SCOPE`) keyed by the prompt. Every extraction job with a typed prompt reads it (one keyed read,
  `rememberClaimState`): `done` cuts the prompt and reads only steers, so no pause or resume extracts it again;
  `pending` reschedules the job (3 × 30 s) before it reads the prompt itself.
- A running claim lapses in 5 minutes, so a lost release heals itself (and is retried once). It is marked done and
  held a day when something was written or nothing asked, and released otherwise.
- The done mark (`putClaimResult`) is compare and set: it writes even if the running claim lapsed, never over a newer
  request that took the prompt since. A failed mark is logged, never a failed save.

## Where a fact may be written from

- `checkRequestedSource`: memory on, the owner's chat alone (not shared, public, a group, temporary, locked, being
  deleted, messenger, nor a sub-agent's, worker's, task's or trigger's), and the owner's own typed prompt. A privacy
  marker anywhere in the message refuses it first (`remember.ts`).
- Fresh unless a row under the prompt carries another non-empty `replyId` (another run's reply: a regenerate, or an
  agent-written prompt that was answered). A row with none is the reply's own (its pending row, approval
  continuations and their steps). At most 2 pages of 50 are read, and the prompt is fresh past them: this check
  attributes the prompt, the chat checks guard privacy.
- Read before the extractor, again in `beginRememberDispatch`, and inside every write of the request
  (`saveMemoryBatch`, `reviseExtractedMemory`, `confirmMemories`). A refusal writes nothing and stops the rest.

## The chat's lock

- `beginRememberDispatch` checks the source and takes a dispatch claim on the chat (`memory-remember-dispatch`, keyed
  `<threadId>:<promptMessageId>:<request>`, `memory/remember-dispatch.ts`) in one transaction. `request` is the remember
  request's prompt claim (`claimedAt`), so a request's release never removes another's claim. `enableThreadLock`
  refuses while one is held (by the thread prefix), as for titles and follow-ups.
- The claim is held across every model call of the run: extraction, embedding and belief revision. It is released
  after the last of them, before the writes, and again in `rememberFactFor`'s `finally`, whatever ended the run.
- Each call's deadline is what is left of the claim less `REMEMBER_CALL_MARGIN_MS` (`dispatchCallDeadline`), timed
  from the claim, never from the call. With none left the call is not made: no extraction is `unavailable`, no
  embedding leaves the fact to keyword dedup, and no revision saves the fact as new. The claim lapses in 3 minutes
  (`REMEMBER_DISPATCH_TTL_MS`).
- The deadline's signal (`withDeadline`) is `AbortSignal.timeout` backed by a `setTimeout` that aborts a controller and
  is cleared when the call ends, as the title dispatch does, so it fires even where the runtime does not run the timeout
  signal's own timer.

## Saving and reporting

- `saveMemoryBatch` confirms a row holding the same text and dates, retiring what the fact was to supersede. The
  batch's own inserts join, and its retired rows leave, what later facts match.
- A fact returned twice (same `textKey` and dates, the save's own comparison) is asked if either copy is, even when the
  asked copy's own quote failed and only its unasked twin's holds; that asked copy is then not reported refused.
- The tool takes an hour or today allow like any built-in; a headless run never has it (`BUILTIN_TOOLS_NOT_HEADLESS`,
  `chat/lib/person-tools.ts`).
- Extraction drops a fact the extractor marks `sensitive` (health, diagnosis, treatment, medication), in any mode and
  language. A quote main's quote check refuses for a health word is reported as `health`.
- When something was written, each asked fact refused (secret, health, unbacked) is still reported by its reason only
  (`refused`), so the reply names both. When nothing survives, the result is `refused` only if an asked fact was.
