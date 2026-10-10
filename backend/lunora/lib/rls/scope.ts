/**
 * The per-request half of row-level security: who the caller is, and which
 * shared resources the request has PROVEN it may reach.
 *
 * Policies (`./policies.ts`) are synchronous and evaluated once per table per
 * request, so they cannot look a grant up themselves. Instead the access
 * helpers that already decide sharing — `resolveThreadReadAccess`,
 * `resolvePageAccess`, the membership checks — make their decision and then
 * ADMIT the resource here. A read policy's predicate references this scope's
 * arrays by identity (`{ threadId: { in: scope.threads.any } }`), so a row
 * admitted after the predicate was built is still matched: the engine reads
 * the array when it runs the query, not when the policy ran.
 *
 * What this buys: a procedure that forgets its check reaches only the caller's
 * own rows plus whatever an access helper admitted on the way. A stranger's
 * thread id from args, read raw, comes back `null`.
 *
 * The sanctioned bypass is {@link systemDb}: the database as it was BEFORE the
 * RLS wrapper, for access DECISIONS only (does this grant exist? who owns this
 * key?). Every importer is listed in `rls.guard.test.ts`, so a new one is a
 * reviewed decision. Internal functions need neither — they are built without
 * the RLS middleware and are system code by construction.
 */
import type { Middleware, TableReader } from "lunorash/server";
import { bindTableFacade } from "lunorash/server";

import type { Doc, IndexNamesByTable } from "../../_generated/dataModel";

import type { MutationCtx, QueryCtx, TableReaderFacade } from "../../_generated/server";
import type { SessionUser } from "../auth-types";

/** Thread access, weakest first. `public` is the redacted view of a shared thread. */
export type ThreadLevel = "admin" | "public" | "read" | "write";

/** Page access, weakest first. `public` is the token-keyed share view. */
export type PageLevel = "admin" | "comment" | "public" | "read" | "write";

const THREAD_RANK: Record<ThreadLevel, number> = { admin: 4, public: 1, read: 2, write: 3 };
const PAGE_RANK: Record<PageLevel, number> = { admin: 5, comment: 3, public: 1, read: 2, write: 4 };

/** Org roles that manage org-shared rows (`canWriteSkill`, org variable defaults). */
const ORG_ADMIN_ROLES = new Set(["admin", "owner"]);

type RawDatabase = MutationCtx["db"] | QueryCtx["db"];

/**
 * Ids per resource. The ARRAYS are what the read predicates close over — they
 * are only ever pushed to, never replaced, so the identity the policy captured
 * stays live for the whole request.
 */
interface Admitted<Level extends string> {
    /** Any admitted level, `public` included — what a read policy matches. */
    readonly any: string[];
    readonly levels: Map<string, Level>;
}

export interface RlsScope {
    /** The session's active organization — a membership proven by the auth middleware. */
    readonly activeOrganizationId: string | null;
    /** Platform admin procedure (`admin*` builders): every policy allows. */
    readonly admin: boolean;
    readonly knowledgeFiles: string[];
    /** The active organization's role, for org-admin writes. */
    readonly organizationRole: string | null;
    /** Organizations the caller is a PROVEN member of (active org, plus admitted memberships). */
    readonly organizations: string[];
    readonly pages: Admitted<PageLevel> & { readonly admin: string[]; readonly invites: string[]; readonly member: string[] };
    readonly raw: RawDatabase;
    readonly skills: string[];
    readonly threads: Admitted<ThreadLevel> & { readonly admin: string[]; readonly full: string[]; readonly write: string[] };
    readonly userId: string | null;
}

interface ScopeSource {
    auth?: { userId?: null | string };
    db: RawDatabase;
    user?: null | SessionUser;
}

export const createRlsScope = (ctx: ScopeSource, admin: boolean): RlsScope => {
    const userId = ctx.user?.userId ?? ctx.auth?.userId ?? null;
    const activeOrganization = ctx.user?.activeOrganization ?? null;

    return {
        activeOrganizationId: activeOrganization?.id ?? null,
        admin,
        knowledgeFiles: [],
        organizationRole: activeOrganization?.role ?? null,
        organizations: activeOrganization ? [activeOrganization.id] : [],
        pages: { admin: [], any: [], invites: [], levels: new Map(), member: [] },
        raw: ctx.db,
        skills: [],
        threads: { admin: [], any: [], full: [], levels: new Map(), write: [] },
        userId,
    };
};

/**
 * Opens the scope. Sits in every client-reachable builder directly before
 * `rls(POLICIES)` and after the auth middleware, so `ctx.user` (and with it the
 * proven active organization) is already known.
 */
export const withRlsScope =
    <C extends ScopeSource>(options: { admin: boolean }): Middleware<C, C & { rlsScope: RlsScope }> =>
    async ({ ctx, next }) =>
        // Admin is decided by the builder AND the role: `platformAdmin` runs first.
        await next({ ctx: { rlsScope: createRlsScope(ctx, options.admin && ctx.user?.isAdmin === true) } } as never);

/** The scope of a guarded context, or `undefined` inside internal functions and tests that run raw. */
export const scopeOf = (ctx: unknown): RlsScope | undefined => {
    const scope = (ctx as { rlsScope?: RlsScope } | null | undefined)?.rlsScope;

    return scope && typeof scope === "object" ? scope : undefined;
};

/**
 * The database WITHOUT row-level security, for access decisions only. Inside
 * an internal function (no scope) this is simply `ctx.db`, which is already
 * unguarded. Never return rows read through it to a caller who was not proven
 * to hold access to them — admit the resource and re-read through `ctx.db`, or
 * return a decision.
 */
export const systemDb = <D extends RawDatabase>(ctx: { db: D }): D => (scopeOf(ctx)?.raw as D | undefined) ?? ctx.db;

const pushOnce = (list: string[], id: string): void => {
    if (!list.includes(id)) {
        list.push(id);
    }
};

/**
 * Records a thread decision for the CALLER. A decision about some other user
 * (a helper asked on someone else's behalf) admits nothing.
 */
export const admitThread = (ctx: unknown, threadId: string, level: ThreadLevel, forUserId?: null | string): void => {
    const scope = scopeOf(ctx);

    if (!scope || (forUserId !== undefined && forUserId !== scope.userId)) {
        return;
    }

    const previous = scope.threads.levels.get(threadId);

    if (previous && THREAD_RANK[previous] >= THREAD_RANK[level]) {
        return;
    }

    scope.threads.levels.set(threadId, level);
    pushOnce(scope.threads.any, threadId);

    if (THREAD_RANK[level] >= THREAD_RANK.read) {
        pushOnce(scope.threads.full, threadId);
    }

    if (THREAD_RANK[level] >= THREAD_RANK.write) {
        pushOnce(scope.threads.write, threadId);
    }

    if (level === "admin") {
        pushOnce(scope.threads.admin, threadId);
    }
};

/** Records a page decision for the caller; see {@link admitThread}. */
export const admitPage = (ctx: unknown, pageId: string, level: PageLevel, forUserId?: null | string): void => {
    const scope = scopeOf(ctx);

    if (!scope || (forUserId !== undefined && forUserId !== scope.userId)) {
        return;
    }

    const previous = scope.pages.levels.get(pageId);

    if (previous && PAGE_RANK[previous] >= PAGE_RANK[level]) {
        return;
    }

    scope.pages.levels.set(pageId, level);
    pushOnce(scope.pages.any, pageId);

    if (PAGE_RANK[level] >= PAGE_RANK.read) {
        pushOnce(scope.pages.member, pageId);
    }

    if (level === "admin") {
        pushOnce(scope.pages.admin, pageId);
    }
};

/** A pending page invite the caller holds the bearer token of (`acceptPageInvite`). */
export const admitPageInvite = (ctx: unknown, inviteId: string): void => {
    const scope = scopeOf(ctx);

    if (scope) {
        pushOnce(scope.pages.invites, inviteId);
    }
};

/** Organizations whose membership the caller just proved (an org id from args, checked). */
export const admitOrganization = (ctx: unknown, organizationId: string): void => {
    const scope = scopeOf(ctx);

    if (scope) {
        pushOnce(scope.organizations, organizationId);
    }
};

/** Knowledge files attached to a thread the caller was admitted to (`getThreadKnowledge`). */
export const admitKnowledgeFiles = (ctx: unknown, fileIds: Iterable<string>): void => {
    const scope = scopeOf(ctx);

    if (scope) {
        for (const id of fileIds) {
            pushOnce(scope.knowledgeFiles, id);
        }
    }
};

/** Skills a readable group chat names as participants (`getGroupChat`). */
export const admitSkills = (ctx: unknown, skillIds: Iterable<string>): void => {
    const scope = scopeOf(ctx);

    if (scope) {
        for (const id of skillIds) {
            pushOnce(scope.skills, id);
        }
    }
};

export const threadLevelAtLeast = (scope: RlsScope, threadId: unknown, level: ThreadLevel): boolean => {
    const granted = typeof threadId === "string" ? scope.threads.levels.get(threadId) : undefined;

    return granted !== undefined && THREAD_RANK[granted] >= THREAD_RANK[level];
};

export const pageLevelAtLeast = (scope: RlsScope, pageId: unknown, level: PageLevel): boolean => {
    const granted = typeof pageId === "string" ? scope.pages.levels.get(pageId) : undefined;

    return granted !== undefined && PAGE_RANK[granted] >= PAGE_RANK[level];
};

export const isOrganizationAdmin = (scope: RlsScope, organizationId: unknown): boolean =>
    typeof organizationId === "string" &&
    scope.activeOrganizationId === organizationId &&
    scope.organizationRole !== null &&
    ORG_ADMIN_ROLES.has(scope.organizationRole);

/**
 * The PARENT key of a row, read past row-level security — for the "load a child
 * by id, then check access on its parent" shape (a page comment → its page).
 * Only the key crosses the bypass: decide access on the parent (which admits
 * it), then read the row itself through `ctx.db`.
 */
export const parentKeyOf = async (ctx: { db: RawDatabase }, id: string, field: string): Promise<string | null> => {
    const row = (await (systemDb(ctx) as QueryCtx["db"]).get(id as never)) as Record<string, unknown> | null;
    const key = row?.[field];

    return typeof key === "string" ? key : null;
};

/**
 * The thread-scoped tables and, per table, the indexes that START with
 * `threadId` — the only way in through {@link readerForAdmittedThread}.
 * `rls.guard.test.ts` checks each index against `schema.ts`.
 */
export const ADMITTED_THREAD_INDEXES = {
    documents: ["by_threadId_and_kind"],
    followupSuggestions: ["by_thread"],
    messages: ["by_threadId_order_stepOrder", "by_threadId_parentMessageId", "threadId_status_tool_order_stepOrder"],
    persistentStreams: ["by_threadId"],
    streamingMessages: ["threadId_state_order_stepOrder"],
} as const satisfies {
    readonly [T in "documents" | "followupSuggestions" | "messages" | "persistentStreams" | "streamingMessages"]: ReadonlyArray<IndexNamesByTable[T]>;
};

export type AdmittedThreadTable = keyof typeof ADMITTED_THREAD_INDEXES;

type RangeBuilder = Parameters<TableReader["withIndex"]>[1];

/** What {@link readerForAdmittedThread} hands out: reads keyed on ONE thread, nothing else. */
export interface AdmittedThreadReader {
    /** The legacy builder, reachable only through a `threadId`-first index with `.eq("threadId", <the thread>)` first. */
    query: <T extends AdmittedThreadTable>(
        table: T,
    ) => {
        withIndex: (index: (typeof ADMITTED_THREAD_INDEXES)[T][number], range: RangeBuilder) => TableReader<Doc<T>, IndexNamesByTable[T]>;
    };
    /** The ORM facade's reads, with `where.threadId` required to be the thread. */
    table: <T extends AdmittedThreadTable>(table: T) => Pick<TableReaderFacade<T>, "findFirst" | "findMany">;
}

const refuse = (message: string): never => {
    throw new Error(`readerForAdmittedThread: ${message}`);
};

const isAdmittedTable = (table: string): table is AdmittedThreadTable => Object.hasOwn(ADMITTED_THREAD_INDEXES, table);

/** Runs `range` against a recorder; the FIRST bound must be `eq("threadId", threadId)`. */
const assertRangeKeyedOn = (range: RangeBuilder, threadId: string): void => {
    const calls: { field: unknown; op: string; value: unknown }[] = [];
    const recorder: Record<string, (field: unknown, value: unknown) => unknown> = {};

    for (const op of ["eq", "gt", "gte", "lt", "lte"]) {
        recorder[op] = (field, value) => {
            calls.push({ field, op, value });

            return recorder;
        };
    }

    (range as unknown as (q: unknown) => unknown)(recorder);

    const [first] = calls;

    if (first?.op !== "eq" || first.field !== "threadId" || first.value !== threadId) {
        refuse(`the index range must begin with .eq("threadId", "${threadId}")`);
    }
};

const assertWhereKeyedOn = (options: unknown, threadId: string): void => {
    const where = (options as { where?: Record<string, unknown> } | undefined)?.where;
    const key = where?.threadId;
    const value = key !== null && typeof key === "object" && Object.keys(key).length === 1 && "eq" in key ? (key as { eq: unknown }).eq : key;

    if (value !== threadId) {
        refuse(`every read needs where.threadId === "${threadId}"`);
    }
};

/**
 * Reads the rows of ONE thread the request already admitted, past row-level
 * security — because there the policy filters nothing and only costs.
 *
 * Behind `rls()` every read also evaluates the policy. (Until
 * `@lunora/server@alpha.145` the legacy builder filtered in memory and dropped
 * the SQL LIMIT, anolilab/lunora#822.) For an admitted
 * thread the thread-scoped policies (`userId = me OR threadId IN admitted`)
 * pass every row of that thread, so skipping them changes only the cost. The
 * reader enforces that it is used for nothing else: only the thread-scoped
 * tables, only reads, and only reads keyed on THIS `threadId` — the legacy
 * builder through a `threadId`-first index whose range starts with
 * `.eq("threadId", threadId)`, the ORM facade with `where.threadId` set to it.
 * Anything else throws.
 *
 * Throws unless the thread was admitted (call it after `resolveThreadReadAccess`
 * / `requireOwnedThread`). Outside a guarded procedure it reads `ctx.db` under
 * the same restrictions.
 */
export const readerForAdmittedThread = (ctx: { db: RawDatabase }, threadId: string): AdmittedThreadReader => {
    const scope = scopeOf(ctx);

    if (scope && !scope.admin && !scope.threads.levels.has(threadId)) {
        refuse(`thread ${threadId} was not admitted — decide access (resolveThreadReadAccess) first`);
    }

    const db = (scope?.raw ?? ctx.db) as QueryCtx["db"];
    const checkedTable = (table: string): AdmittedThreadTable => (isAdmittedTable(table) ? table : refuse(`"${table}" is not a thread-scoped table`));

    return {
        query: (table) => {
            const name = checkedTable(table);

            return {
                withIndex: (index, range) => {
                    if (!(ADMITTED_THREAD_INDEXES[name] as ReadonlyArray<string>).includes(index)) {
                        refuse(`"${String(index)}" is not a threadId-first index of "${name}"`);
                    }

                    assertRangeKeyedOn(range, threadId);

                    return db.query(name).withIndex(index as never, range as never) as never;
                },
            };
        },
        table: (table) => {
            const facade = bindTableFacade(db as never, checkedTable(table)) as unknown as Pick<
                TableReaderFacade<AdmittedThreadTable>,
                "findFirst" | "findMany"
            >;

            return {
                findFirst: async (options: unknown) => {
                    assertWhereKeyedOn(options, threadId);

                    return await facade.findFirst(options as never);
                },
                findMany: async (options: unknown) => {
                    assertWhereKeyedOn(options, threadId);

                    return await facade.findMany(options as never);
                },
            } as never;
        },
    };
};
