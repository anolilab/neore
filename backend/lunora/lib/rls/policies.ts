/**
 * Row-level security policies — defence in depth UNDER each procedure's own
 * authorization check, never instead of it (`docs/security/authz-matrix.md`).
 *
 * Applied by every client-reachable builder in `lib/crpc.ts`
 * (`.use(withRlsScope(...)).use(rls(POLICIES))`). Internal functions, the
 * scheduler, the jobs queue, crons and workflows are built without it: they are
 * system code and see every row.
 *
 * The contract a policy expresses is "is this caller connected to this row at
 * all" — owner, or a thread/page/org the request proved it may reach
 * (`./scope.ts`). WHICH permission a grant carries (read vs. write vs. admin,
 * comment vs. edit) stays the procedure's job; RLS refuses the stranger.
 *
 * Three rules of the middleware shape every entry below:
 *
 * - A table with ANY policy denies every write operation it has no policy for,
 *   so each table declares all four (`read`, `insert`, `update`, `delete`).
 * - `update` is checked against the row before AND after the patch: a patch
 *   cannot move a row to another owner.
 * - Tables not listed are unrestricted (the schema is not `.rls("required")`).
 *   Each one is in {@link UNPOLICED_TABLES} with the reason.
 */
import { definePolicies, definePolicy, rls } from "lunorash/server";
import type { Middleware, Policy } from "lunorash/server";

import type { RlsScope } from "./scope";
import { isOrganizationAdmin, pageLevelAtLeast, threadLevelAtLeast } from "./scope";

interface PolicyCtx {
    rlsScope?: RlsScope;
}

type Row = Record<string, unknown> | undefined;
type Decision = boolean | Record<string, unknown>;

/** No scope means the middleware chain is misassembled — fail closed. */
const scopeFrom = (ctx: PolicyCtx): RlsScope | null => ctx.rlsScope ?? null;

interface TableRules {
    delete: (scope: RlsScope, row: Record<string, unknown>) => boolean;
    insert: (scope: RlsScope, row: Record<string, unknown>) => boolean;
    /** Read predicate for a signed-in caller (`userId` never null here). */
    read: (scope: RlsScope, userId: string) => Decision;
    /** Anonymous read (public share views); deny when omitted. */
    readAnonymous?: (scope: RlsScope) => Decision;
    update: (scope: RlsScope, row: Record<string, unknown>) => boolean;
}

const policiesFor = (table: string, rules: TableRules): Policy<PolicyCtx>[] => {
    const write =
        (check: (scope: RlsScope, row: Record<string, unknown>) => boolean) =>
        ({ ctx, row }: { ctx: PolicyCtx; row?: Row }): boolean => {
            const scope = scopeFrom(ctx);

            if (!scope) {
                return false;
            }

            if (scope.admin) {
                return true;
            }

            return row !== undefined && check(scope, row);
        };

    return [
        definePolicy<PolicyCtx>({
            on: "read",
            table,
            when: ({ ctx }) => {
                const scope = scopeFrom(ctx);

                if (!scope) {
                    return false;
                }

                if (scope.admin) {
                    return true;
                }

                if (scope.userId === null) {
                    return rules.readAnonymous ? rules.readAnonymous(scope) : false;
                }

                return rules.read(scope, scope.userId);
            },
        }),
        definePolicy<PolicyCtx>({ on: "insert", table, when: write(rules.insert) }),
        definePolicy<PolicyCtx>({ on: "update", table, when: write(rules.update) }),
        definePolicy<PolicyCtx>({ on: "delete", table, when: write(rules.delete) }),
    ];
};

const ownsRow = (scope: RlsScope, row: Record<string, unknown>, column = "userId"): boolean => scope.userId !== null && row[column] === scope.userId;

// ─── Rule families ───────────────────────────────────────────────────────────

/** The caller's own rows, nothing else. */
const owner = (column = "userId"): TableRules => {
    return {
        delete: (scope, row) => ownsRow(scope, row, column),
        insert: (scope, row) => ownsRow(scope, row, column),
        read: (_scope, userId) => {
            return { [column]: userId };
        },
        update: (scope, row) => ownsRow(scope, row, column),
    };
};

/**
 * Rows hung off a thread: the caller's own, or any row of a thread an access
 * helper admitted. `userId` on these tables is whoever started the run — a
 * write grantee's reply sits in the owner's thread with the grantee's id — so
 * the thread, not the column, is what connects a reader to the row.
 */
const threadScoped = (options: { hasUserId: boolean }): TableRules => {
    const connected = (scope: RlsScope, row: Record<string, unknown>) =>
        (options.hasUserId && ownsRow(scope, row)) || threadLevelAtLeast(scope, row.threadId, "write");

    return {
        delete: connected,
        insert: connected,
        read: (scope, userId) => (options.hasUserId ? { OR: [{ userId }, { threadId: { in: scope.threads.any } }] } : { threadId: { in: scope.threads.any } }),
        readAnonymous: (scope) => {
            return { threadId: { in: scope.threads.any } };
        },
        update: connected,
    };
};

/**
 * Rows hung off a page. `userId` is the AUTHOR (comments, versions), the
 * session user (presence) or the user who starred it (favorites); a page member
 * reads everyone's, and the page's owner/admins manage them (`deletePage`,
 * `writeContent` re-anchoring other authors' comments, stale presence).
 */
const pageScoped: TableRules = {
    delete: (scope, row) => ownsRow(scope, row) || pageLevelAtLeast(scope, row.pageId, "read"),
    insert: (scope, row) => ownsRow(scope, row),
    read: (scope, userId) => {
        return { OR: [{ userId }, { pageId: { in: scope.pages.member } }] };
    },
    update: (scope, row) => ownsRow(scope, row) || pageLevelAtLeast(scope, row.pageId, "read"),
};

/** Org-shared rows: the caller's own, or any row of an organization the caller is a proven member of. */
const orgShared = (options: { orgAdminWrites: boolean }): TableRules => {
    const writable = (scope: RlsScope, row: Record<string, unknown>) =>
        ownsRow(scope, row) ||
        (options.orgAdminWrites
            ? isOrganizationAdmin(scope, row.organizationId)
            : typeof row.organizationId === "string" && scope.organizations.includes(row.organizationId));

    return {
        delete: writable,
        insert: (scope, row) => ownsRow(scope, row),
        read: (scope, userId) => {
            return { OR: [{ userId }, { organizationId: { in: scope.organizations } }] };
        },
        update: writable,
    };
};

// ─── Tables ──────────────────────────────────────────────────────────────────

/** Every row keyed to one user by `userId`, with no sharing a client procedure uses. */
const OWNER_TABLES = [
    "account",
    "aiUserPreferences",
    "browserExtensions",
    "browserSessions",
    "chatImportJobs",
    "codingAgentRuns",
    "dailyBriefState",
    "deviceCalls",
    "devices",
    "documentVersions",
    "embeddings_1024",
    "embeddings_128",
    "embeddings_1408",
    "embeddings_1536",
    "embeddings_2048",
    "embeddings_256",
    "embeddings_3072",
    "embeddings_4096",
    "embeddings_512",
    "embeddings_768",
    "evalCases",
    "evalDatasets",
    "evalResults",
    "evalRuns",
    "folders",
    "gatewayNotifications",
    "gatewayUsageDeductions",
    "gdprAuditLog",
    "gdprConsent",
    "gdprRequests",
    "goals",
    "knowledgeChunks",
    "knowledgeCollectionLinks",
    "mcpServerGrants",
    "memories",
    "memoryDigests",
    "memoryReflectionState",
    "messengerConnections",
    "notifications",
    "oauthStates",
    "passkey",
    "presentations",
    "sandboxSessions",
    "session",
    "skillInvocations",
    "subAgentRuns",
    "systemPromptPresets",
    "taskRuns",
    "tasks",
    "temporaryThreads",
    "threadPins",
    "threadRelationships",
    "threadTags",
    "threadVariables",
    "toolApprovalRuns",
    "triggers",
    "twoFactor",
    "usageBackfill",
    "usageDaily",
    "usageReplies",
    "userConnectors",
    "userSettings",
    "userSkills",
    "workflowExecutions",
    "workflowPresence",
    "workflowVersions",
] as const;

const RULES: Record<string, TableRules> = {
    ...Object.fromEntries(OWNER_TABLES.map((table) => [table, owner()])),

    // Grants on content-addressed `chatFiles`. Reading one says only "user U may
    // attach file F"; ownership checks read other users' grants (the author of a
    // shared message), so reads stay open. Writes are the caller's own grants.
    chatFileAccess: {
        delete: (scope, row) => ownsRow(scope, row),
        insert: (scope, row) => ownsRow(scope, row),
        read: () => true,
        update: (scope, row) => ownsRow(scope, row),
    },
    documents: threadScoped({ hasUserId: true }),
    // ── Files ──
    // A vault file is its uploader's; a full grant on its chat reads it too.
    files: {
        delete: (scope, row) => ownsRow(scope, row),
        insert: (scope, row) => ownsRow(scope, row),
        read: (scope, userId) => {
            return { OR: [{ userId }, { chatId: { in: scope.threads.full } }] };
        },
        update: (scope, row) => ownsRow(scope, row),
    },
    followupSuggestions: threadScoped({ hasUserId: false }),
    // ── Knowledge ──
    // Owner, or a member of the organization it is shared with (`organizationId`
    // is set only while shared); only the owner writes.
    knowledgeCollections: {
        delete: (scope, row) => ownsRow(scope, row),
        insert: (scope, row) => ownsRow(scope, row),
        read: (scope, userId) => {
            return { OR: [{ userId }, { organizationId: { in: scope.organizations } }] };
        },
        update: (scope, row) => ownsRow(scope, row),
    },
    knowledgeFiles: {
        delete: (scope, row) => ownsRow(scope, row),
        insert: (scope, row) => ownsRow(scope, row),
        read: (scope, userId) => {
            return { OR: [{ userId }, { _id: { in: scope.knowledgeFiles } }] };
        },
        update: (scope, row) => ownsRow(scope, row),
    },
    messages: threadScoped({ hasUserId: true }),
    // `userId` is the GRANTEE, `ownerId` the page owner.
    pageAccess: {
        delete: (scope, row) => ownsRow(scope, row) || pageLevelAtLeast(scope, row.pageId, "admin"),
        insert: (scope, row) => ownsRow(scope, row) || pageLevelAtLeast(scope, row.pageId, "admin"),
        read: (scope, userId) => {
            return { OR: [{ userId }, { pageId: { in: scope.pages.admin } }] };
        },
        update: (scope, row) => pageLevelAtLeast(scope, row.pageId, "admin"),
    },
    pageComments: pageScoped,

    pageFavorites: pageScoped,
    // `userId` is the INVITER. The bearer of a token reaches its invite through `admitPageInvite`.
    pageInvites: {
        delete: (scope, row) => pageLevelAtLeast(scope, row.pageId, "admin"),
        insert: (scope, row) => ownsRow(scope, row) && pageLevelAtLeast(scope, row.pageId, "admin"),
        read: (scope) => {
            return { OR: [{ pageId: { in: scope.pages.admin } }, { _id: { in: scope.pages.invites } }] };
        },
        update: (scope, row) => pageLevelAtLeast(scope, row.pageId, "admin") || (typeof row._id === "string" && scope.pages.invites.includes(row._id)),
    },
    pagePresence: pageScoped,
    // ── Pages ──
    pages: {
        delete: (scope, row) => ownsRow(scope, row),
        insert: (scope, row) => ownsRow(scope, row),
        read: (scope, userId) => {
            return { OR: [{ userId }, { _id: { in: scope.pages.any } }] };
        },
        readAnonymous: (scope) => {
            return { _id: { in: scope.pages.any } };
        },
        // A commenter writes too: adding an anchor mark goes through `writeContent`.
        update: (scope, row) => ownsRow(scope, row) || pageLevelAtLeast(scope, row._id, "comment"),
    },
    pageVersions: pageScoped,
    persistentStreams: threadScoped({ hasUserId: true }),
    // Owner, org member, or the public gallery (`isPublic`, served as a projection).
    projects: {
        delete: (scope, row) => ownsRow(scope, row),
        insert: (scope, row) => ownsRow(scope, row),
        read: (scope, userId) => {
            return { OR: [{ userId }, { isPublic: true }, { organizationId: { in: scope.organizations } }] };
        },
        readAnonymous: () => {
            return { isPublic: true };
        },
        update: (scope, row) => ownsRow(scope, row),
    },

    // ── Organization-shared ──
    prompts: orgShared({ orgAdminWrites: false }),
    // Owner, public, or shared with the caller's organization (`canReadSkill`);
    // org admins manage org-shared skills (`canWriteSkill`).
    skills: {
        delete: (scope, row) => ownsRow(scope, row) || (row.visibility === "organization" && isOrganizationAdmin(scope, row.organizationId)),
        insert: (scope, row) => ownsRow(scope, row),
        read: (scope, userId) => {
            return {
                OR: [
                    { userId },
                    { visibility: "public" },
                    { AND: [{ visibility: "organization" }, { organizationId: { in: scope.organizations } }] },
                    { _id: { in: scope.skills } },
                ],
            };
        },
        update: (scope, row) => ownsRow(scope, row) || (row.visibility === "organization" && isOrganizationAdmin(scope, row.organizationId)),
    },

    streamingMessages: threadScoped({ hasUserId: true }),

    // `userId` is the GRANTEE. Every member of a thread sees who else it is
    // shared with (`getThreadAccess` hides the e-mails from non-admins); the
    // owner and admin grantees manage the grants.
    threadAccess: {
        delete: (scope, row) => ownsRow(scope, row) || threadLevelAtLeast(scope, row.threadId, "admin"),
        insert: (scope, row) => threadLevelAtLeast(scope, row.threadId, "admin"),
        read: (scope, userId) => {
            return { OR: [{ userId }, { threadId: { in: scope.threads.full } }] };
        },
        update: (scope, row) => threadLevelAtLeast(scope, row.threadId, "admin"),
    },
    // No `userId`: the pending tokens are the owner's and admin grantees' alone.
    threadInvites: {
        delete: (scope, row) => threadLevelAtLeast(scope, row.threadId, "admin"),
        insert: (scope, row) => threadLevelAtLeast(scope, row.threadId, "admin"),
        read: (scope) => {
            return { threadId: { in: scope.threads.admin } };
        },
        update: (scope, row) => threadLevelAtLeast(scope, row.threadId, "admin"),
    },
    // ── Threads ──
    threads: {
        delete: (scope, row) => ownsRow(scope, row) || threadLevelAtLeast(scope, row._id, "admin"),
        insert: (scope, row) => ownsRow(scope, row),
        read: (scope, userId) => {
            return { OR: [{ userId }, { _id: { in: scope.threads.any } }] };
        },
        readAnonymous: (scope) => {
            return { _id: { in: scope.threads.any } };
        },
        update: (scope, row) => ownsRow(scope, row) || threadLevelAtLeast(scope, row._id, "write"),
    },
    // ── Auth ──
    // The owner of a `user` row is its `_id` (the `userId` column is unused).
    // Names and e-mails of collaborators are read across users (share lists,
    // org members), so reads stay open; writes are self or platform admin.
    user: {
        delete: () => false,
        insert: () => false,
        read: () => true,
        update: (scope, row) => ownsRow(scope, row, "_id"),
    },

    userVariableDefaults: orgShared({ orgAdminWrites: true }),
};

/**
 * Tables deliberately left WITHOUT a policy, and why. `rls.guard.test.ts`
 * fails when a schema table is in neither this list nor {@link POLICIES}.
 */
export const UNPOLICED_TABLES: Record<string, string> = {
    actionCache: "server-side cache of computed values; no user column",
    apikey: "better-auth's own table, reached through its adapter and `verifyApiKey`",
    auditLog: "admin-only audit trail (`admin*` procedures)",
    browserActions: "no owner column; read only after the parent browser session's owner check",
    changelogCache: "public changelog cache",
    chatFiles: "content-addressed and SHARED (same bytes, one row) — no owner; access is the `chatFileAccess` grant",
    cleanupConfigs: "admin-only configuration",
    cleanupLogs: "admin-only logs",
    connectorDefinitions: "global connector catalog",
    cronRuns: "cron slot claims; system only",
    documentHistory: "audit trail written by triggers; no client read",
    emails: "outbound mail log; system only",
    idempotencyClaims: "internal claims; no client access",
    invitation: "better-auth organization invitations; org-scoped, checked by org role",
    jwks: "better-auth signing keys",
    member: "organization membership; org-scoped, read to PROVE membership",
    memberCredits: "org billing rows managed by org and platform admins",
    nodeExecutions: "no owner column; internal only",
    organization: "better-auth organizations; org-scoped",
    payment_customers: "`@lunora/payment` store (Creem customers); read and written only through `ctx.payments` on `__root__`",
    payment_events: "`@lunora/payment` webhook claim log; system only",
    payment_sessions: "`@lunora/payment` store (Creem checkouts); system only",
    payment_subscriptions: "`@lunora/payment` store (Creem subscriptions); system only — the tier lands on `user` / `organization`",
    payment_usageEvents: "`@lunora/payment` usage metering; unused (Creem has none), system only",
    persistentChunks: "no owner column; read through HTTP actions keyed by a verified stream token",
    playgroundApiKeys: "internal only",
    presentationSlides: "no owner column; every access follows the parent presentation's owner check",
    projectKnowledge: "link rows with no owner column; every access follows the project's owner check",
    promptHistory: "`userId` is the EDITOR of an org-shared prompt; read under the prompt's rule",
    rateLimit: "better-auth rate limiter",
    rateLimits: "rate-limit counters written by every procedure's rate-limit middleware",
    sandboxActions: "no owner column; internal only",
    shardActivity: "per-shard housekeeping bookkeeping; system only",
    shardRoutes: "key → owner-shard lookup (a share token, a webhook id), read before any identity; holds no user content",
    signUpInvitation: "invite-only registration; admin and seed route only",
    skillFiles: "internal only",
    skillHistory: "`userId` is the EDITOR (an org admin edits another member's skill); read under the skill's rule",
    skillRatings: "public ratings of public skills, aggregated across users",
    skillStats: "per-skill counters with no owner, bumped by any user of a public skill",
    streamDeltas: "no owner column; read by `streamId` only after the parent `streamingMessages` row passed its policy",
    team: "better-auth teams; org-scoped",
    teamMember: "better-auth team membership; org-scoped",
    teamSettings: "org-scoped settings, checked by org role",
    threadKnowledge: "link rows with no owner column; every access follows a thread access check",
    triggerExecutions: "no owner column; every access follows the parent trigger's owner check",
    verification: "better-auth verification tokens",
};

export const POLICIES = definePolicies<PolicyCtx>(Object.entries(RULES).flatMap(([table, rules]) => policiesFor(table, rules)));

/** Tables {@link POLICIES} governs. */
export const POLICY_TABLES: ReadonlyArray<string> = Object.keys(RULES).toSorted((a, b) => a.localeCompare(b));

/**
 * The RLS middleware every client-reachable builder applies. One instance, so
 * the policy set is built once at module load.
 */
const rowLevelSecurityMiddleware = rls<PolicyCtx & { db: never }>(POLICIES as never);

export const rowLevelSecurity = <C>(): Middleware<C, C> => rowLevelSecurityMiddleware as unknown as Middleware<C, C>;
