# AUTH — AGENT NOTES — REFERENCE

The rules are summarized in `backend/lunora/auth/AGENTS.md`, which agents load automatically; this file holds the reasoning and detail. Paths are repo-relative where they start at a top-level folder; shorter ones (`lib/…`, `auth/…`, `lunora/…`) are relative to `backend/lunora/` (or `backend/` for `lunora/…`), and `features/…` to `apps/web/src/`.

## INVITE-ONLY REGISTRATION

Sign-up requires an invitation; anonymous sign-in does not. `@lunora/auth`'s
`inviteOnly()` plugin plus the `signUpInvitation` table.

- **`SIGNUP_INVITE_ONLY` only turns it OFF** — `"false"` or `"0"`. Anything
  else, **including unset**, keeps it on. The failure direction of that flag is
  "anyone can register", so unset must not mean open.
- **Converting anonymous → real IS gated**, deliberately: better-auth creates a
  NEW user and links the anonymous one afterwards, so conversion is
  registration. Browse anonymously without an invitation; keep an account only
  with one. Social first-sign-in is gated for the same reason.
- **Anonymous sign-in is exempt upstream, and nothing of ours guards it.**
  `inviteOnly()`'s `user.create.before` exempts rows carrying `isAnonymous` when
  the `anonymous` plugin is installed. `invite-only.test.ts` drives the REAL
  plugin and asserts that exemption — if upstream ever drops it, that test is the
  only thing that notices.
- **The token reaches the browser only as `?invite=`**, read at submit time by
  `features/auth/lib/invite-token.ts` — not threaded through auth-card props,
  because the anonymous-conversion dialog needs it too and is not a child of that
  route. Never send it empty: the gate answers `SIGN_UP_INVITE_INVALID` for `""`,
  which reads worse than `SIGN_UP_INVITE_REQUIRED`.
- **Bootstrapping deadlocks without a seed** — `createInvitation` needs an admin,
  an admin needs an account, an account needs an invitation. Once after a
  deploy, run:

    ```bash
    curl -fsS -X POST "$BACKEND_PUBLIC_ORIGIN/admin/seed-invitations" \
         -H "Authorization: Bearer $LUNORA_ADMIN_TOKEN"
    ```

    It invites every address in `ADMIN` and returns
    `{ invitations: [{ email, status, signUpUrl? }] }`. **Idempotent:** a re-run
    mints nothing, reporting `pending` (unexpired link already out) or
    `registered` (spent), so it never kills a link you already sent. Only a
    missing or expired invitation is `issued` with a link; `?reissue=1` re-mints
    the pending ones when a link was lost. Bearer compared in constant time,
    rate-limited per IP BEFORE the check (`admin/seedInvitations`, 5 / 15 min),
    503 when `LUNORA_ADMIN_TOKEN` is unset — never open.
    (`auth/seed-invitations-http.ts`.) **`lunora run` cannot do this**: a
    client RPC to an internal function answers `FUNCTION_NOT_FOUND` whatever token
    it carries, which is why the route exists. `allowFirstUser` is upstream's
    alternative and deliberately NOT used — it races concurrent sign-ups and
    leaves the window between deploy and the owner signing up open. The e2e suite
    seeds through `POST /e2e/invitations` (`auth/e2e-seed-http.ts`,
    `apps/web/e2e/seed.ts`), which is 404 unless `ENVIRONMENT=development`,
    `PUBLIC_ORIGIN` is loopback AND `E2E_SEED_TOKEN` is set — that token lives only
    in `backend/.dev.vars` (dev-setup, CI), and the deploy binds none. It replaced
    writing the row into the local D1 file, which fought workerd for the lock
    ("database is locked" → 500). A backend started before the token was in
    `.dev.vars` answers 404 until restarted.

- The plaintext token is never stored (SHA-256 only), so a lost link is
  **reissued**, not recovered.
- Admin surface: `crpc.auth.invitations.*`, all `adminAction`. Nothing sends
  mail — `createInvitation` returns the URL and delivery is the operator's.

## Auth

- **`authorizeShard` must compare, not pattern-match**
  (`backend/src/shard-routing.ts#createShardAuthorizer`). A shard key is `__root__`
  (open) or a user id, admitted for that user and for anyone they granted a
  thread or page — a `.global()` grant row with `ownerId` = that shard, read raw
  from D1 and cached 30s per isolate (so a revoked grant passes the SHARD gate
  that long; the procedure re-reads the grant). A prefix heuristic like
  `!shardKey.startsWith("user_")` never fires — better-auth ids carry no prefix —
  and silently allows cross-user Durable Object access. An anonymous caller is
  never admitted to a user shard; public views cross over server-side.
- **The bearer path needs its own verification.** The browser client
  authenticates with the JWT from `/api/auth/token`; `getSession()` does not read
  it, so `resolveIdentity` verifies it against our JWKS with `jose`. Decoding
  without verifying would let any caller assert any `sub`.
- **The live-query socket never carries the JWT.** Workers observability logs
  every request URL, and a browser `WebSocket` can only send its credential in
  the URL. So the web client POSTs its bearer to `/_lunora/ws-ticket` before
  each (re)connect and the socket sends the returned single-use, 30s ticket
  (`lib/ws-ticket.ts`, a raw `wsTicket` D1 table redeemed with
  `DELETE … RETURNING`, created lazily per isolate, purged on every mint and
  on the Worker's `scheduled()` tick). It rides as `?token=` only because that is the one
  name `LunoraClient`'s `wsToken` provider appends; `requestBearer` reads the
  `Authorization` header alone, and `?token=` is only ever redeemed as a ticket.
- **The JWT's `iss` and `aud` are the backend's `PUBLIC_ORIGIN`, set explicitly** on the
  `jwt()` plugin in `auth.ts`. better-auth defaults both to `baseURL`, which is `SITE_URL`
  (the WEB origin in every deployed topology), and `@lunora/auth` only allows the request's
  own host for a loopback `baseURL` — so locally the token matched `PUBLIC_ORIGIN` by luck,
  and on staging every bearer failed `server.ts`'s pin: RPCs ran anonymous on `__root__`
  ("Please sign in to continue") with no error logged, and the app looked signed-out. A
  rejected bearer now logs its jose error (`bearer-rejected`). The config coupling stays:
  **`VITE_LUNORA_URL` must equal the backend's `PUBLIC_ORIGIN`**. The deploy job feeds both
  from one secret — do not split them.
- **Our better-auth tables in `schema.ts` are hand-maintained copies, and a
  better-auth bump can break every auth request.** Since 1.7.3 (upstream #690)
  `lunoraD1Adapter` introspects D1 at init and throws `SchemaMismatchError` on a
  missing column OR a required column better-auth never writes — `/api/health`
  500s. `lunora/auth.schema.test.ts` runs the same rules against `schema.ts` for
  the plugins `buildAuthOptions` installs; run it after any better-auth bump.
  Two traps when fixing: a new column that is required fails the build's drift
  gate (declare it optional; better-auth writes it anyway), and the local D1 keeps
  its old columns — `.global()` tables are created lazily but never ALTERed, so
  add the column with `sqlite3` on `backend/.wrangler/state/v3/d1/…` and touch a
  source file (the adapter caches a failed check per isolate).
- **A store-level workaround is removable only if a WRITE proves it.** A read
  does not: `get-session` answered 200 with and without the `_creationTime`
  decorator, because the rate-limit row already existed and the write was an
  `UPDATE`. Only a fresh `INSERT` fails.
- **Row-level security is defence in depth UNDER each procedure's check**
  (`backend/lunora/lib/rls/`). Every client-reachable builder in `lib/crpc.ts` —
  the bare `query`/`mutation` the `agent/*` files use included — ends in
  `withRlsScope` + `rls(POLICIES)`, after its auth
  middleware. Policies say "is this caller connected to this row AT ALL" (owner,
  or a thread/page/org the request proved); WHICH permission a grant carries
  stays the procedure's job. Internal functions (scheduler, queue, crons,
  workflows) are built without it and see every row; `admin*` builders open an
  admin scope that every policy allows. Actions are unguarded — no action may
  touch `ctx.db` (`rls.guard.test.ts` pins it). The schema is NOT
  `.rls("required")`: that mode guards internal functions too, and would fail
  closed on all of them. Non-obvious rules:
    - **Sharing works by ADMISSION.** Policies are synchronous and memoized per
      table per request, so they cannot look a grant up. The access helpers
      (`resolveThreadReadAccess`, `requireOwnedThread`, `resolvePageAccess`,
      `requireOwnedPage`, `admitOwnedThread` after an ad-hoc owner check, the
      share-token reads, org membership checks) decide past RLS through
      `systemDb(ctx)` and then `admit*` the resource into `ctx.rlsScope`. Read
      predicates close over the scope's ARRAYS by identity, so a row admitted
      after the predicate was built still matches. A new sharing path must
      admit, or its reads come back empty.
    - **"Load a child by id, then check its parent" returns `null` now** — the
      child is invisible until the parent is admitted. Use
      `parentKeyOf(ctx, "messages", id, "threadId")`, decide on the parent, then read the
      row through `ctx.db`. Likewise, run the access check BEFORE a parallel
      read that depends on it (`getThreadAccess` used to `Promise.all` them).
    - **`systemDb`/`parentKeyOf` bypass RLS** and every importing file is listed
      in `rls.guard.test.ts` — use them for DECISIONS (existence, ownership of a
      storage key, uniqueness, a count of the caller's own rows), never to hand
      rows to a caller who was not proven to reach them.
    - **`count()` throws behind a read policy** (`COUNT_RLS_UNSUPPORTED`), even
      with a `where` equal to the policy. Own-row counts go through `systemDb`.
    - **A table with any policy denies every write op it has no policy for**, so
      `policiesFor` always declares read/insert/update/delete. `update` is checked
      on the row before AND after the patch.
    - **`ctx.db.<table>` behind `rls()` is the GUARDED facade**: the wrapper
      re-binds the facades the runtime sets on `ctx.db` over the policy writer
      (checked at runtime: present, and a stranger's `findFirst`/`get`/`findMany`
      return nothing). A test ctx without them (`lunoraTest` before
      `test/setup-harness.ts` binds them) has none behind `rls()` either — that
      is what #797 reported; do not re-add a workaround.
    - **By-id calls name their table** (`ctx.db.get("user", id)`), so the RLS
      wrapper no longer probes every policed table for a bare id. The facade form
      `ctx.db.user.get(id)` passes the table too.
    - **RLS layers AND together**, so an admin builder derived from a guarded
      user builder could never widen — each builder chain is spelled out from the
      generated builder.
    - Every schema table is either policed or listed in `UNPOLICED_TABLES` with
      its reason (better-auth/org tables, content-addressed `chatFiles`,
      owner-less child rows reached only through a checked parent, counters).
      A new table must be decided there, or the guard fails.
- **Every client-reachable procedure has a reviewed row in
  `docs/security/authz-matrix.md`**, and `lunora/authz-matrix.guard.test.ts`
  fails when `_generated/api.ts` gains or loses one without the matrix
  following — so a new procedure means checking its ownership rule and adding a
  row. A procedure built WITHOUT auth middleware (bare `query`/`mutation`/`action`,
  `public*`, `optionalAuth*`) must also be named in that test's allowlist. The
  recurring hole shapes were an id from args read with no owner comparison, an
  `organizationId` from args (use `assertOwnOrganizationId`), and a relationship
  or link row treated as a read grant on the thread it names.
- **Organization membership grants nothing by itself** — not on threads, not on
  vault files (owner, or a grant on the file's chat). Org-scoped features share
  explicitly (prompts' `organizationId`, org skills). **Billing tier and credit
  allowances are platform-admin only** (`auth_billing.setOrganizationBillingTier`,
  `setMemberCreditOverride`): billing runs in a separate system, and any user can
  create an org and own it.
