# VAULT — AGENT NOTES

## SAVED SITE LOGINS (`site-logins.ts`)

- The password is encrypted with the `site-logins` key purpose and never leaves the server: no procedure, export,
  log line or model-facing list returns it or its ciphertext. The UI learns only `hasPassword: true`.
- A login belongs to one exact origin (`lib/site-origin.ts#normalizeSiteOrigin`: HTTPS only, punycode host, default
  port dropped, a trailing-dot host refused since the browser keeps the dot). Compare origins as plain strings; never match a subdomain, port or suffix. The origin of a saved login
  never changes on edit.
- Which run may use a login is decided from its THREAD and TURN (`usableSiteLogins`), never from client input: only a
  turn the owner started (`startedBy`), only in a thread `devices/internal.ts#loadEligibleThread` admits (not shared,
  public, a group chat, a messenger conversation or deleted). Then the owner's own chats get every login; a teammate's
  thread only the logins naming that teammate, and none once the teammate is deleted (its threads keep `botId`).
- Logins live on the owner's own shard: save/delete refuse and list returns nothing on `__root__` or when `servesUser`
  is false (`servesUser` alone admits `__root__`, which any caller can name; a collaborator reaches every procedure on a
  shared thread's shard). Dev `SHARD_ROUTING=off` puts everyone on root, so root is allowed there. A save keeps only
  the caller's own teammate ids and drops any other (deleted, or hidden as someone else's), so the web form sends a
  login's ids unfiltered when its bot list could be another account's cached one.
- The export carries each login's `teammateIds`, never the password or ciphertext.
- No audit triggers on `savedSiteLogins`: a history snapshot would outlive the row with the ciphertext in it.
- The fill itself (browser tool, approval per site per thread, activity entry) is the next part. It passes
  `siteLoginForFill` the origin of the page the browser is on, never a site the model names; checks that origin again
  inside the browser-renderer right before typing, after any navigation; and decrypts and types in one action, never
  returning the ciphertext from a workflow step or putting it in a queue payload.
