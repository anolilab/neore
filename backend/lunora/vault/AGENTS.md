# VAULT — AGENT NOTES

## SAVED SITE LOGINS (`site-logins.ts`)

- The password is encrypted with the `site-logins` key purpose and never leaves the server: no client-reachable
  procedure, export, log line or model-facing list returns it or its ciphertext. The UI learns only `hasPassword: true`.
  The one exception is the internal `siteLoginForFill`, which returns the ciphertext for the server-side fill action (the next part);
  keep it internal and keep the ciphertext inside the action that decrypts it.
- A login belongs to one exact origin (`lib/site-origin.ts#normalizeSiteOrigin`: HTTPS only, punycode host, default
  port dropped, a trailing-dot host refused since the browser keeps the dot). Compare origins as plain strings; never match a subdomain, port or suffix. The origin of a saved login
  never changes on edit.
- Which run may use a login is decided from its THREAD, TURN and the text in front of the model, never from client
  input, by ONE function: `site-login-turn.ts#siteLoginTurnVerdict`, an ALLOWLIST. Both queries use it, and the fill
  tool of the next part must call it too (through `usableSiteLogins`), never a check of its own. Safe, and only this:
  the owner's own typed text (their row, text parts with no mark, attachment, guest or outside-agent text, goal note,
  compressed history or quote-like line, `carriesQuotedLines`: a quoted reply and a rich paste are unmarked `>` lines; a forward is also marked), the lead model's own replies (text, reasoning, tool calls; no speaker, `acp-host`, sources,
  memories, file, `neore…` metadata but `neoreGateway`), rows whose `agentName` is a model id or unset
  (`isLeadAgentName`: lead rows and the prompt carry the model id; every other writer names itself, and a test pins
  that none of those names is a model id), results of `SAFE_RESULT_TOOLS`, built-in tools only (`toolSources`), and a
  system prompt of only `SAFE_SYSTEM_CONTEXT` kinds. The step's own messages are classified by the same allowlist as
  the saved path (`messageRefusal`); a message-level `neore` mark refuses, so text retrieved into the messages from
  elsewhere is marked where it is added (a search hit: `agent/client/search.ts#markSearchHit`). The turn is the
  owner's own at the app (`isOwnInteractiveTurn`); the thread passes
  `loadEligibleThread`, is tagged `chat` and nothing else, and is no coding agent's, handoff, import, branch or other
  derived thread (`threadRelationships`) and has no context summary. Anything else refuses, including a row, part,
  tool, tag or context kind nobody classified: add one to the safe lists only on purpose, and when unsure leave it out.
  `agent/thread-summary-taint.ts#threadPathTaint` is not used here; do not widen it for this. Then the owner's own chats
  get every login; a teammate's thread only the logins naming that teammate, and none once it is deleted.
- Logins live on the owner's own shard: save/delete refuse, and list and the fill lookup (`usableSiteLogins`) return
  nothing, on `__root__` or when `servesUser` is false (`servesUser` alone admits `__root__`, which any caller can name; a collaborator reaches every procedure on a
  shared thread's shard). Dev `SHARD_ROUTING=off` puts everyone on root, so root is allowed there. A save keeps only
  the caller's own existing teammate ids (a deleted one is dropped) and checks the 20-bot limit on what it keeps, so the
  web form always sends a login's ids unfiltered: its cached bot list cannot tell a deleted bot from a new one.
- An edit carries the `updatedAt` it was opened from (`expectedUpdatedAt`, required with `loginId`); a moved row refuses
  with `CONFLICT` + `SITE_LOGIN_CHANGED` (`lib/site-login-shape.ts`), and every edit moves `updatedAt` forward. On it the
  form reloads the login and keeps typed username/label, the saved bots minus ones unticked here (never one ticked here),
  and no password: a stale edit must never write a removed bot back.
- An admin acting as the owner saves, changes and deletes no login (`refuseImpersonation`, `FORBIDDEN` "… while
  impersonating"): the agent types a login in the owner's own turns, so a planted one would outlive the impersonation.
  The list stays readable (no secret in it, as the API key list); the web form hides save, edit and delete until the
  session reads as the user's own (`useImpersonationState`).
- The export carries each login's `teammateIds`, never the password or ciphertext.
- No audit triggers on `savedSiteLogins`: a history snapshot would outlive the row with the ciphertext in it.
- The fill itself (browser tool, approval per site per thread, activity entry) is the next part; these are its rules. It passes
  `siteLoginForFill` the origin of the page the browser is on, never a site the model names; checks that origin again
  inside the browser-renderer right before typing, after any navigation; and decrypts and types in one action, never
  returning the ciphertext from a workflow step or putting it in a queue payload. It fills the turn from its tool context
  (`dispatchOrigin`, `headless`, `startedBy`, `promptMessageId`; `ToolCtx.messageId` is never set), `stepMessages` as
  `ToolExecutionOptions.messages` holds them (never filtered), `toolSources` with one entry per offered tool, and
  `systemContext` with one kind per piece pushed onto the system prompt where it is assembled (`instructions` always; a
  piece it cannot name, a request's own instructions, or a built-in whose description lists stored text such as skills
  or workers gets a kind of its own, which refuses). A failed
  read of the turn is a refusal. No turn records
  impersonation yet: record it on the turn at `/chat/start` and carry it through a pause's snapshot, never default it to
  `false`. A resumed or approved run's `promptMessageId` is not the prompt, so it gets no login until that is carried too.
  Text the owner did not type is marked where it is saved (`lib/not-typed-text.ts`, `neore.notTyped`) and refused by
  name: a prompt, edit, steer or local turn an admin sent while impersonating, and a composer draft from a `?prompt=` or
  `?initialMessage=` link, anything the desktop shell hands over (a `neore://new?text=` link, a share, the Quick
  Composer), a saved prompt whose words (content, variable defaults) not all the viewer wrote, unimpersonated (`isOwnPromptContent`;
  `prompts/content-author.ts` records them from the session, never `userId`, and only grows: another writer or an
  impersonated write of any part stays on the row until a restore), forwarded messages (`handOffLandingMessage` carries
  the mark to the new chat), a reply's text sent as a prompt (Generate image/video, `assistantText`), any suggestion
  clicked (follow-ups, welcome screen, search, canvas quick actions, onboarding templates), the prompt improver's Apply,
  a gallery item's stored prompt even edited, and an organization's variable default or active name filled into a
  prompt (`organizationValueNames`; not a value typed into the fill dialog, nor the prompt's own `user.organization` default). `usePromptLoader` waits for the session first. The web client marks the draft itself, never matches text: the mark stays
  through edits, pane switches, a reload, the queue and a failed send, and goes when the draft is sent or emptied
  (`features/chat/core/utils/draft-origin.ts`); each send names it as `draftFrom`. An edit keeps the original's mark;
  a steer's lives in `persistentStreams.notTypedSteers` until delivery. A stateless run saves its prompt again: pass it
  through `statelessPrompt` with the saved row's marks, never the bare text. Prompt history and Restore to input send an
  admin's prompt again as `draftFrom: "impersonated"`. A quoted reply (the quote chip) is refused by its
  `>` lines (`carriesQuotedLines`), not marked, so deleting the chip leaves typed text usable. A plain-text paste stays unseen. A new draft kind goes in
  `NOT_TYPED_DRAFTS` and `vNotTypedDraft` (`not-typed-text-validator.ts`; a type check fails until both agree), which the
  stored mark, `steerRun` and `saveLocalTurn` use; the `/chat/start`, steer and verdict tests walk the list. Still unmarked, to mark
  before the fill ships: bot instructions and personalization an impersonating admin wrote (a `systemContext` kind
  that refuses) and the variable defaults one wrote; an accepted ghost-text completion (`composer-tiptap/extensions/ghost-completion.ts`);
  Restore to input of a collaborator's message in a shared chat. The allowlist refuses a step holding a page's result or an approval's
  request and response parts: the fill navigates and types inside its one call, and its own approval parts are admitted
  only for that call's id, added here on purpose.
