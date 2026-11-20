/**
 * Saved site logins: a username and password the user keeps for the agent's browser, so the agent can sign in to a site
 * without the password passing through the chat. The password is encrypted at rest (`site-logins` key purpose) and no
 * procedure returns it, nor its ciphertext: the client and the model see the site, the label and that a password is set.
 *
 * Which chats may use a login: the user's own chats (threads with no teammate) always; a teammate's threads only when the
 * login names that teammate (`teammateIds`), which only its owner sets. A run decides from its thread, never from anything
 * the client sends (`usableSiteLogins`).
 */
import { env } from "cloudflare:workers";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { threadPathTaint } from "../agent/thread-summary-taint";
import { messageCarriesGuestText, messageCarriesOutsideAgentText, messagesCarryAttachedText } from "../chat/lib/attached-text";
import { loadEligibleThread } from "../devices/internal";
import { computeTaint } from "../devices/lib/taint";
import { vDeviceTaintSource } from "../devices/validators";
import { encryptKey } from "../lib/encryption";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow, withoutUndefined } from "../lib/patch";
import { currentShard, ROOT_SHARD_KEY, servesUser } from "../lib/shard-context";
import { isShardRoutingEnabled } from "../lib/shard-namespace";
import { normalizeSiteOrigin, SITE_ORIGIN_MAX } from "./lib/site-origin";

/** Logins one user may keep, and the most any read returns. Bounded so every read is complete. */
export const MAX_SITE_LOGINS = 100;

/** Teammates one login may name. */
export const MAX_SITE_LOGIN_TEAMMATES = 20;

const USERNAME_MAX = 320;
const PASSWORD_MAX = 1024;
const LABEL_MAX = 80;

const vSiteLogin = v.object({
    // Always true: a login cannot be saved without a password. The UI shows that one is set, never what it is.
    hasPassword: v.literal(true),
    id: v.id("savedSiteLogins"),
    label: v.optional(v.string()),
    site: v.string(),
    teammateIds: v.array(v.id("bots")),
    updatedAt: v.number(),
    username: v.string(),
});

const ownLogins = async (ctx: Pick<QueryCtx, "db">, userId: string): Promise<Doc<"savedSiteLogins">[]> =>
    await ctx.db
        .query("savedSiteLogins")
        .withIndex("by_userId_origin", (q) => q.eq("userId", userId))
        .take(MAX_SITE_LOGINS);

/**
 * A collaborator reaches every procedure on the shard of a thread shared with them, and any signed-in caller can name
 * `__root__`. Logins live only on their owner's own shard, so anywhere else a write is refused and a read finds nothing:
 * a row stranded there would escape that user's export and erasure. No shard context at all (unit tests) counts as own,
 * and so does `__root__` while development runs every user on it (`SHARD_ROUTING=off`), where export and erasure do too.
 */
const onOwnShard = (userId: string): boolean => (currentShard() !== ROOT_SHARD_KEY || !isShardRoutingEnabled(env)) && servesUser(userId);

/**
 * An admin acting as the owner saves, changes and deletes no login: the agent types a login in the owner's own turns, so
 * a planted or swapped one, or a teammate added to it, would outlive the impersonation. The list stays readable, as the
 * API key list does: it carries no password. The pattern of `auth_api_keys.createScopedApiKey`.
 */
const refuseImpersonation = (impersonatedBy: string | null | undefined, refused: string): void => {
    if (impersonatedBy) {
        throw new LunoraError("FORBIDDEN", `${refused} while impersonating`);
    }
};

const assertOwnShard = (userId: string): void => {
    if (!onOwnShard(userId)) {
        throw new LunoraError("FORBIDDEN", "Site logins are saved on your own account only");
    }
};

/**
 * The caller's own teammates among `ids`. An id the caller cannot read (deleted, or someone else's bot, which row-level
 * security hides) is dropped, so a client whose bot list is not loaded yet can send a login's ids as they are; a bot
 * read as someone else's refuses the save.
 */
const assertOwnTeammates = async (ctx: Pick<MutationCtx, "db">, userId: string, ids: Id<"bots">[]): Promise<Id<"bots">[]> => {
    const kept: Id<"bots">[] = [];
    const unique = new Set(ids);

    for (const id of unique) {
        const bot = await ctx.db.get("bots", id);

        if (bot && bot.userId !== userId) {
            throw new LunoraError("NOT_FOUND", "Teammate not found");
        }

        if (bot) {
            kept.push(id);
        }
    }

    return kept;
};

const trimmedLabel = (label: string | undefined): string | undefined => {
    const value = label?.trim();

    return value === undefined || value === "" ? undefined : value;
};

/**
 * The caller's saved logins: site, username, label and teammates. Never the password or its ciphertext. The result names
 * the user it was read for: an account switch keeps the last account's cached list, and the form shows only its own.
 */
export const listSiteLogins = authQuery.output(v.object({ logins: v.array(vSiteLogin), userId: v.string() })).query(async ({ ctx }) => {
    const { userId } = ctx.user;

    if (!onOwnShard(userId)) {
        ctx.log.event("vault.list_site_logins", { count: 0, ownShard: false });

        return { logins: [], userId };
    }

    const rows = await ownLogins(ctx, userId);

    ctx.log.event("vault.list_site_logins", { count: rows.length, ownShard: true });

    return {
        logins: rows.map((row) => {
            return {
                hasPassword: true as const,
                id: row._id,
                label: row.label,
                site: row.origin,
                teammateIds: row.teammateIds ?? [],
                updatedAt: row.updatedAt,
                username: row.username,
            };
        }),
        userId,
    };
});

/**
 * Saves a new login, or changes one of the caller's (`loginId`). A new one needs a password; a change without one keeps the
 * saved password. The site of a saved login does not change: a password typed for one site never moves to another. One
 * login per site.
 */
export const saveSiteLogin = authMutation
    .use(rateLimit("vault/site-logins"))
    .input({
        label: v.optional(v.string().max(LABEL_MAX)),
        loginId: v.optional(v.id("savedSiteLogins")),
        // Sensitive: the runtime keeps it out of request logs and validation errors.
        password: v.optional(v.sensitive(v.string().check((value) => value.length > 0 && value.length <= PASSWORD_MAX, { message: "Invalid password" }))),
        site: v.string().max(SITE_ORIGIN_MAX * 4),
        // Twice the limit: the form sends a login's saved ids unfiltered (it cannot tell a deleted bot from one its cached
        // list has not seen yet) plus the ones ticked, which it caps at the limit. What is kept is checked below.
        teammateIds: v.array(v.id("bots")).max(MAX_SITE_LOGIN_TEAMMATES * 2),
        username: v.string().max(USERNAME_MAX),
    })
    .output(v.id("savedSiteLogins"))
    .mutation(async ({ args, ctx }) => {
        const { impersonatedBy, userId } = ctx.user;

        refuseImpersonation(impersonatedBy, "Site logins cannot be saved");
        assertOwnShard(userId);
        const origin = normalizeSiteOrigin(args.site);

        if (origin === null) {
            throw new LunoraError("BAD_REQUEST", "The site must be an https:// address, such as https://example.com");
        }

        const username = args.username.trim();

        if (username === "") {
            throw new LunoraError("BAD_REQUEST", "A username is required");
        }

        const teammateIds = await assertOwnTeammates(ctx, userId, args.teammateIds);

        if (teammateIds.length > MAX_SITE_LOGIN_TEAMMATES) {
            throw new LunoraError("BAD_REQUEST", `A login can name at most ${MAX_SITE_LOGIN_TEAMMATES} bots`);
        }

        const encryptedPassword = args.password === undefined ? undefined : await encryptKey(args.password, "site-logins");
        const fields = { label: trimmedLabel(args.label), teammateIds, updatedAt: ctx.now, username };

        if (args.loginId !== undefined) {
            const row = await ctx.db.get("savedSiteLogins", args.loginId);

            if (!row || row.userId !== userId) {
                throw new LunoraError("NOT_FOUND", "Login not found");
            }

            if (row.origin !== origin) {
                throw new LunoraError("BAD_REQUEST", "The site of a saved login cannot change; save a new login for the other site");
            }

            // A cleared label removes the column (`patchRow`); an absent password keeps the saved one.
            await patchRow(ctx.db, "savedSiteLogins", row, { ...fields, ...withoutUndefined({ encryptedPassword }) });
            ctx.log.event("vault.site_login_saved", { created: false, passwordChanged: encryptedPassword !== undefined });

            return row._id;
        }

        if (encryptedPassword === undefined) {
            throw new LunoraError("BAD_REQUEST", "A password is required");
        }

        const existing = await ctx.db
            .query("savedSiteLogins")
            .withIndex("by_userId_origin", (q) => q.eq("userId", userId).eq("origin", origin))
            .first();

        if (existing) {
            throw new LunoraError("CONFLICT", "A login for this site is already saved");
        }

        const saved = await ownLogins(ctx, userId);

        if (saved.length >= MAX_SITE_LOGINS) {
            throw new LunoraError("BAD_REQUEST", `You can save at most ${MAX_SITE_LOGINS} site logins`);
        }

        const id = await ctx.db.insert("savedSiteLogins", withoutUndefined({ createdAt: ctx.now, encryptedPassword, origin, userId, ...fields }));

        ctx.log.event("vault.site_login_saved", { created: true, passwordChanged: true });

        return id;
    });

export const deleteSiteLogin = authMutation
    .use(rateLimit("vault/site-logins"))
    .input({ loginId: v.id("savedSiteLogins") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        refuseImpersonation(ctx.user.impersonatedBy, "Site logins cannot be deleted");
        assertOwnShard(ctx.user.userId);
        const row = await ctx.db.get("savedSiteLogins", args.loginId);

        if (!row || row.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Login not found");
        }

        await ctx.db.delete("savedSiteLogins", row._id);
        ctx.log.event("vault.site_login_deleted", {});

        return null;
    });

/**
 * What a run knows about the turn it belongs to, as the tool that asks for a login reads it from its `ToolCtx` and the
 * turn's record. Every field is required, so a caller that does not know one cannot fall back to an allowing default.
 */
const siteLoginTurnFields = {
    /** `ToolCtx.headless`: a sub-agent, trigger, task, eval or messenger reply. Nobody is at the app to see the run. */
    headless: v.boolean(),
    /** Whether an admin acting as the owner sent the turn. Recorded on the turn when it starts; a turn that cannot say is not usable. */
    impersonated: v.boolean(),
    /** `ToolCtx.dispatchOrigin`: `"lead"` for the owner's own chat, else what started the run (an outside agent, a trigger, a messenger reply). */
    origin: v.string().max(40),
    /**
     * The turn's prompt row (the tool context's `promptMessageId`, `agent/client/start.ts`): who wrote it is read from the
     * row, never taken from the run. After a resume or an approval that id is a reply or tool row, which is refused.
     */
    promptMessageId: v.id("messages"),
    /** `ToolCtx.startedBy`: who started the turn. A continuation runs as the owner whoever that was. */
    startedBy: v.string().max(64),
    /**
     * What the run had read before it asked: `computeTaint` and `messagesCarryAttachedText` over the messages the model saw for that step (AI SDK
     * `ToolExecutionOptions.messages`, as a device call computes it), so a page, a file or a tool result read earlier in
     * the turn or the thread counts. Any entry refuses every login.
     */
    taintedBy: v.array(vDeviceTaintSource),
};

export type SiteLoginTurn = {
    headless: boolean;
    impersonated: boolean;
    origin: string;
    promptMessageId: Id<"messages">;
    startedBy: string;
    taintedBy: ReadonlyArray<string>;
};

/**
 * Whether the run is the owner's own turn at the app: the owner started it themselves, signed in as themselves, in their
 * own chat (origin `lead`, not headless). Anything else is refused, including an origin this check does not know, so a new
 * way to start a run gets no logins until it is added here on purpose. A public API run records the key's owner as
 * `startedBy`, so `startedBy` alone does not prove a person typed the turn.
 */
export const isOwnInteractiveTurn = (turn: SiteLoginTurn, userId: string): boolean =>
    turn.startedBy === userId && turn.origin === "lead" && turn.headless === false && turn.impersonated === false;

/**
 * Threads an unattended run opened (`triggers/execute.ts`, `tasks/execute.ts`, `evals/execute.ts`): their first prompt is
 * a webhook payload, a task or an eval input, saved as the owner's row, so a regenerate there would pass as the owner's.
 */
const UNATTENDED_THREAD_TAGS: ReadonlySet<string> = new Set(["eval", "task", "trigger"]);

/**
 * The turn's prompt is the owner's own words: a user row of this thread that the owner wrote, carrying no outside agent's
 * text (a regenerate of a public API prompt runs with no origin, so its saved mark is what tells), no guest's note and no
 * content the owner attached rather than typed: a document's extracted text or a captured page
 * (`messagesCarryAttachedText`), a file or image part or a goal's review note (`computeTaint`), or files named only by
 * `fileIds`. A row an agent wrote under the owner's id (a goal's next round, `agentName`) is not theirs, nor is one with no
 * author. A part that is not text is refused, so a new kind gets no logins until it is classified here on purpose.
 */
const ownPromptRow = async (
    ctx: Pick<QueryCtx, "db">,
    promptMessageId: Id<"messages">,
    threadId: Id<"threads">,
    userId: string,
): Promise<Doc<"messages"> | undefined> => {
    const prompt = await ctx.db.get("messages", promptMessageId);

    if (!prompt || prompt.threadId !== threadId || prompt.userId !== userId || prompt.agentName !== undefined || (prompt.fileIds?.length ?? 0) > 0) {
        return undefined;
    }

    const message = prompt.message as Parameters<typeof messageCarriesOutsideAgentText>[0];
    const typedOnly =
        typeof message?.content === "string" ||
        (Array.isArray(message?.content) && (message.content as ReadonlyArray<{ type?: unknown }>).every((part) => part.type === "text"));

    const own =
        message?.role === "user" &&
        typedOnly &&
        !messageCarriesOutsideAgentText(message) &&
        !messageCarriesGuestText(message) &&
        !messagesCarryAttachedText([message]) &&
        computeTaint([message]).length === 0;

    return own ? prompt : undefined;
};

/**
 * Whether the run has read anything untrusted before it asked: what it reports from the step's messages
 * (`turn.taintedBy`: this turn's tool results), and, read here whatever the caller says, the prompt's path up to it, the
 * thread's context summaries and a coding agent's handoff (`threadPathTaint`).
 */
const turnIsTainted = async (ctx: Pick<QueryCtx, "db">, turn: SiteLoginTurn, threadId: Id<"threads">, prompt: Doc<"messages">): Promise<boolean> => {
    if (turn.taintedBy.length > 0) {
        return true;
    }

    const read = await threadPathTaint(ctx, threadId, prompt);

    return read.length > 0;
};

/**
 * The logins a run of `threadId` may use, for the agent's browser. Only the owner's own turn at the app
 * (`isOwnInteractiveTurn`, with a prompt the owner typed and nothing untrusted read so far, `turnIsTainted`), and only in a thread nobody else's text can reach
 * (`loadEligibleThread`: not shared, public, a group chat, a messenger conversation or deleted; nor one a trigger, task
 * or eval opened), since whoever can steer
 * the model could otherwise sign in as the owner. The owner's own chats get every login; a teammate's thread only the
 * logins naming that teammate, while it still exists and is theirs.
 */
export const usableSiteLogins = async (
    ctx: Pick<QueryCtx, "db">,
    args: { threadId: Id<"threads">; turn: SiteLoginTurn; userId: string },
): Promise<Doc<"savedSiteLogins">[]> => {
    if (!isOwnInteractiveTurn(args.turn, args.userId)) {
        return [];
    }

    const thread = await loadEligibleThread(ctx, args.threadId, args.userId);

    if (!thread || (thread.tags ?? []).some((tag) => UNATTENDED_THREAD_TAGS.has(tag))) {
        return [];
    }

    const prompt = await ownPromptRow(ctx, args.turn.promptMessageId, args.threadId, args.userId);

    if (!prompt || (await turnIsTainted(ctx, args.turn, args.threadId, prompt))) {
        return [];
    }

    const rows = await ownLogins(ctx, args.userId);
    const { botId } = thread;

    if (botId === undefined) {
        return rows;
    }

    const bot = await ctx.db.get("bots", botId);

    if (!bot || bot.userId !== args.userId) {
        return [];
    }

    return rows.filter((row) => (row.teammateIds ?? []).includes(botId));
};

/** What the model may see of the logins a run may use: the site and the label. No username, no password. */
export const listUsableSiteLogins = internalQuery
    .input({ threadId: v.id("threads"), turn: v.object({ ...siteLoginTurnFields }), userId: v.string() })
    .output(v.array(v.object({ label: v.optional(v.string()), site: v.string() })))
    .query(async ({ args, ctx }) => {
        const rows = await usableSiteLogins(ctx, args);

        return rows.map((row) => {
            return { label: row.label, site: row.origin };
        });
    });

/**
 * The one login a run of `threadId` may use for `site`, still encrypted, for the server-side fill. `null` when there is
 * none: the site is not saved, or the run may not use it. `site` is the origin of the page the browser is on, read by
 * the server, never a site the model names. The caller decrypts it in the action that types it, and never returns it
 * from a workflow step or puts it in a queue payload, where it would be kept.
 */
export const siteLoginForFill = internalQuery
    .input({ site: v.string().max(SITE_ORIGIN_MAX * 4), threadId: v.id("threads"), turn: v.object({ ...siteLoginTurnFields }), userId: v.string() })
    .output(v.union(v.null(), v.object({ encryptedPassword: v.string(), site: v.string(), username: v.string() })))
    .query(async ({ args, ctx }) => {
        const origin = normalizeSiteOrigin(args.site);

        if (origin === null) {
            return null;
        }

        const rows = await usableSiteLogins(ctx, args);
        const row = rows.find((login) => login.origin === origin);

        return row ? { encryptedPassword: row.encryptedPassword, site: row.origin, username: row.username } : null;
    });
