# VAULT — AGENT NOTES

## SAVED SITE LOGINS (`site-logins.ts`)

- The password is encrypted with the `site-logins` key purpose and never leaves the server: no client-reachable
  procedure, export, log line or model-facing list returns it or its ciphertext. The UI learns only `hasPassword: true`.
  The one exception is the internal `siteLoginForFill`, which returns the ciphertext for the server-side fill action (the next part);
  keep it internal and keep the ciphertext inside the action that decrypts it.
- A login belongs to one exact origin (`lib/site-origin.ts#normalizeSiteOrigin`: HTTPS only, punycode host, default
  port dropped, a trailing-dot host refused since the browser keeps the dot). Compare origins as plain strings; never match a subdomain, port or suffix. The origin of a saved login
  never changes on edit.
- Which run may use a login is decided from its THREAD and TURN (`usableSiteLogins`), never from client input: only
  the owner's own turn at the app (`isOwnInteractiveTurn`: `startedBy` is the owner, origin `lead`, not headless, not
  impersonated), whose prompt row the owner typed (theirs, no `agentName`, no outside agent's or guest's text), in a
  thread `devices/internal.ts#loadEligibleThread` admits (not shared, public, a group chat, a messenger conversation or
  deleted) that no trigger, task or eval opened. `startedBy` alone proves nothing: a public API run records the key's owner. A new run origin gets no login
  until it is added there on purpose. Then the owner's own chats get every login; a teammate's thread only the logins
  naming that teammate, and none once the teammate is deleted (its threads keep `botId`).
- Logins live on the owner's own shard: save/delete refuse and list returns nothing on `__root__` or when `servesUser`
  is false (`servesUser` alone admits `__root__`, which any caller can name; a collaborator reaches every procedure on a
  shared thread's shard). Dev `SHARD_ROUTING=off` puts everyone on root, so root is allowed there. A save keeps only
  the caller's own existing teammate ids (a deleted one is dropped) and checks the 20-bot limit on what it keeps, so the
  web form always sends a login's ids unfiltered: its cached bot list cannot tell a deleted bot from a new one.
- An admin acting as the owner saves, changes and deletes no login (`refuseImpersonation`, `FORBIDDEN` "… while
  impersonating"): the agent types a login in the owner's own turns, so a planted one would outlive the impersonation.
  The list stays readable (no secret in it, as the API key list); the web form hides save, edit and delete until the
  session reads as the user's own (`useImpersonationState`).
- The export carries each login's `teammateIds`, never the password or ciphertext.
- No audit triggers on `savedSiteLogins`: a history snapshot would outlive the row with the ciphertext in it.
- The fill itself (browser tool, approval per site per thread, activity entry) is the next part. It passes
  `siteLoginForFill` the origin of the page the browser is on, never a site the model names; checks that origin again
  inside the browser-renderer right before typing, after any navigation; and decrypts and types in one action, never
  returning the ciphertext from a workflow step or putting it in a queue payload. It fills the turn from its tool context
  (`dispatchOrigin`, `headless`, `startedBy`, `promptMessageId`; `ToolCtx.messageId` is never set). No turn records
  impersonation yet: record it on the turn at `/chat/start` and carry it through a pause's snapshot, never default it to
  `false`. A resumed or approved run's `promptMessageId` is not the prompt, so it gets no login until that is carried too.
