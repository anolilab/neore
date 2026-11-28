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

## Forget

- `forget` (`chat/tools/forget.ts`, `memory/forget.ts`) is remember's counterpart, under the same source rules: memory
  on, the owner's private typed chat, the turn's fresh prompt (`checkRequestedSource`, `not_your_words` reported as
  `not_your_request`), never headless (`BUILTIN_TOOLS_NOT_HEADLESS`). A privacy marker in the prompt refuses it before
  the search and before a delete (`private_message`), reading and writing nothing. Memory off answers `memory_off`; deleting in
  settings still works then.
- A lookup (`query`) is the model's wording. It is never saved as a memory, though it stays in the chat as the `forget`
  tool call's input, like any tool input. It runs `retrieveRelevantMemories` in its
  search mode, scoped to the user's rows and this chat's bot's, with `dispatchExpiresAt`: the embedding call holds the
  chat's dispatch claim (`takeRememberDispatch`, keyed by a random lookup id) and ends before it lapses: the time left is
  measured when the call starts, after the model's setup (`withClaimDeadline`). Once the search is done the source is
  checked again (`recheckForgetSource`, a mutation, so grants are read from the primary), so a chat shared or locked
  during the search returns no candidate text.
- A lookup never deletes: text the model read (a page, a tool result, a document) can steer what it asks for, so only the
  user's approval of a call naming `memories` deletes. Up to 5 candidates come back, ordered by relevance alone before
  the search's cut (`orderByRelevance`: the better of the vector cosine and the keyword share, `RankedMemory.relevance`),
  never by `score`, which adds recency.
- A call naming `memories` has its own `needsApproval: true`, which `applyToolPermissions` keeps under auto, full and a
  time-boxed allow (an `ask` mode asks for lookups too). The web card lists the texts and offers Approve and Deny only.
  The phone's alert offers Deny alone (`TOOL_DENY_ONLY_CATEGORY`): it cannot show the texts, so a tap opens the chat.
  The write checks each id: the user's, in the chat's scopes, not superseded, and still reading as the text shown
  (`textKey`), at most 5 distinct ids per call. An id is deleted only if every text it was confirmed with matches; one
  edited in place since the lookup, or named with a text it does not read, is offered again with what it reads now. A memory superseded since the user was asked is not deleted: the
  version in effect (its supersede chain, at most 20 hops) or, for one compression retired into a merge (a row
  retired by itself names no successor), what a search for the approved text finds now comes back as a candidate
  (`changed`, one per confirmed id, though several share a successor), and the user is asked again. A successor the same
  confirm deletes is not offered back. What was deleted is always kept: a merged row whose search finds nothing to offer
  counts as gone (`merged`), and the model tells the user it was merged into a memory that no longer matches, so they
  can ask again; a search that fails or cannot take the chat's claim counts the id as `unchecked`, to ask again in a
  moment. If the search is refused (the chat no longer the user's alone, memory off, the request no longer current),
  the result carries counts only (`deletedCount`), no text, and the note names that reason. Deletion is `deleteMemoryRows`, the settings delete: vector, older versions, digests.
- A lookup (in `beginForgetLookup`, whatever it finds) and a confirm (in its write, whatever is still there to delete) mark the prompt (`FORGET_SCOPE`,
  held a day). `rememberClaimState` reads the mark as `done`, so the reply's extraction cuts the prompt and reads only
  steers, at an approval pause and at the end alike: "forget that I live in Berlin" is not learned again from itself.
  An extraction already out when the mark lands is caught in its writes: `saveMemoryBatch`, `confirmMemories` and
  `reviseExtractedMemory` write nothing whose quote comes from a marked prompt (`fromForgetPrompt`, by
  `evidence.messageId`), except a fact a remember request saves as asked.
  The cost: a new fact in that same message ("I moved to Hamburg") is not learned from it either; `remember` saves it.
