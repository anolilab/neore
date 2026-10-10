# Authorization matrix

The living review artifact for **who may call what** on the backend. Every
client-reachable procedure in `backend/lunora/_generated/api.ts` has exactly one
row below, and `backend/lunora/authz-matrix.guard.test.ts` fails when a
procedure is added, removed or renamed without this file following — so a new
procedure cannot ship without someone having looked at its authorization.

**Why it matters here more than usual.** A user's rows live on their own
shard, which `authorizeShard` opens to them and to anyone they granted a thread
or page — so a collaborator reaches EVERY procedure on the owner's shard, and
`__root__` is open to all (docs/plans/per-user-sharding.md). The procedure's own
check below is therefore the PRIMARY control.
Row-level security (next section) sits underneath it as defence in depth: it
refuses a caller with no connection to a row at all, but does not know which
permission a grant carries — read vs. write vs. admin stays the procedure's job.

Audit: 2026-09-23 · 423 public procedures (+ HTTP routes below) ·
335 ok · 70 fixed · 18 accepted · 0 open.

## How to read and maintain it

- **builder** — from `lib/crpc.ts`. `query` / `mutation` / `action` are the BARE
  generated builders: no auth middleware at all, the handler resolves identity
  itself (`getAuthUserIdentity`). `publicQuery` / `publicAction` are
  unauthenticated by design. `optionalAuth*` may run with `ctx.user = null`.
  `auth*` admit anonymous (guest) users too. `admin*` require `isAdmin`.
  `+ RL` = a `rateLimit(...)` middleware.
- **resources** — tables the handler touches directly (derived from the source;
  helpers it calls may touch more).
- **ownership check** — what stands between a caller-supplied id and another
  user's row. `thread access` = `resolveThreadReadAccess` (owner or live grant;
  `isPublic` is only ever the redacted projection). `org membership` = the id
  must be the caller's active organization (`assertOwnOrganizationId`,
  `validateOrganizationAccess`) or a proven `member` row.
- **status** — `ok`; **fixed** (severity) in this audit, pinned by
  `backend/lunora/authz-regressions.test.ts`; `accepted` with the reason;
  `open` with severity — a known gap not fixed yet.

Adding a procedure: review it against the checklist below, add its row, and run
`pnpm vitest run lunora/authz-matrix.guard.test.ts` in `backend/`. A bare
`query`/`mutation`/`action` or a `public*`/`optionalAuth*` builder must ALSO be
added to the no-auth-middleware allowlist in that test, deliberately.

Checklist per procedure:

1. Every id from args (`ctx.db.get(args.x)`, `withIndex(... args.x)`) is compared
   with `ctx.user.userId` (or passed through a shared access helper) BEFORE any
   read of the row is returned or any write happens.
2. `userId` / `organizationId` never come from args for a write; an org id from
   args is checked for membership before it scopes a read.
3. A list keyed by an arg-supplied user or org id checks that id.
4. Public/optional procedures return a projection, never a full row.
5. Writes that reach a paid provider or fan out to the scheduler are rate-limited.
6. Admin-only effects sit on an `admin*` builder.

## Row-level security

Every client-reachable query and mutation runs its handler behind
`rls(POLICIES)` (`backend/lunora/lib/rls/`), applied by the builders in
`lib/crpc.ts` after their auth middleware — the bare `query`/`mutation` of
`agent/*` and `auth/functions.ts` included. `lib/rls/rls.guard.test.ts` fails
when a client-reachable procedure lacks it. A procedure that FORGETS its check
still cannot read or write a stranger's row: `lib/rls/rls.test.ts` pins that
with test-only procedures that check nothing.

| who | sees / writes |
| --- | --- |
| internal functions (scheduler, jobs queue, crons, workflows) | every row — built without the middleware; system code |
| `admin*` builders | every row — the admin role, checked first, is the control |
| actions | nothing directly — they reach data through `runQuery`/`runMutation`; no action touches `ctx.db` (guarded) |
| everyone else | their own rows, plus rows of resources an access helper ADMITTED for this request |

**Admission.** Policies cannot look grants up (they are synchronous), so the
helpers that already decide sharing record their decision in `ctx.rlsScope`:
`resolveThreadReadAccess` / `requireOwnedThread` / `admitOwnedThread` (owner,
live grant, or the public redacted view), `resolvePageAccess` /
`requireOwnedPage` / `admitGrantedPages` (owner or `pageAccess` grant), the
share-token reads (`getPublicThread`, `getPublicPage`), `acceptPageInvite` (the
token's invite), org membership checks (`admitOrganization`), the group chat's
participant skills and a thread's attached knowledge files. A decision reads
past RLS through `systemDb(ctx)`; every file that does is listed in the guard.

| rule | tables |
| --- | --- |
| owner (`userId` = caller) | `account`, `aiUserPreferences`, `browserExtensions`, `browserSessions`, `chatImportJobs`, `codingAgentRuns`, `documentVersions`, `embeddings_1024`, `embeddings_128`, `embeddings_1408`, `embeddings_1536`, `embeddings_2048`, `embeddings_256`, `embeddings_3072`, `embeddings_4096`, `embeddings_512`, `embeddings_768`, `evalCases`, `evalDatasets`, `evalResults`, `evalRuns`, `folders`, `gatewayNotifications`, `gatewayUsageDeductions`, `gdprAuditLog`, `gdprConsent`, `gdprRequests`, `goals`, `knowledgeChunks`, `knowledgeCollectionLinks`, `mcpServerGrants`, `memories`, `memoryDigests`, `memoryReflectionState`, `messengerConnections`, `oauthStates`, `presentations`, `sandboxSessions`, `session`, `skillInvocations`, `systemPromptPresets`, `taskRuns`, `tasks`, `temporaryThreads`, `threadPins`, `threadRelationships`, `threadTags`, `threadVariables`, `toolApprovalRuns`, `triggers`, `twoFactor`, `usageBackfill`, `usageDaily`, `usageReplies`, `userConnectors`, `userSettings`, `userSkills`, `workflowExecutions`, `workflowPresence`, `workflowVersions` |
| thread-scoped: own rows, or any row of an admitted thread; writes need a write grant | `threads` (by `_id`; `update` write grant, `delete` admin), `messages`, `streamingMessages`, `persistentStreams`, `documents`, `followupSuggestions` |
| thread grants | `threadAccess` (own grant, or any member of an admitted thread reads; admins write), `threadInvites` (owner/admin grantees only) |
| page-scoped | `pages` (own or admitted; `update` needs comment+), `pageComments`, `pageVersions`, `pagePresence`, `pageFavorites` (own rows or any row of a page the caller is a member of), `pageAccess` (own grant, page admins manage), `pageInvites` (page admins, or the bearer of the token) |
| files | `files` (own, or on a chat the caller has a full grant on), `chatFileAccess` (reads open — grants name only file + user; writes own) |
| organization-shared | `prompts` (own or active/proven org), `userVariableDefaults` (same; org admins write), `skills` (own, public, org-shared, or admitted participant; org admins write org skills), `projects` (own, public gallery, or proven org), `knowledgeCollections` (own or active/proven org; owner writes) |
| auth | `user` (reads open — collaborators' names; writes self or admin), `session`, `account`, `twoFactor` (owner) |

**Deliberately unpoliced** — each listed in `UNPOLICED_TABLES`; the guard fails
for a schema table that is neither policed nor listed:

| table | why |
| --- | --- |
| `actionCache` | server-side cache of computed values; no user column |
| `apikey` | better-auth's own table, reached through its adapter and `verifyApiKey` |
| `auditLog` | admin-only audit trail (`admin*` procedures) |
| `browserActions` | no owner column; read only after the parent browser session's owner check |
| `changelogCache` | public changelog cache |
| `chatFiles` | content-addressed and SHARED (same bytes, one row) — no owner; access is the `chatFileAccess` grant |
| `cleanupConfigs` | admin-only configuration |
| `cleanupLogs` | admin-only logs |
| `connectorDefinitions` | global connector catalog |
| `cronRuns` | cron slot claims; system only |
| `payment_customers` | `@lunora/payment` store (Creem customers per organization); written and read only by `ctx.payments` on `__root__` |
| `documentHistory` | audit trail written by triggers; no client read |
| `emails` | outbound mail log; system only |
| `payment_events` | `@lunora/payment` webhook claim log; system only |
| `idempotencyClaims` | internal claims; no client access |
| `invitation` | better-auth organization invitations; org-scoped, checked by org role |
| `jwks` | better-auth signing keys |
| `member` | organization membership; org-scoped, read to PROVE membership |
| `memberCredits` | org billing rows managed by org and platform admins |
| `nodeExecutions` | no owner column; internal only |
| `organization` | better-auth organizations; org-scoped |
| `payment_sessions` | `@lunora/payment` store (Creem checkouts); system only |
| `payment_usageEvents` | `@lunora/payment` usage metering (unused: Creem has none); system only |
| `persistentChunks` | no owner column; read through HTTP actions keyed by a verified stream token |
| `playgroundApiKeys` | internal only |
| `presentationSlides` | no owner column; every access follows the parent presentation's owner check |
| `projectKnowledge` | link rows with no owner column; every access follows the project's owner check |
| `promptHistory` | `userId` is the EDITOR of an org-shared prompt; read under the prompt's rule |
| `rateLimit` | better-auth rate limiter |
| `rateLimits` | rate-limit counters written by every procedure's rate-limit middleware |
| `sandboxActions` | no owner column; internal only |
| `signUpInvitation` | invite-only registration; admin and seed route only |
| `skillFiles` | internal only |
| `skillHistory` | `userId` is the EDITOR (an org admin edits another member's skill); read under the skill's rule |
| `skillRatings` | public ratings of public skills, aggregated across users |
| `skillStats` | per-skill counters with no owner, bumped by any user of a public skill |
| `streamDeltas` | no owner column; read by `streamId` only after the parent `streamingMessages` row passed its policy |
| `payment_subscriptions` | `@lunora/payment` store (Creem subscriptions per organization); system only — the tier lands on `organization` |
| `team` | better-auth teams; org-scoped |
| `teamMember` | better-auth team membership; org-scoped |
| `teamSettings` | org-scoped settings, checked by org role |
| `threadKnowledge` | link rows with no owner column; every access follows a thread access check |
| `triggerExecutions` | no owner column; every access follows the parent trigger's owner check |
| `verification` | better-auth verification tokens |

## Procedures

| procedure | kind | builder | resources | ownership check | status |
| --- | --- | --- | --- | --- | --- |
| `admin_audit_log.getAuditLogEntry` | query | adminQuery | auditLog | admin role | ok |
| `admin_audit_log.getAuditLogs` | query | adminQuery | auditLog | admin role | ok |
| `admin_audit_log.getAuditLogStats` | query | adminQuery | — | admin role | ok |
| `admin_cleanup.executeCleanup` | action | adminAction | — | admin role | ok |
| `admin_cleanup.getCleanupConfig` | query | adminQuery | cleanupConfigs | admin role | ok |
| `admin_cleanup.listCleanupLogs` | query | adminQuery | cleanupLogs | admin role | ok |
| `admin_cleanup.previewCleanup` | query | adminQuery | cleanupConfigs | admin role | ok |
| `admin_cleanup.updateCleanupConfig` | mutation | adminMutation | cleanupConfigs | admin role | ok |
| `admin_gateway_analytics.createGatewayKeyAction` | action | adminAction | — | admin role | ok |
| `admin_gateway_analytics.getGatewayAnalytics` | action | adminAction | — | admin role | ok |
| `admin_gateway_analytics.listGatewayKeysAction` | action | adminAction | — | admin role | ok |
| `admin_gateway_analytics.revokeGatewayKeyAction` | action | adminAction | — | admin role | ok |
| `agent_branches.switchBranch` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `agent_document_history.getVersion` | query | query | documents | identity (self-resolved); row.userId == caller | ok |
| `agent_document_history.listVersions` | query | query | documents | identity (self-resolved); row.userId == caller | ok |
| `agent_documents.getDocument` | query | query | documents | identity (self-resolved); row.userId == caller | ok |
| `agent_documents.getDocumentByMessage` | query | query | — | identity (self-resolved); row.userId == caller | ok |
| `agent_documents.getDocumentsByThread` | query | query | threads | identity (self-resolved); row.userId == caller | ok |
| `agent_documents.updateDocument` | mutation | authMutation | documentVersions, documents | identity (self-resolved); row.userId == caller | accepted — owner-only; no rate limit, `v.any()` commit/contentJson (low) |
| `agent_messages.listMessagesByThreadId` | query | query | — | thread access (owner/grant); identity (self-resolved) | ok |
| `agent_projects.getProject` | query | query | projects | identity (self-resolved); row.userId == caller | **fixed** (low) — owner-only; public projects are served by the gallery projection |
| `agent_projects.listPinnedProjects` | query | query | projects | identity; org membership | **fixed** (high) — org branch requires membership |
| `agent_projects.listProjects` | query | query | — | identity; org membership | **fixed** (high) — org branch requires membership — any org's projects (context, share tokens) were listable |
| `agent_projects.listThreadsByProject` | query | query | projects | identity (self-resolved); row.userId == caller | ok |
| `agent_streams.list` | query | query | threads | thread access (owner/grant) | **fixed** (medium) — `isPublic` no longer grants raw stream rows |
| `agent_streams.listDeltas` | query | query | streamingMessages, threads | thread access (owner/grant) | **fixed** (medium) — `isPublic` no longer grants raw deltas |
| `agent_threads.getChildThreads` | query | query | threadRelationships, threads | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.getTemporaryThread` | query | query | temporaryThreads, threads | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.getTemporaryThreads` | query | query | — | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.getTemporaryThreadsByThreadIds` | query | query | threads | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.getThread` | query | query | threads | thread access (owner/grant); identity (self-resolved) | ok |
| `agent_threads.getThreadListDataBatch` | query | query | — | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.getThreadRelationship` | query | query | threadRelationships, threads | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.getThreadUsage` | query | query | threads | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.listPinnedThreads` | query | query | — | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.listThreadOrders` | query | query | — | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.listThreadsByUserId` | query | query | — | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.searchThreadsByTitleAndSummary` | query | query | — | identity (self-resolved); row.userId == caller | ok |
| `agent_threads.searchThreadTitles` | query | query | — | identity (self-resolved); scoped to caller | ok |
| `agent_workflow_executions.get` | query | query | workflowExecutions | identity (self-resolved); row.userId == caller | ok |
| `agent_workflow_executions.listByProject` | query | query | projects | identity (self-resolved); row.userId == caller | ok |
| `auth_admin.banUser` | mutation | adminMutation | user | admin role; row.userId == caller | ok |
| `auth_admin.checkUserAdminStatus` | query | adminQuery | user | admin role | ok |
| `auth_admin.getAllUsers` | query | adminQuery | user | admin role | ok |
| `auth_admin.getDashboardStats` | query | adminQuery | user | admin role | ok |
| `auth_admin.getUserBanStatus` | query | adminQuery | user | admin role | ok |
| `auth_admin.grantAdminByEmail` | mutation | adminMutation | user | admin role | ok |
| `auth_admin.isCurrentUserAdmin` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `auth_admin.isImpersonating` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `auth_admin.listUserSessions` | query | adminQuery | session, user | admin role | ok |
| `auth_admin.logImpersonationStart` | mutation | adminMutation | user | admin role | ok |
| `auth_admin.logImpersonationStop` | mutation | adminMutation | user | admin role | ok |
| `auth_admin.revokeAdminByEmail` | mutation | adminMutation | user | admin role | ok |
| `auth_admin.revokeAllUserSessions` | mutation | adminMutation | session, user | admin role; row.userId == caller | ok |
| `auth_admin.searchUsers` | query | adminQuery | user | admin role | ok |
| `auth_admin.unbanUser` | mutation | adminMutation | user | admin role | ok |
| `auth_admin.updateUserRole` | mutation | adminMutation | user | admin role; row.userId == caller | ok |
| `auth_api_keys.createScopedApiKey` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `auth_billing.getBillingInfo` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `auth_billing.getMemberCredits` | query | authQuery | memberCredits | caller-scoped (ctx.user) | **fixed** (low) — another member's credits need owner/admin |
| `auth_billing.listMemberCredits` | query | authQuery | member, memberCredits, user | caller-scoped (ctx.user) | ok |
| `auth_billing.setMemberCreditOverride` | mutation | adminMutation + RL | memberCredits | admin role; org membership/role | **fixed** (medium) — now `adminMutation` (platform admin), org id explicit |
| `auth_billing.setOrganizationBillingTier` | mutation | adminMutation + RL | organization | admin role | ok — new; platform admin only (billing runs in a separate system) |
| `auth_billing.updateBillingSettings` | mutation | authMutation + RL | organization | caller-scoped (ctx.user) | **fixed** (medium) — owner sets contact e-mail and models only; tier/credits moved to `setOrganizationBillingTier` |
| `auth_functions.getAIUserPreferences` | query | query | — | identity (self-resolved); own row, ciphertext redacted | ok |
| `auth_functions.getCurrentUser` | query | query | — | identity (self-resolved); self | ok |
| `auth_functions.getSessionUserQuery` | query | query | — | identity (self-resolved); self | ok |
| `auth_functions.getUserSettings` | query | query | — | identity (self-resolved); own row | ok |
| `auth_functions.hasPassword` | query | query | account | session; self | ok |
| `auth_functions.initializeUserSettings` | mutation | authMutation | userSettings | caller-scoped (ctx.user) | ok |
| `auth_functions.updateAIUserPreferences` | mutation | authMutation | — | identity (self-resolved); own row; BYOK RL | ok |
| `auth_functions.updateUserSettings` | mutation | authMutation | — | identity (self-resolved); input excludes userId | ok |
| `auth_invitations.createInvitation` | action | adminAction | — | admin role | ok |
| `auth_invitations.listInvitations` | action | adminAction | — | admin role | ok |
| `auth_invitations.pruneInvitations` | action | adminAction | — | admin role | ok |
| `auth_invitations.revokeInvitation` | action | adminAction | — | admin role | ok |
| `auth_organization.acceptInvitation` | mutation | authMutation | — | caller-scoped (ctx.user) | ok |
| `auth_organization.cancelInvitation` | mutation | authMutation + RL | — | org membership/role | ok |
| `auth_organization.checkSlug` | query | authQuery | — | none needed (boolean) | ok |
| `auth_organization.createOrganization` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | ok |
| `auth_organization.deleteOrganization` | mutation | authMutation | — | org membership/role | ok |
| `auth_organization.getActiveMember` | query | authQuery | member | caller-scoped (ctx.user) | ok |
| `auth_organization.getOrganization` | query | authQuery | — | org membership/role | **fixed** (low) — members only; non-members get null like an unknown slug |
| `auth_organization.getOrganizationOverview` | query | authQuery | invitation | caller-scoped (ctx.user) | accepted — the invite link is the capability |
| `auth_organization.inviteMember` | mutation | authMutation + RL | — | org membership/role | **fixed** (medium, dormant) — only an owner invites an owner |
| `auth_organization.leaveOrganization` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | ok |
| `auth_organization.listMembers` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `auth_organization.listOrganizations` | query | authQuery | — | org membership/role | ok |
| `auth_organization.listPendingInvitations` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `auth_organization.listUserInvitations` | query | authQuery | invitation | caller-scoped (ctx.user) | ok |
| `auth_organization.rejectInvitation` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | ok |
| `auth_organization.removeMember` | mutation | authMutation + RL | — | org membership/role | ok |
| `auth_organization.setActiveOrganization` | mutation | authMutation + RL | — | better-auth membership check | ok |
| `auth_organization.updateMemberRole` | mutation | authMutation + RL | member | org membership/role | **fixed** (high, dormant) — member must be in the active org; only an owner grants owner |
| `auth_organization.updateOrganization` | mutation | authMutation + RL | — | org membership/role | ok |
| `auth_team.addTeamMember` | mutation | authMutation + RL | member, team, teamMember | caller-scoped (ctx.user) | **fixed** (medium) — org owner/admin or team admin; any org member could add anyone |
| `auth_team.createTeam` | mutation | authMutation + RL | team | caller-scoped (ctx.user) | ok |
| `auth_team.deleteTeam` | mutation | authMutation + RL | team, teamMember | caller-scoped (ctx.user) | ok |
| `auth_team.getMyTeams` | query | authQuery | team, teamMember | caller-scoped (ctx.user) | ok |
| `auth_team.getTeam` | query | authQuery | team, teamMember | caller-scoped (ctx.user) | ok |
| `auth_team.getTeamSettings` | query | authQuery | organization, team, teamMember, teamSettings | caller-scoped (ctx.user) | ok |
| `auth_team.leaveTeam` | mutation | authMutation + RL | team, teamMember | caller-scoped (ctx.user) | ok |
| `auth_team.listTeamMembers` | query | authQuery | team, teamMember | caller-scoped (ctx.user) | ok |
| `auth_team.listTeams` | query | authQuery | team, teamMember | caller-scoped (ctx.user) | ok |
| `auth_team.removeTeamMember` | mutation | authMutation + RL | team, teamMember | caller-scoped (ctx.user) | **fixed** (medium) — org owner/admin or team admin |
| `auth_team.setActiveTeam` | mutation | authMutation + RL | session, team, teamMember | caller-scoped (ctx.user) | ok |
| `auth_team.updateTeam` | mutation | authMutation + RL | team | caller-scoped (ctx.user) | ok |
| `auth_team.updateTeamMemberRole` | mutation | authMutation + RL | team, teamMember | org membership/role | ok |
| `auth_team.updateTeamSettings` | mutation | authMutation + RL | team, teamSettings | org membership/role | ok |
| `billing_checkout.createCheckout` | action | authAction + RL | — (Creem adapter) | `pro`: reference = caller's own user id, guests refused; `team`: active org, owner only (`billingOrganizationOf`; admins have `billing: read`), the paid webhook records the payer as `creemPurchaserId` (checkout metadata) | ok — new; Pro is per user so one seat cannot cover an org |
| `billing_checkout.getMyPlan` | query | authQuery | user | caller-scoped (ctx.user) — own row only | ok — new |
| `billing_checkout.getTeamPlansIPay` | query | authQuery | organization, member (count) | caller-scoped: organizations whose `creemPurchaserId` is the caller (indexed); returns name + member count only, for the delete-account warning | ok — new |
| `billing_checkout.openCustomerPortal` | action | authAction + RL | user, organization (customer id) | `user`: caller's own row; `organization`: active org owner AND the recorded purchaser (`creemPurchaserId`) — the org's Creem customer is the purchaser's own | ok — new; portal for the caller's own Pro or their org's Team only |
| `changelog_functions.getChangelogs` | action | publicAction | — | none (public) | accepted — public by design; cached with a module cooldown |
| `chat_ask_user.answerAskUser` | mutation | authMutation + RL | toolApprovalRuns, threads | thread owner only (as `respondToToolApproval`); the request must be an `askUser` call on the latest turn | ok |
| `chat_autocomplete.suggestCompletion` | action | authAction + RL | userSettings | caller-scoped (ctx.user); refuses unless the caller's own opt-in setting is on; the draft comes from the caller and is sent to the utility model as JSON data; reads no thread | ok |
| `chat_import_functions.cancelImportJob` | mutation | authMutation | chatImportJobs | row.userId == caller | ok |
| `chat_import_functions.getImportStatus` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_import_functions.startImportJob` | mutation | authMutation + RL | chatImportJobs | key rebuilt under the CALLER's staging prefix from `uploadId` (`uploads/<userId>/<uploadId>`) — never caller-chosen | **fixed** (high) — any r2Key was read and then deleted; later a `files` row the caller owned, now ownership by construction (`lib/upload-route.ts`) |
| `chat_composite.getThreadListData` | query | liteAuthQuery | — | caller-scoped (ctx.user) | ok |
| `chat_composite.getThreadWithData` | query | liteAuthQuery | threads | thread access (owner/grant) | ok |
| `chat_custom_providers.deleteCustomProvider` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | ok |
| `chat_custom_providers.listCustomProviders` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_custom_providers.probeCustomProvider` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `chat_custom_providers.saveCustomProvider` | mutation | authMutation + RL | aiUserPreferences | caller-scoped (ctx.user) | ok |
| `chat_functions.abortStreamByMessageId` | mutation | authMutation | threads | thread access (owner/grant) | ok |
| `chat_functions.branchThread` | action | authAction + RL | threads | row.userId == caller | ok |
| `chat_functions.continueThread` | action | authAction + RL | threads | thread access (owner/grant) | accepted — rate-limited; advisor: no maxOutputTokens bound |
| `chat_functions.convertTemporaryToPermanent` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.createExtensionPairing` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | ok |
| `chat_functions.createThread` | mutation | authMutation + RL | projects, teamMember | org membership/role; row.userId == caller | **fixed** (low) — organizationId must be the active org |
| `chat_functions.createThreadRelationshipPublic` | mutation | authMutation + RL | threads | row.userId == caller (both ends) | **fixed** (critical) — both threads must be the caller's; a link to a stranger's thread was a read grant on it |
| `chat_functions.deleteThread` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.deleteThreads` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `chat_functions.generateSummary` | action | authAction + RL | threads | thread access (owner/grant) | **fixed** (low) — write access (it overwrites the summary) |
| `chat_functions.getAllThreadRelationships` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_functions.getAnonymousMessageLimit` | query | publicQuery | — | identity (self-resolved) | accepted — public by design; caller's own counter |
| `chat_functions.getBrowserActions` | query | authQuery | browserActions | row.userId == caller | ok |
| `chat_functions.getBrowserExtensions` | query | authQuery | browserExtensions | caller-scoped (ctx.user) | ok |
| `chat_functions.getBrowserSession` | query | authQuery | threads | row.userId == caller | ok |
| `chat_functions.getBrowserSettings` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_functions.getCachedFollowupSuggestions` | query | authQuery | threads | thread access (owner/grant) | ok |
| `chat_functions.getChildThreads` | query | authQuery | threads | row.userId == caller | **fixed** (high) — children filtered to the caller's own |
| `chat_functions.getFollowupSuggestions` | action | authAction + RL | threads | thread access (owner/grant) | **fixed** (low) — rate limit on an LLM call |
| `chat_functions.getFullThreadForExport` | query | authQuery | threads | row.userId == caller | **fixed** (critical) — parent messages read only when the caller owns the parent |
| `chat_functions.getMessageRateLimit` | query | optionalAuthQuery | — | caller's own counter | ok |
| `chat_functions.getPinnedThreads` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_functions.getStreamingThreadIds` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_functions.getTemporaryThreads` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_functions.getThread` | query | optionalAuthQuery | threads | thread access (owner/grant) | ok |
| `chat_functions.getThreadMessages` | query | authQuery | threads | thread access (owner/grant) | ok |
| `chat_functions.getThreadOrders` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_functions.getThreads` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_functions.getThreadTemporaryStatus` | query | liteAuthQuery | threads | row.userId == caller | ok |
| `chat_functions.getThreadUIMessages` | query | liteAuthQuery | threads | thread access (owner/grant) | ok |
| `chat_functions.listMCPToolsMeta` | action | authAction + RL | — | caller-scoped (ctx.user) | **fixed** (medium) — SSRF guard on saved server URLs |
| `chat_functions.makeThreadTemporary` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.pinThread` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.revokeExtension` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | ok |
| `chat_functions.searchMessages` | query | authQuery | — | thread access (owner/grant); row.userId == caller | ok |
| `chat_functions.searchThreads` | query | liteAuthQuery | — | caller-scoped (ctx.user) | ok |
| `chat_functions.softDeleteThread` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.terminateBrowserSession` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `chat_functions.testMCPServerConnection` | action | authAction + RL | — | caller-scoped (ctx.user) | **fixed** (medium) — SSRF guard (`assertSafeMcpUrl`) on the URL |
| `chat_functions.undoDeleteThread` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.unpinThread` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.updateBrowserSettings` | mutation | authMutation + RL | aiUserPreferences | caller-scoped (ctx.user) | ok |
| `chat_functions.updateThread` | action | authAction + RL | threads | thread access (owner/grant) | accepted — admin grantees may edit by design |
| `chat_functions.updateThreadDictationLanguage` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.updateThreadLanguage` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.updateThreadMode` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_functions.updateThreadOrder` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `chat_functions.updateThreadVisibility` | mutation | authMutation + RL | threads | row.userId == caller | **fixed** (low) — share token minted server-side; the caller-chosen one is gone |
| `chat_functions.validateThreadExists` | query | optionalAuthQuery | threads | row.userId == caller | ok |
| `chat_group_functions.createGroupChat` | mutation | authMutation + RL | threads | skill access | ok |
| `chat_group_functions.createGroupChatFromTemplate` | mutation | authMutation + RL | threads, skills, userSkills, skillStats, skillHistory | caller-scoped (ctx.user): template is a server-side constant; persona skills are read/created only under the caller's own `userId` (free-plan skill limit applied), then the same skill-access gate as `createGroupChat` | ok — new |
| `chat_group_functions.getGroupChat` | query | authQuery | threads | thread access (owner/grant) | ok |
| `chat_group_functions.listGroupCandidates` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_group_functions.stopGroupTurn` | mutation | authMutation + RL | threads | thread access (owner/grant) | ok |
| `chat_group_functions.updateGroupChat` | mutation | authMutation + RL | threads | skill access; row.userId == caller | ok |
| `chat_link_preview.getLinkPreview` | action | authAction + RL (on cache miss) | actionCache | no per-user data: public page metadata keyed by URL; SSRF guard (`validateDomain` per redirect hop, `fetchWithTimeout`), 5s deadline, 256 KB body cap | ok |
| `chat_local_models.saveLocalTurn` | mutation | authMutation + RL | messages, threads | caller-scoped (ctx.user) | ok |
| `chat_mcp_registry.listMcpRegistryServers` | action | authAction + RL | — | fixed public registry | ok |
| `chat_pins_functions.createPin` | mutation | authMutation + RL | threadPins, threads | caller-scoped (ctx.user) | accepted — writes only the caller's own rows |
| `chat_pins_functions.deletePin` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `chat_pins_functions.getThreadPins` | query | authQuery | threads | caller-scoped (ctx.user) | ok |
| `chat_pins_functions.updatePinNote` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `chat_pins_functions.updatePinSelectedText` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `chat_sharing.acceptThreadInvite` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | accepted — the token is a bearer link; it is no longer visible to non-admins |
| `chat_sharing.createThreadInvite` | mutation | authMutation + RL | threads | caller-scoped (ctx.user) | ok |
| `chat_sharing.getPublicThread` | action | publicAction | shardRoutes → threads (owner shard) | share token | accepted — public by design; share token + allow-list projection. An action: resolves the token's owner shard (`shardRoutes`) and reads there as the system; `readPublicThread` re-checks the token |
| `chat_sharing.getThreadAccess` | query | authQuery | threads | thread access (owner/grant); row.userId == caller | **fixed** (low) — grantee e-mails only for admins |
| `chat_sharing.getThreadInvites` | query | authQuery | threads | thread access, admin | **fixed** (high) — admin-only; read grantees / public-thread viewers could lift pending admin tokens |
| `chat_sharing.getThreadShareToken` | action | authAction | shardRoutes (`thread-share`) → threads (owner shard) | none — any signed-in caller with the thread id | accepted — returns only the share token of a LIVE PUBLIC thread, which the redacted `getThread` handed any viewer before sharding; private, deleted or temporary threads answer `null`, as does the caller's own |
| `chat_sharing.resolveThreadShard` | query | authQuery | threadAccess | caller's own grant (row.userId == caller) | ok — answers only the owner id of a grant the caller holds; nothing about other threads |
| `chat_sharing.removeThreadAccess` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `chat_sharing.revokeThreadInvite` | mutation | authMutation + RL | threadInvites | caller-scoped (ctx.user) | ok |
| `chat_sharing.toggleThreadVisibility` | mutation | authMutation + RL | threads | caller-scoped (ctx.user) | ok |
| `chat_slides_functions.createPresentation` | mutation | authMutation + RL | presentations, threads | row.userId == caller | **fixed** (low) — thread must be the caller's; rate-limited |
| `chat_slides_functions.createSlide` | mutation | authMutation + RL | presentationSlides, presentations | owner helper | **fixed** (high) — any deck was writable; owner-only + RL |
| `chat_slides_functions.deletePresentation` | mutation | authMutation + RL | presentations | owner helper | **fixed** (high) — owner-only + RL |
| `chat_slides_functions.deleteSlide` | mutation | authMutation + RL | — | owner helper | **fixed** (high) — owner-only + RL |
| `chat_slides_functions.getGeneratingPresentation` | query | authQuery | threads | row.userId == caller | **fixed** (medium) — owner-only |
| `chat_slides_functions.getPresentation` | query | authQuery | presentations | owner helper | **fixed** (medium) — owner-only |
| `chat_slides_functions.getPresentationSlides` | query | authQuery | presentations | owner helper | **fixed** (medium) — owner-only |
| `chat_slides_functions.getThreadPresentations` | query | authQuery | threads | caller-scoped (ctx.user) | ok |
| `chat_slides_functions.updateSlide` | mutation | authMutation + RL | — | owner helper | **fixed** (high) — owner-only + RL |
| `chat_streaming.getActiveStreamForThread` | query | optionalAuthQuery | threads | thread access (owner/grant/public-redacted) | **fixed** (low) — deleted/temporary public threads no longer admitted |
| `chat_streaming.getStreamBody` | query | optionalAuthQuery | persistentStreams | thread access (owner/grant/public-redacted) | **fixed** (medium) — was a bare publicQuery keyed by stream id; now thread access, reasoning redacted for public viewers |
| `chat_tags_functions.createThreadTag` | mutation | authMutation + RL | threadTags | caller-scoped (ctx.user) | ok |
| `chat_tags_functions.deleteThreadTag` | mutation | authMutation + RL | threadTags | owner helper | ok |
| `chat_tags_functions.reorderThreadTags` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | ok |
| `chat_tags_functions.setThreadTagAssigned` | mutation | authMutation + RL | threadTags, threads | owner helper; row.userId == caller | ok |
| `chat_tags_functions.updateThreadTag` | mutation | authMutation + RL | threadTags | owner helper | ok |
| `chat_tool_permissions.getToolPermissionSettings` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `chat_tool_permissions.listMcpToolPermissions` | action | authAction + RL | aiUserPreferences | caller-scoped (ctx.user) | **fixed** (medium) — SSRF guard on saved server URLs |
| `chat_tool_permissions.respondToToolApproval` | mutation | authMutation + RL | threads | thread access (owner/grant) | ok |
| `chat_tool_permissions.setToolPermission` | mutation | authMutation + RL | — | caller-scoped (ctx.user) | ok |
| `chat_translate.translateMessage` | action | authAction + RL | actionCache | caller-scoped (ctx.user); cache key includes the caller id, text comes from the caller; guests refused; a cache miss is charged to the daily text quota, output budget scaled to the text | ok |
| `coding_agents_execute.createPullRequest` | action | authAction + RL | codingAgentRuns | caller-scoped (ctx.user) | ok |
| `coding_agents_functions.cancelRun` | mutation | authMutation + RL | codingAgentRuns | row.userId == caller | ok |
| `coding_agents_functions.getLatestRunForTask` | query | authQuery | tasks | row.userId == caller | ok |
| `coding_agents_functions.getRun` | query | authQuery | codingAgentRuns | row.userId == caller | ok |
| `coding_agents_functions.getRunByToolCall` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `connectors_mcp_servers.listMcpServerSignIns` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `connectors_mcp_servers.signOutMcpServer` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `connectors_mcp_servers.startMcpServerOAuth` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `connectors_oauth.completeConnectorOAuth` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `connectors_oauth.startConnectorOAuth` | action | authAction + RL | — | state bound to ctx.user | ok |
| `connectors_user_connectors.disconnectConnector` | action | authAction + RL | userConnectors | owner helper | ok |
| `connectors_user_connectors.listConnectorCatalog` | query | authQuery | connectorDefinitions | caller-scoped (ctx.user) | ok |
| `devices_functions.claimDeviceCall` | mutation | authMutation + RL | deviceCalls, devices | row.userId == caller AND row.deviceId == arg | ok — new; claim-once, only within the 20 s claim window |
| `devices_functions.completeDeviceCall` | mutation | authMutation + RL | deviceCalls, devices | row.userId == caller; HMAC of the device's secret over the result | ok — new; a page cannot forge a result, a terminal call is never rewritten, output re-capped at 64 KiB |
| `devices_functions.getDeviceCallByToolCall` | query | authQuery | deviceCalls | caller-scoped (ctx.user) AND toolCallId | ok — new; the chat row's live status (device name, tool, status, phase) — no input, output or envelope |
| `devices_functions.heartbeatDevice` | mutation | authMutation + RL | devices | row.userId == caller | ok — new |
| `devices_functions.listDeviceCalls` | query | authQuery | deviceCalls | caller-scoped (ctx.user) | ok — new; audit list, previews capped |
| `devices_functions.listDevices` | query | authQuery | devices | caller-scoped (ctx.user) | ok — new; never returns the secret |
| `devices_functions.listPendingDeviceCalls` | query | authQuery | deviceCalls | caller-scoped (ctx.user) AND deviceId | ok — new; envelopes are signed for the device, which verifies them |
| `devices_functions.reportDeviceCallProgress` | mutation | authMutation + RL | deviceCalls, devices | row.userId == caller AND row.deviceId == arg; HMAC of the device's secret over the report (domain `progress`) | ok — new; fresh, for that call, only a CLAIMED call and only forward (none → prompting → running); display only, cannot finish a call |
| `devices_functions.registerDevice` | mutation | authMutation + RL | devices, user | caller-scoped (ctx.user); refuses guests, impersonation, deletion underway | ok — new; returns the pairing secret ONCE (see docs/plans/device-execution.md §3.2) |
| `devices_functions.releaseDeviceCall` | mutation | authMutation + RL | deviceCalls | row.userId == caller AND row.deviceId == arg | ok — new; unsigned, but only moves the caller's own CLAIMED call to failed |
| `devices_functions.renameDevice` | mutation | authMutation + RL | devices | row.userId == caller | ok — new |
| `devices_functions.revokeDevice` | mutation | authMutation + RL | devices, deviceCalls | row.userId == caller | ok — new; deletes the row and its secret, expires open calls |
| `devices_functions.updateDeviceManifest` | mutation | authMutation + RL | devices | row.userId == caller; HMAC of the device's secret over the manifest | ok — new; fresh, monotonic `issuedAt`, tools re-validated |
| `evals_functions.cancelRun` | mutation | authMutation + RL | evalRuns | owner helper | ok |
| `evals_functions.compareRuns` | query | authQuery | evalRuns | owner helper | ok |
| `evals_functions.createCase` | mutation | authMutation + RL | evalCases, evalDatasets | owner helper | ok |
| `evals_functions.createDataset` | mutation | authMutation + RL | evalDatasets | owner helper | ok |
| `evals_functions.deleteCase` | mutation | authMutation + RL | evalCases | owner helper | ok |
| `evals_functions.deleteDataset` | mutation | authMutation + RL | evalDatasets | owner helper | ok |
| `evals_functions.deleteRun` | mutation | authMutation + RL | evalRuns | owner helper | ok |
| `evals_functions.getDataset` | query | authQuery | evalDatasets | owner helper | ok |
| `evals_functions.getRun` | query | authQuery | evalRuns | owner helper | ok |
| `evals_functions.importCases` | mutation | authMutation + RL | evalCases, evalDatasets | owner helper | ok |
| `evals_functions.listDatasets` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `evals_functions.listRuns` | query | authQuery | evalDatasets | owner helper; row.userId == caller | ok |
| `evals_functions.startRun` | mutation | authMutation + RL | evalDatasets, evalRuns, knowledgeFiles, skills | owner helper | ok |
| `evals_functions.updateCase` | mutation | authMutation + RL | evalCases | owner helper | ok |
| `evals_functions.updateDataset` | mutation | authMutation + RL | evalDatasets | owner helper | ok |
| `file.getChatFileExtraction` | query | authQuery | chatFileAccess, chatFiles | caller's own `chatFileAccess` grant on the id, else `null` (same as missing); returns the extraction STATUS only, never the text | ok — new |
| `file.finalizeChatUpload` | action | authAction + RL | chatFiles, chatFileAccess (via `storeFile`) | key rebuilt under the CALLER's staging prefix from `uploadId`, else answered as expired; real size (per-kind cap), type (allowlist) and leading bytes re-checked; grant written for the caller only | ok — the bytes arrive on the TUS upload route (see HTTP routes) |
| `gdpr_functions.cancelStuckExport` | mutation | authMutation + RL | gdprAuditLog | caller-scoped (ctx.user) | ok |
| `gdpr_functions.getDataAccessSummary` | query | authQuery | gdprRequests | caller-scoped (ctx.user) | ok |
| `gdpr_functions.getDeletionStatus` | query | authQuery | gdprRequests | caller-scoped (ctx.user) | ok |
| `gdpr_functions.getExportDownloadUrl` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `gdpr_functions.getExportStatus` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `gdpr_functions.getGdprStatus` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `gdpr_functions.requestAccountDeletion` | mutation | authMutation + RL | gdprAuditLog, gdprRequests | identity (self-resolved) | ok |
| `gdpr_functions.requestDataExport` | mutation | authMutation + RL | gdprAuditLog, gdprRequests | caller-scoped (ctx.user) | ok |
| `home_overview.getHomeOverview` | query | authQuery | toolApprovalRuns, tasks, codingAgentRuns, subAgentRuns, threads, notifications, userSettings | caller-scoped (ctx.user) | ok — new; every read `where: { userId: caller }`, bounded |
| `knowledge_agent_assignment.assignToProject` | mutation | authMutation + RL | knowledgeFiles, projectKnowledge, projects | row.userId == caller | ok |
| `knowledge_agent_assignment.getProjectKnowledge` | query | authQuery | projects | row.userId == caller | ok |
| `knowledge_agent_assignment.unassignFromProject` | mutation | authMutation + RL | knowledgeFiles, projects | row.userId == caller | ok |
| `knowledge_collections.attachCollectionToProject` | mutation | authMutation + RL | knowledgeCollectionLinks, knowledgeCollections, projects | row.userId == caller (project); own or active-org collection | ok |
| `knowledge_collections.attachCollectionToThread` | mutation | authMutation + RL | knowledgeCollectionLinks, knowledgeCollections, threads | owner helper (thread); own or active-org collection | ok |
| `knowledge_collections.createCollection` | mutation | authMutation + RL | knowledgeCollections | caller-scoped (ctx.user); shares only with the ACTIVE org | ok |
| `knowledge_collections.deleteCollection` | mutation | authMutation + RL | knowledgeChunks, knowledgeCollectionLinks, knowledgeCollections, knowledgeFiles | row.userId == caller (NOT_FOUND otherwise) | ok |
| `knowledge_collections.detachCollectionFromProject` | mutation | authMutation + RL | knowledgeCollectionLinks, projects | row.userId == caller (project) | ok |
| `knowledge_collections.detachCollectionFromThread` | mutation | authMutation + RL | knowledgeCollectionLinks, threads | owner helper (thread) | ok |
| `knowledge_collections.getProjectCollections` | query | authQuery | knowledgeCollectionLinks, knowledgeCollections, projects | row.userId == caller (project) | ok |
| `knowledge_collections.getThreadCollections` | query | authQuery | knowledgeCollectionLinks, knowledgeCollections, threads | thread access (owner/grant); only the owner's links; collections filtered by RLS | ok |
| `knowledge_collections.listCollectionFiles` | action | authAction + RL | knowledgeCollections, knowledgeFiles | owner, or org membership re-checked on the owner's shard (internal `listFilesInCollection`) | ok |
| `knowledge_collections.listCollections` | query | authQuery | knowledgeCollections | caller-scoped (ctx.user); own + active org | ok |
| `knowledge_collections.setFileCollection` | mutation | authMutation + RL | knowledgeCollections, knowledgeFiles | row.userId == caller (files and target collection) | ok |
| `knowledge_collections.updateCollection` | mutation | authMutation + RL | knowledgeCollections | row.userId == caller; shares only with the ACTIVE org | ok |
| `knowledge_documents.addDocuments` | action | authAction + RL | knowledgeFiles | caller-scoped (ctx.user); own collection only; batch/size/type capped; one `knowledge/addDocument` token per document; per-user file/byte quota | ok |
| `knowledge_documents.addUrl` | mutation | authMutation + RL | knowledgeCollections, knowledgeFiles | caller-scoped (ctx.user); own collection only; SSRF guard (`isSafeUrl`, every redirect hop re-checked at ingest), body read under a deadline; per-user file quota | ok |
| `knowledge_functions.addFile` | mutation | authMutation + RL | files, knowledgeFiles | row.userId == caller; per-user file/byte quota (vault row's size) | ok |
| `knowledge_functions.attachToThread` | mutation | authMutation + RL | knowledgeFiles, threadKnowledge, threads | owner helper; row.userId == caller | **fixed** (medium) — thread must be the caller's; RL |
| `knowledge_functions.detachFromThread` | mutation | authMutation + RL | knowledgeFiles, threads | owner helper | **fixed** (medium) — had no check at all; RL |
| `knowledge_functions.getThreadKnowledge` | query | authQuery | threads | row.userId == caller | **fixed** (medium) — leaked file names/summaries of any thread |
| `knowledge_functions.listFiles` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `knowledge_functions.removeFile` | mutation | authMutation + RL | knowledgeFiles | owner helper; row.userId == caller | **fixed** (low) — rate limit (advisor: privileged fan-out) |
| `knowledge_retrieve.searchKnowledge` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `media_functions.listUserImages` | query | authQuery | files, threads | row.userId == caller | ok |
| `memory_functions.clearAllUserMemories` | mutation | authMutation + RL | embeddings_768 | caller-scoped (ctx.user) | ok |
| `memory_functions.deleteMemory` | mutation | authMutation + RL | embeddings_768 | owner helper | ok |
| `memory_functions.getMemoryStats` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `memory_functions.getMessageMemoryUsage` | query | authQuery | memories, threads | row.userId == caller | ok |
| `memory_functions.listUserMemories` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `memory_functions.setMemoryPinned` | mutation | authMutation + RL | — | owner helper | ok |
| `memory_functions.updateMemory` | mutation | authMutation + RL | — | owner helper | ok |
| `memory_reflection.dismissMemoryDigest` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `memory_reflection.getLatestMemoryDigest` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `messenger_functions.createConnection` | mutation | authMutation + RL | messengerConnections | caller-scoped (ctx.user) | **fixed** (low) — a new connection answers nobody until `/pair <code>` (code returned once, hashed at rest) |
| `messenger_functions.deleteConnection` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `messenger_functions.getConnections` | query | authQuery | messengerConnections | caller-scoped (ctx.user) | ok |
| `messenger_functions.regeneratePairingCode` | mutation | authMutation + RL | messengerConnections | row.userId == caller | ok — new; owner-only, rate-limited; code returned once, stored as SHA-256 |
| `messenger_functions.updateConnectionReplyTools` | mutation | authMutation + RL | messengerConnections | row.userId == caller | ok — new; owner-only, rate-limited; groups normalised to a fixed list (`messenger/lib/reply-tools.ts`) |
| `messenger_functions.updateConnectionStatus` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `notifications_daily_brief.setDailyBriefEnabled` | mutation | authMutation + RL | userSettings, dailyBriefState | caller-scoped (ctx.user) | ok — new |
| `notifications_functions.getNotificationInbox` | query | authQuery | notifications | caller-scoped (ctx.user) | ok — new |
| `notifications_functions.markAllNotificationsRead` | mutation | authMutation + RL | notifications | caller-scoped (ctx.user) | ok — new |
| `notifications_functions.markNotificationRead` | mutation | authMutation + RL | notifications | row.userId == caller | ok — new; another user's id is a silent no-op |
| `notifications_push.getPushConfig` | query | authQuery | lunora_push_subscriptions (D1, `ctx.push`) | caller-scoped (ctx.user) | ok — new; returns only the VAPID PUBLIC key |
| `notifications_push.getPushSubscriptionStatus` | query | authQuery | lunora_push_subscriptions (D1, `ctx.push`) | row.userId == caller | ok — new; another user's endpoint reads `false` |
| `notifications_push.subscribePush` | mutation | authMutation + RL | lunora_push_subscriptions (D1, `ctx.push`) | caller-scoped (ctx.user) | ok — new; endpoint must be https on an allow-listed push service (SSRF), 10 per user; an endpoint another user holds is refused by `ctx.push.register` (`taken`), never re-owned; `replacedEndpoint` is unregistered owner-scoped |
| `notifications_push.unsubscribePush` | mutation | authMutation + RL | lunora_push_subscriptions (D1, `ctx.push`) | row.userId == caller | ok — new; `ctx.push.unregister` is owner-scoped, another user's endpoint is a silent no-op |
| `pages_agent.proposePageEdit` | action | authAction + RL | pages | caller-scoped (ctx.user) | ok |
| `pages_comments.createPageComment` | mutation | authMutation + RL | pageComments, pages | page access | ok |
| `pages_comments.deletePageComment` | mutation | authMutation + RL | pageComments | row.userId == caller | ok |
| `pages_comments.editPageComment` | mutation | authMutation + RL | pageComments | row.userId == caller | ok |
| `pages_comments.listPageComments` | query | authQuery | pages | page access; row.userId == caller | ok |
| `pages_comments.replyToPageComment` | mutation | authMutation + RL | pageComments | caller-scoped (ctx.user) | ok |
| `pages_comments.setPageCommentStatus` | mutation | authMutation + RL | pageComments | caller-scoped (ctx.user) | ok |
| `pages_functions.createPage` | mutation | authMutation + RL | pages | page access; owner helper | ok |
| `pages_functions.createPageFromDocument` | mutation | authMutation + RL | documents, pages | row.userId == caller | ok |
| `pages_functions.deletePage` | mutation | authMutation + RL | pages | page access; owner helper | ok |
| `pages_functions.getPage` | query | authQuery | pages | page access; row.userId == caller | ok |
| `pages_functions.getPageVersion` | query | authQuery | pageVersions | page access | ok |
| `pages_functions.listPageTree` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `pages_functions.listPageVersions` | query | authQuery | pages | page access; row.userId == caller | ok |
| `pages_functions.movePage` | mutation | authMutation + RL | pages | page access; owner helper | ok |
| `pages_functions.renamePage` | mutation | authMutation + RL | pages | page access | ok |
| `pages_functions.restorePageVersion` | mutation | authMutation + RL | pageVersions | page access | ok |
| `pages_functions.savePageContent` | mutation | authMutation + RL | pages | page access | ok |
| `pages_functions.searchPages` | query | authQuery | pages | caller-scoped (ctx.user) | ok |
| `pages_functions.setPageFavorite` | mutation | authMutation + RL | pageFavorites, pages | page access | ok |
| `pages_presence.heartbeatPagePresence` | mutation | authMutation + RL | pagePresence, pages | page access; row.userId == caller | ok |
| `pages_presence.leavePagePresence` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `pages_presence.listPagePresence` | query | authQuery | pages | page access; row.userId == caller | ok |
| `pages_sharing.acceptPageInvite` | action | authAction + RL | pageInvites → pageAccess, pages (owner shard) | page access; row.userId == caller | **fixed** (low) — the inviter must still hold admin on the page. An action: the invitee's call redeems on the owner's shard (`redeemPageInvite`, re-checks the token) |
| `pages_sharing.createPageInvite` | mutation | authMutation + RL | pageInvites, pages | page access | ok |
| `pages_sharing.getPageSharing` | query | authQuery | pages | page access | accepted — page admins see grantee e-mails by design |
| `pages_sharing.getPublicPage` | action | publicAction | shardRoutes → pages (owner shard) | share token | accepted — public by design; share token + allow-list projection. An action: see `chat_sharing.getPublicThread` |
| `pages_sharing.resolvePageShard` | query | authQuery | pageAccess | caller's own grant (row.userId == caller) | ok — answers only the owner id of a grant the caller holds |
| `pages_sharing.removePageGrant` | mutation | authMutation + RL | pages | page access | ok |
| `pages_sharing.revokePageInvite` | mutation | authMutation + RL | pageInvites | page access | ok |
| `pages_sharing.setPagePublic` | mutation | authMutation + RL | pages | page access | ok |
| `pages_sharing.updatePageGrant` | mutation | authMutation + RL | pages | page access | ok |
| `projects_functions.createProject` | mutation | authMutation + RL | — | org membership/role | **fixed** (medium) — organizationId must be the active org |
| `projects_functions.deleteProject` | mutation | authMutation + RL | projects | row.userId == caller | **fixed** (low) — move target must be the caller's project |
| `projects_functions.getProject` | query | authQuery | projects | org membership/role; row.userId == caller | ok |
| `projects_functions.listPinnedProjects` | query | authQuery | — | caller-scoped (ctx.user) | **fixed** (high) — via `agent_projects.listPinnedProjects` |
| `projects_functions.listProjects` | query | authQuery | — | caller-scoped (ctx.user) | **fixed** (high) — via `agent_projects.listProjects` |
| `projects_functions.listThreadsByProject` | query | authQuery | projects | row.userId == caller | ok |
| `projects_functions.moveThreadToProject` | mutation | authMutation + RL | projects, threads | row.userId == caller | ok |
| `projects_functions.pinProject` | mutation | authMutation + RL | projects | row.userId == caller | ok |
| `projects_functions.unpinProject` | mutation | authMutation + RL | projects | row.userId == caller | ok |
| `projects_functions.updateProject` | mutation | authMutation + RL | projects | org membership/role; row.userId == caller | **fixed** (medium) — patch.organizationId must be the active org |
| `projects_functions.updateProjectOrder` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `prompts_functions.applyThreadVariablesToPrompt` | query | authQuery | prompts, threads | row.userId == caller | **fixed** (medium) — only the caller's own variables row |
| `prompts_functions.createPrompt` | mutation | authMutation + RL | promptHistory, prompts | org membership/role | **fixed** (medium) — organizationId must be the active org; quota via `assertPromptQuota` |
| `prompts_functions.deletePrompt` | mutation | authMutation + RL | prompts | row.userId == caller | ok |
| `prompts_functions.deleteThreadVariable` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `prompts_functions.duplicatePrompt` | mutation | authMutation + RL | promptHistory, prompts | owner helper; row.userId == caller | **fixed** (low) — counts against FREE_PROMPT_LIMIT |
| `prompts_functions.getPrompt` | query | authQuery | prompts | row.userId == caller | ok |
| `prompts_functions.getPromptCount` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `prompts_functions.getPromptHistory` | query | authQuery | prompts | row.userId == caller | ok |
| `prompts_functions.getPrompts` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `prompts_functions.getPromptTags` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `prompts_functions.getResolvedVariables` | query | authQuery | threads | row.userId == caller | **fixed** (medium) — only the caller's own variables row |
| `prompts_functions.getThreadVariables` | query | authQuery | threads | row.userId == caller | ok |
| `prompts_functions.getUserVariableDefaults` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `prompts_functions.recordPromptUsage` | mutation | authMutation + RL | prompts | row.userId == caller | ok |
| `prompts_functions.restorePromptVersion` | mutation | authMutation + RL | promptHistory, prompts | row.userId == caller | ok |
| `prompts_functions.searchPrompts` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `prompts_functions.setOrganizationVariableDefaults` | mutation | authMutation + RL | userVariableDefaults | caller-scoped (ctx.user) | ok |
| `prompts_functions.setThreadVariables` | mutation | authMutation + RL | threadVariables, threads | owner helper; row.userId == caller | **fixed** (medium) — thread must be the caller's before a row is created |
| `prompts_functions.setUserVariableDefaults` | mutation | authMutation + RL | userVariableDefaults | caller-scoped (ctx.user) | ok |
| `prompts_functions.togglePromptFavorite` | mutation | authMutation + RL | prompts | row.userId == caller | ok |
| `prompts_functions.updatePrompt` | mutation | authMutation + RL | promptHistory, prompts | row.userId == caller | ok |
| `prompts_functions.updateThreadVariable` | mutation | authMutation + RL | threadVariables, threads | owner helper; row.userId == caller | **fixed** (medium) — thread must be the caller's before a row is created |
| `saas_notification_functions.listNotifications` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `saas_notification_functions.markNotificationsRead` | mutation | authMutation | — | caller-scoped (ctx.user) | ok |
| `saas_usage_functions.createMyNotificationRule` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `saas_usage_functions.deleteMyNotificationRule` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `saas_usage_functions.getMyUsage` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `saas_usage_functions.listMyNotificationRules` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `skills_builder.attachSkillTestDrive` | mutation | authMutation + RL | threads | row.userId == caller | ok |
| `skills_builder.refineBuilderDraft` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `skills_builder.runBuilderTurn` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `skills_functions.createSkill` | mutation | authMutation + RL | skillHistory, skillStats, skills, userSkills | caller-scoped (ctx.user) | ok |
| `skills_functions.deleteSkill` | mutation | authMutation + RL | skillStats, skills | skill access | ok |
| `skills_functions.getAvailableSkillTools` | query | authQuery | — | static registry | ok |
| `skills_functions.getEnabledSkillsMetadata` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `skills_functions.getSkill` | query | authQuery | skillStats, skills | skill access | **fixed** (low) — non-owners get no owner id, org id or source; `isOwner` discriminates |
| `skills_functions.getSkillCount` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `skills_functions.getSkills` | action | authAction | — | caller-scoped (ctx.user) | ok |
| `skills_functions.recordSkillInvocation` | mutation | authMutation + RL | skillInvocations, skillStats, skills, threads | skill access | ok |
| `skills_functions.setSkillAutoRun` | mutation | authMutation + RL | skills, userSkills | skill access | ok |
| `skills_functions.setSkillEnabled` | mutation | authMutation + RL | skills, userSkills | skill access | ok |
| `skills_functions.updateSkill` | mutation | authMutation + RL | skillHistory, skills | skill access; row.userId == caller | ok |
| `skills_generate.generateSkillDraft` | action | authAction + RL | — | caller-scoped (ctx.user) | ok |
| `skills_io.exportSkill` | action | authAction + RL | skillFiles, skills | skill access (`getSkill` decides) | ok |
| `skills_io.importSkill` | action | authAction + RL | skillFiles, skills | caller-scoped (ctx.user); created through `createSkill`; parsed and size-capped server-side | ok |
| `skills_marketplace.browseSkills` | query | authQuery | skillStats, skills | public skills only, projected | ok |
| `skills_marketplace.forkSkill` | mutation | authMutation + RL | skillHistory, skillStats, skills, userSkills | skill access | ok |
| `skills_marketplace.getSkillDetail` | query | authQuery | skillRatings, skillStats, skills | skill access | ok |
| `skills_marketplace.installSkill` | mutation | authMutation + RL | skills, userSkills | skill access | ok |
| `skills_marketplace.rateSkill` | mutation | authMutation + RL | skillRatings, skillStats, skills | skill access | ok |
| `skills_marketplace.searchSkills` | query | authQuery | — | public skills only, projected | ok |
| `skills_marketplace.uninstallSkill` | mutation | authMutation + RL | skills | caller-scoped (ctx.user) | ok |
| `sub_agents_functions.getRunByToolCall` | query | authQuery | subAgentRuns | caller-scoped (ctx.user) — index `by_user_and_toolCallId` pinned to the caller | ok |
| `system_prompts_functions.createPreset` | mutation | authMutation | systemPromptPresets | caller-scoped (ctx.user) | accepted — own rows; no rate limit |
| `system_prompts_functions.deletePreset` | mutation | authMutation | — | row.userId == caller | accepted — own rows; no rate limit |
| `system_prompts_functions.listPresets` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `system_prompts_functions.updatePreset` | mutation | authMutation | — | row.userId == caller | accepted — own rows; no rate limit |
| `tasks_functions.cancelTask` | mutation | authMutation + RL | tasks | owner helper | ok |
| `tasks_functions.createGoal` | mutation | authMutation + RL | goals | caller-scoped (ctx.user) | ok |
| `tasks_functions.createTask` | mutation | authMutation + RL | goals, skills, tasks | caller-scoped (ctx.user) | ok |
| `tasks_functions.deleteGoal` | mutation | authMutation + RL | goals | owner helper | ok |
| `tasks_functions.deleteTask` | mutation | authMutation + RL | tasks | owner helper | ok |
| `tasks_functions.getTaskBoard` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `tasks_functions.getTaskRuns` | query | authQuery | tasks | owner helper | ok |
| `tasks_functions.listTaskSkillOptions` | query | authQuery | — | skill access | ok |
| `tasks_functions.reviewTask` | mutation | authMutation + RL | tasks | owner helper | ok |
| `tasks_functions.runTask` | mutation | authMutation + RL | tasks | owner helper | ok |
| `tasks_functions.updateGoal` | mutation | authMutation + RL | goals | owner helper | ok |
| `tasks_functions.updateTask` | mutation | authMutation + RL | goals, skills, tasks | owner helper | ok |
| `triggers_functions.createTrigger` | mutation | authMutation + RL | triggers | caller-scoped (ctx.user) | ok |
| `triggers_functions.deleteTrigger` | mutation | authMutation + RL | triggers | row.userId == caller | ok |
| `triggers_functions.getTriggerExecutions` | query | authQuery | triggers | row.userId == caller | ok |
| `triggers_functions.getTriggers` | query | authQuery | — | caller-scoped (ctx.user) | ok |
| `triggers_functions.setTriggerEnabled` | mutation | authMutation + RL | triggers | row.userId == caller | ok |
| `triggers_functions.testRunTrigger` | action | authAction + RL | triggers | row.userId == caller | ok |
| `triggers_functions.updateTrigger` | mutation | authMutation + RL | triggers | row.userId == caller | ok |
| `usage_activity.getActivityHeatmap` | query | authQuery | usageDaily | caller-scoped (ctx.user) | ok — new; at most 378 rows via `(userId, skillKey, date)` |
| `usage_activity.getSkillBreakdown` | query | authQuery | usageDaily | caller-scoped (ctx.user) | ok — new; at most 4000 rows via `(userId, date)` |
| `usage_backfill.getUsageBackfillStatus` | query | authQuery | usageBackfill | caller-scoped (ctx.user) | ok — new; one row via `by_userId` |
| `usage_backfill.startUsageBackfill` | mutation | authMutation | usageBackfill | caller-scoped (ctx.user); no args | ok — new; idempotent — schedules at most one step chain per 5-minute lease, the walk reads only the caller's own shard |
| `vault_functions.deleteAttachments` | mutation | authMutation + RL | — | row.userId == caller | **fixed** (medium) — uploader-only; org members could delete each other's files |
| `vault_functions.findAttachmentByKey` | query | authQuery | — | file access | **fixed** (medium) — owner or a grant on the file's chat |
| `vault_functions.getAttachment` | query | authQuery | files | file access | **fixed** (medium) — owner or a grant on the file's chat; org membership grants nothing |
| `vault_functions.getAttachmentsForChat` | query | authQuery | — | thread access (owner/grant) | ok |
| `vault_functions.getAttachmentsForOrganization` | query | authQuery | — | row.userId == caller | **fixed** (medium) — the caller's own uploads in the active org only |
| `vault_functions.getAttachmentsForUser` | query | authQuery | — | caller-scoped (ctx.user) | **fixed** (medium) — the caller's own uploads only (merged in other members' org files) |
| `vault_functions.getDownloadUrl` | action | authAction | files | file access (owner or org) | **fixed** (medium) — via `getAttachment`: owner or chat grant |
| `vault_functions.getStorageUrl` | query | authQuery | — | file access | **fixed** (medium) — owner or a grant on the file's chat |
| `vault_functions.saveGeneratedImage` | action | authAction + RL | — | caller-scoped (ctx.user) | **fixed** (low) — MIME allow-list and size cap enforced |
| `vault_functions.saveVaultFile` | action | authAction + RL | files (via `insertVaultFile`) | org membership/role; key rebuilt under the CALLER's staging prefix from `uploadId`; real size (5 MB), type and leading bytes checked before the object moves to a server-minted key | **fixed** (low-medium) — organizationId must be the active org; size/type were client-declared and now come from the stored bytes |
| `vault_functions.syncMetadata` | action | authAction | — | caller-scoped (ctx.user) | **fixed** (low) — patches only the caller's row |
| `voice_functions.authorizeScribeToken` | mutation | authMutation + RL | user | caller-scoped (ctx.user) | ok |
| `voice_speech.synthesizeSpeech` | action | authAction + RL | — (rate limits, gateway) | caller-scoped (ctx.user); no id in args, nothing persisted; guests refused; text capped per call, charged by length to `voice/dailySpeechChars` before the gateway call, and the gateway deducts the per-character cost from the caller's credits (BYOK FAL key → `byok`) | ok |
| `workflow_executor.executeWorkflow` | action | authAction + RL | projects | caller-scoped (ctx.user) | ok |
| `workflow_functions.createExecution` | mutation | authMutation + RL | projects | row.userId == caller | ok |
| `workflow_functions.createNodeExecution` | mutation | authMutation + RL | workflowExecutions | row.userId == caller | ok |
| `workflow_functions.createWorkflow` | mutation | authMutation + RL | — | org membership/role | **fixed** (medium) — organizationId must be the active org |
| `workflow_functions.getExecution` | query | authQuery | workflowExecutions | row.userId == caller | ok |
| `workflow_functions.getWorkflow` | query | authQuery | projects | row.userId == caller | ok |
| `workflow_functions.listExecutions` | query | authQuery | projects | row.userId == caller | ok |
| `workflow_functions.listNodeExecutions` | query | authQuery | workflowExecutions | row.userId == caller | ok |
| `workflow_functions.listWorkflows` | query | authQuery | — | caller-scoped (ctx.user) | **fixed** (high) — via `agent_projects.listProjects` |
| `workflow_functions.updateExecutionStatus` | mutation | authMutation + RL | workflowExecutions | row.userId == caller | ok |
| `workflow_functions.updateNodeExecution` | mutation | authMutation + RL | — | row.userId == caller | ok |
| `workflow_functions.updateWorkflowContent` | mutation | authMutation + RL | projects | row.userId == caller | ok |
| `workflow_gallery.browseGallery` | query | publicQuery | projects | none (public rows) | **fixed** (low) — explicit projection without owner id; page size clamped to 50 |
| `workflow_fork.forkWorkflow` | action | authAction + RL | projects, files (author shard) → files, projects (caller shard) | row.userId == caller | ok — reads only the author's vault rows the public graph names, on the author's shard |
| `workflow_gallery.getFeaturedWorkflows` | query | publicQuery | projects | none (public rows) | **fixed** (low) — explicit projection without owner id |
| `workflow_gallery.getPublicWorkflow` | action | publicAction | projects → files (author shard) | share token | **fixed** (low) — explicit projection without owner id or fork lineage. An action: signs on the author's shard |
| `workflow_gallery.publishWorkflow` | mutation | authMutation + RL | projects | row.userId == caller | ok |
| `workflow_gallery.unpublishWorkflow` | mutation | authMutation + RL | projects | row.userId == caller | ok |
| `workflow_gallery.updateGalleryMeta` | mutation | authMutation + RL | projects | row.userId == caller | ok |
| `workflow_generate.generateWorkflowFromPrompt` | action | authAction + RL | — | caller-scoped (ctx.user) | accepted — rate-limited; platform-paid |
| `workflow_presence.checkNodeLock` | query | authQuery | projects | workflow owner; row.userId == caller | ok |
| `workflow_presence.disconnect` | mutation | authMutation | — | row.userId == caller | ok |
| `workflow_presence.heartbeat` | mutation | authMutation | projects, workflowPresence | workflow owner; row.userId == caller | accepted — no rate limit; own rows only |
| `workflow_presence.listPresence` | query | authQuery | projects | workflow owner | ok |
| `workflow_presence.listVersions` | query | authQuery | projects | workflow owner | ok |
| `workflow_presence.restoreVersion` | query | authQuery | — | workflow owner | ok |
| `workflow_presence.saveVersion` | mutation | authMutation | projects, workflowVersions | workflow owner | accepted — no rate limit; `v.any()` content into the caller's own workflow |

## Removed from the client surface in this audit

| procedure | was | now | why |
| --- | --- | --- | --- |
| `agent_vector.paginate` | bare `query` | `internalQuery` | paged EVERY user's embedding ids with no identity check at all; unbounded `limit` on the root shard; no caller |
| `agent_api_keys.validate` | bare `query` | `internalQuery` | an existence oracle over playground key ids (the id is the credential); no caller |

## HTTP routes

Identity for every route but `/api/v1/*` is resolved in `backend/src/server.ts`
(`resolveIdentity`: bearer JWT verified against our JWKS with `iss`/`aud` pinned,
else the better-auth cookie). No route takes identity from a header.

| route | auth | ownership check | status |
| --- | --- | --- | --- |
| `POST /chat/start` | gateway HMAC + forwarded JWT | thread write access; regenerate owner; `fileIds` via `getFile(userId)` | **fixed** (high) — `getCurrentUserInternal` never read `isAnonymous`/`role` from the user row, so guests ran any (paid) model on the free-tier quota and admins never got their exemption |
| `POST /chat/media` | JWT / cookie | `message.userId === caller` | **fixed** (high) — no quota at all: guests refused, `numImages` clamped to 4, each call charged to `chat/daily{Image,Video,Audio}` (`/chat/start` no longer pre-charges media prompts) |
| `POST /chat/edit` | JWT / cookie | thread owner; `getFile(userId, threadId)` | **fixed** (medium) — every edit regenerates; now charged to `chat/dailyText` |
| `POST /chat/improve-prompt`, `/chat/optimize-system-prompt`, `/chat/iterate-prompt` | JWT / cookie | `runOptimizer` checks thread read access | **fixed** (high) — a body `threadId` loaded a stranger's recent messages into the prompt whose rewrite came back to the caller |
| `POST /prompts/optimize` | JWT / cookie, resolved on the route | no ids | **fixed** (functional) — the internal action read `identity.subject`, which `resolveIdentity` never sets, so every caller got "unauthorized"; the route now resolves the caller and passes `userId` |
| `POST /workflow/stream` | JWT / cookie | `getWorkflow` owner check | **fixed** (low) — rate-limited with `workflow/execute`, the budget `executeWorkflow` already had |
| `POST /mcp/resource`, `/mcp/tool` | JWT / cookie | server looked up by caller; tool permission modes | ok |
| `POST /chat/chunks`, `/gateway/usage-report` | gateway HMAC, constant-time, 30 s window | stream id vouched for by the gateway's stream token | ok |
| `POST /email/resend/webhook` | Svix HMAC, 5 min window | — | ok |
| `POST /messenger/{telegram,slack,discord}/:id` | platform signature | pairing gate (`messenger/pairing.ts`); event dedupe | **fixed** (low) — the first sender to reach a bot claimed it. Now only the contact who sent `/pair <code>` (one-time, 15 min, SHA-256 at rest, 5 guesses / 15 min per connection) is answered; strangers get one "this bot is private" reply per hour. Discord's signed timestamp is now checked (±5 min) and all three dedupe by event id |
| `/messenger/{whatsapp,line,feishu,teams,wechat}/:id` | platform signature / JWT | pairing gate via `acceptInbound`; dedupe | **fixed** (low) — same pairing gate, applied after the dedupe claim |
| `POST /triggers/webhook/:triggerId` | per-trigger HMAC over `<timestamp>.<body>`, constant-time | trigger → owner | **fixed** (low) — `X-Neore-Timestamp` must be within ±5 min and is signed with the body; each signature is accepted once (`triggerWebhookDeliveries`, 15 min); 60 deliveries/min per trigger; unsigned requests (legacy rows without a secret) are refused. Breaking for senders: documented in the trigger settings UI |
| `/extension/auth/*` | JWT / PKCE code / session token | own user | ok |
| `/api/v1/*` | API key (`verifyApiKey`) + scope | shared procedure checks; stream token userId must equal the key's | ok |
| `GET /*` (signed downloads) | Worker-signed URL (method, key, origin, expiry) | key from the signature | ok — the signed `PUT` upload path is gone |
| `POST`/`PATCH`/`HEAD`/`DELETE /uploads[/:id]` (TUS) | JWT / cookie (never a URL token) | object key `uploads/<callerId>/<generatedId>` from the resolved identity; upload state under `upload-state/<callerId>/`, so another caller's id is a 404; declared size capped per declared type, MIME allowlist, `uploads/create` rate limit; write-only (`GET` 405) | ok — new (`lib/upload-route.ts`) |
| `/api/v1/uploads[/:id]` (TUS) | API key + `knowledge:write` | same as `/uploads`, plus the key's `publicApi/write` limit per create | ok — new; replaces the presigned `POST /knowledge/uploads` |
| `/api/auth/*` | better-auth | better-auth | ok |

## Also fixed while auditing

- **Expired temporary chats were never deleted.** The `deleteExpiredTemporaryChats`
  cron read expirations through the CLIENT query
  `agent_threads.getTemporaryThreadsByThreadIds`, which answers only for its
  caller — and a cron has none. It now reads `getExpiredTemporaryThreadIds` and
  removes each `temporaryThreads` marker with its thread.
- **Session org context without a membership.** `getCurrentUserInternal` (HTTP
  routes) and `getActiveOrganizationQuery` defaulted a missing `member` row to
  role `"member"`; a session that outlived its membership kept org context. Both
  now return no organization, as `resolveActiveMembership` does for cRPC.
- **SSRF on MCP servers.** User-supplied MCP URLs were dialled from the Worker
  unvalidated, with the error text returned; every connect now goes through
  `assertSafeMcpUrl` (`validateDomain`).

## Round two (2026-09-23): the open items, closed

- **Messenger pairing** replaced first-sender-claims-the-bot (see the HTTP table).
  `createConnection` returns the code once; `regeneratePairingCode` issues a new
  one and unpairs the current contact. Settings → Messengers shows the pairing
  state and the code.
- **Trigger webhooks** are timestamped, replay-deduped and rate-limited. Senders
  must sign `<X-Neore-Timestamp>.<raw body>`; the trigger settings UI documents it.
- **Vault** follows the thread rule: a file is its owner's, readable by others only
  through a grant on its chat. Organization membership grants nothing.
- **Public projections**: `agent_projects.getProject` is owner-only, the three
  gallery reads carry no owner id / org id / context / fork lineage, and
  `skills_functions.getSkill` strips owner, org and source for non-owners.
- **Billing tier** (`baseTier`, `creditsPerUser`, member credit overrides) is a
  platform-admin operation (`setOrganizationBillingTier`, `setMemberCreditOverride`),
  and `baseTier` is otherwise set only by the verified Creem webhook
  (`billing/webhook.ts` → `auth_billing.applyCreemSubscription`). Pro is a
  per-user plan (`user.baseTier`, bought by that user for themselves); Team is
  the org's (`organization.baseTier`, started by an owner or admin). Paying is
  what changes a tier. The org owner keeps contact e-mail and models.
  Team seats follow membership with no client entry point: every member change
  queues the internal `billing_seats.syncTeamSeats` (on `__root__`), which sets
  the Creem units to the org's current member count. Deleting an organization
  queues the internal `billing_gdpr.cancelBilling`, which cancels its Team at
  Creem immediately and clears its payment-store rows.

## Codegen advisor, security rules (2026-09-23)

- `owner_field_from_args_not_auth` — 10, all on `internal*` procedures (trusted
  callers pass the subject). None on a public procedure.
- `public_arg_uses_any` — 8: `agent_documents.updateDocument` (`commit`,
  `contentJson`), `pages_comments.createPageComment`, `pages_functions.savePageContent`,
  `skills_functions.recordSkillInvocation`, `workflow_functions.createNodeExecution`,
  `updateNodeExecution`, `workflow_presence.saveVersion`. All owner-checked; the
  `any` only reaches the caller's own rows. Accepted.
- `privileged_fanout_from_public_procedure` — 2: `changelog_functions.getChangelogs`
  (accepted: cached, module cooldown) and `knowledge_functions.removeFile` (fixed:
  rate-limited).
- `ai_unbounded_generation_public` — 1: `chat_functions.continueThread`
  (accepted: rate-limited; no `maxOutputTokens`).
