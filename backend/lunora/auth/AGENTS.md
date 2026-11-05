# AUTH — AGENT NOTES

The rules for working in `backend/lunora/auth/` (auth, invitations, RLS, the authz matrix). The detail and
reasoning are in [docs/agents/backend-auth.md](../../../docs/agents/backend-auth.md).

## INVITE-ONLY REGISTRATION

- **INVITE-ONLY REGISTRATION**: sign-up needs an invitation (`inviteOnly()` plugin + `signUpInvitation` table), and anonymous (guest) sign-in is refused (`GUEST_SIGN_IN_DISABLED`, `auth/sign-in-methods.ts`). Off, guests work as before.
- `GET /api/auth/sign-in-methods` reports `inviteOnly`; the web app reads it to drop guest chat and sign-up links (`features/auth/hooks/use-sign-in-methods.ts`).
- `SIGNUP_INVITE_ONLY` turns it off only for `"false"`/`"0"`; anything else, including unset, keeps it on. Never make unset mean open.
- Converting anonymous → real and social first sign-in ARE gated (conversion creates a new user); keep it that way.
- `inviteOnly()` still exempts `isAnonymous` rows upstream; `invite-only.test.ts` (real plugin) pins that — keep it, it matters again if the guest refusal is ever relaxed.
- The token reaches the browser only as `?invite=`, read at submit by `features/auth/lib/invite-token.ts`; never send it empty.
- Bootstrap once after a deploy: `POST $BACKEND_PUBLIC_ORIGIN/admin/seed-invitations` with `Authorization: Bearer $LUNORA_ADMIN_TOKEN` (`auth/seed-invitations-http.ts`); idempotent, `?reissue=1` re-mints pending links.
- That route compares the bearer in constant time, rate-limits per IP BEFORE the check, and answers 503 when `LUNORA_ADMIN_TOKEN` is unset — never open. `lunora run` cannot replace it.
- Do not use upstream `allowFirstUser` (races sign-ups, leaves the deploy window open).
- E2E seeds via `POST /e2e/invitations` (`auth/e2e-seed-http.ts`), 404 unless `ENVIRONMENT=development`, loopback `PUBLIC_ORIGIN` AND `E2E_SEED_TOKEN`; that token lives only in `backend/.dev.vars`, never the deploy. Restart the backend after adding it.
- The plaintext token is never stored (SHA-256 only): a lost link is reissued, not recovered.
- A password sign-up must verify its address wherever mail reaches an inbox: `requireEmailVerification` follows `deliversMail()` (`email/mailer.ts`: the Cloudflare `EMAIL` binding, never dev capture). Do not hard-code it.
- A guest that converts by password sign-up keeps its data even when it verifies in another browser: `auth/guest-conversion.ts` records the guest at sign-up (from the server session only) and hands the move over at `/verify-email`. Keep it beside the anonymous plugin's `onLinkAccount`. The record carries a digest of the sign-up's password hash; a hand-over needs it unchanged, so a reset or change by the address's owner (any path) drops it. Never key the hand-over on request paths.
- Admin surface is `crpc.auth.invitations.*`, all `adminAction`; nothing sends mail (`createInvitation` returns the URL).

## Auth

- `authorizeShard` (`backend/src/shard-routing.ts#createShardAuthorizer`) must COMPARE the shard key with the caller / a `.global()` grant's `ownerId`, never pattern-match a prefix; never admit an anonymous caller to a user shard.
- Grants are cached 30s per isolate at the shard gate: procedures must re-read the grant themselves.
- Bearer JWTs must be VERIFIED against our JWKS (`resolveIdentity`, `jose`), never just decoded.
- The live-query socket never carries the JWT: POST the bearer to `/_lunora/ws-ticket` and send the single-use 30s ticket (`lib/ws-ticket.ts`, `wsTicket` table, `DELETE … RETURNING`). `?token=` is only ever redeemed as a ticket; `requestBearer` reads the `Authorization` header alone.
- JWT note: `iss`/`aud` are set explicitly to the backend's `PUBLIC_ORIGIN` on `jwt()` in `auth.ts`; keep it. `VITE_LUNORA_URL` must equal `PUBLIC_ORIGIN` — the deploy feeds both from one secret, do not split them.
- The better-auth tables in `schema.ts` are hand-maintained; run `lunora/auth.schema.test.ts` after any better-auth bump. New columns: declare optional; add them to the local D1 by hand with `sqlite3` (never ALTERed) and touch a source file.
- Remove a store-level workaround only when a fresh WRITE (`INSERT`) proves it unnecessary, never a read.
- **Row-level security** (`backend/lunora/lib/rls/`) is defence in depth UNDER each procedure's check: every client-reachable builder in `lib/crpc.ts` (bare `query`/`mutation` included) ends in `withRlsScope` + `rls(POLICIES)` after auth middleware.
- RLS policies only decide "connected to this row at all"; WHICH permission a grant carries stays the procedure's job. Internal functions see every row; `admin*` builders open an admin scope.
- Actions are unguarded, so no action may touch `ctx.db` (`rls.guard.test.ts`). Do not set the schema to `.rls("required")`.
- RLS note — sharing works by ADMISSION: access helpers (`resolveThreadReadAccess`, `requireOwnedThread`, `resolvePageAccess`, `requireOwnedPage`, `admitOwnedThread`, …) decide via `systemDb(ctx)` then `admit*` into `ctx.rlsScope`. A new sharing path must admit.
- RLS note — a child is invisible until its parent is admitted: use `parentKeyOf(ctx, "messages", id, "threadId")`, decide on the parent, then read via `ctx.db`; run access checks BEFORE dependent parallel reads.
- RLS note — `systemDb`/`parentKeyOf` bypass RLS (importers listed in `rls.guard.test.ts`): use them for DECISIONS only, never to hand rows to an unproven caller.
- RLS note — `count()` throws behind a read policy (`COUNT_RLS_UNSUPPORTED`): own-row counts go through `systemDb`.
- RLS note — a policed table denies any write op without a policy: `policiesFor` declares read/insert/update/delete; `update` is checked before AND after the patch.
- RLS note — `ctx.db.<table>` behind `rls()` is the guarded facade; do not re-add a facade workaround (#797). By-id calls name their table (`ctx.db.get("user", id)`).
- RLS note — layers AND together: spell each builder chain (incl. admin) out from the generated builder, never derive admin from a guarded user builder.
- RLS note — every schema table is policed or listed in `UNPOLICED_TABLES` with a reason; decide each new table there.
- Every client-reachable procedure needs a reviewed row in `docs/security/authz-matrix.md` (`lunora/authz-matrix.guard.test.ts`); one without auth middleware (bare, `public*`, `optionalAuth*`) also goes in that test's allowlist.
- Check owner on every id from args; take `organizationId` from args only via `assertOwnOrganizationId`; a relationship/link row is never a read grant on the thread it names.
- Organization membership grants nothing by itself (threads, vault files); org features share explicitly. Billing tier and credit allowances (`auth_billing.setOrganizationBillingTier`, `setMemberCreditOverride`) are platform-admin only.
