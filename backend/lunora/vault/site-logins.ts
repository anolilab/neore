/**
 * Saved site logins: a username and password the user keeps for the agent's browser, so the agent can sign in to a site
 * without the password passing through the chat. The password is encrypted at rest (`site-logins` key purpose) and no
 * procedure returns it, nor its ciphertext: the client and the model see the site, the label and that a password is set.
 *
 * Which chats may use a login: the user's own chats (threads with no teammate) always; a teammate's threads only when the
 * login names that teammate (`teammateIds`), which only its owner sets. A run decides from its thread, never from anything
 * the client sends, and only in a turn with nothing but safe text in front of the model (`site-login-turn.ts`).
 */
import { env } from "cloudflare:workers";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { encryptKey } from "../lib/encryption";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow, withoutUndefined } from "../lib/patch";
import { currentShard, ROOT_SHARD_KEY, servesUser } from "../lib/shard-context";
import { isShardRoutingEnabled } from "../lib/shard-namespace";
import { SITE_LOGIN_CHANGED } from "./lib/site-login-shape";
import { normalizeSiteOrigin, SITE_ORIGIN_MAX } from "./lib/site-origin";
import { type SiteLoginTurn, siteLoginTurnVerdict } from "./site-login-turn";

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

/**
 * The caller's login `loginId`, for a change opened from its version `expectedUpdatedAt` on `origin`. Refused when it is
 * not theirs, when it changed since (`CONFLICT`, `SITE_LOGIN_CHANGED`: an edit opened before a bot was removed elsewhere
 * would write it back), or when the change names another site.
 */
const loginToChange = async (
    ctx: Pick<MutationCtx, "db">,
    args: { expectedUpdatedAt: number | undefined; loginId: Id<"savedSiteLogins">; origin: string; userId: string },
): Promise<Doc<"savedSiteLogins">> => {
    if (args.expectedUpdatedAt === undefined) {
        throw new LunoraError("BAD_REQUEST", "A change to a saved login must say which version it changes");
    }

    const row = await ctx.db.get("savedSiteLogins", args.loginId);

    if (!row || row.userId !== args.userId) {
        throw new LunoraError("NOT_FOUND", "Login not found");
    }

    if (row.updatedAt !== args.expectedUpdatedAt) {
        throw new LunoraError("CONFLICT", "This login was changed elsewhere", { data: { code: SITE_LOGIN_CHANGED } });
    }

    if (row.origin !== args.origin) {
        throw new LunoraError("BAD_REQUEST", "The site of a saved login cannot change; save a new login for the other site");
    }

    return row;
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
 * login per site. A change carries the `updatedAt` of the login as it was read (`expectedUpdatedAt`) and is refused with
 * `CONFLICT` (`SITE_LOGIN_CHANGED`) when the login moved since: an edit opened before a bot was removed elsewhere would
 * otherwise write that bot back.
 */
export const saveSiteLogin = authMutation
    .use(rateLimit("vault/site-logins"))
    .input({
        // Required with `loginId`: the `updatedAt` of the login the edit was opened from.
        expectedUpdatedAt: v.optional(v.number()),
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
    // The version saved, so the form can keep editing the login without refusing its own next save.
    .output(v.object({ id: v.id("savedSiteLogins"), updatedAt: v.number() }))
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
            const row = await loginToChange(ctx, { expectedUpdatedAt: args.expectedUpdatedAt, loginId: args.loginId, origin, userId });
            // A cleared label removes the column (`patchRow`); an absent password keeps the saved one. The version is always
            // later than the one read, so two saves in one millisecond still tell apart.
            const updatedAt = Math.max(ctx.now, row.updatedAt + 1);

            await patchRow(ctx.db, "savedSiteLogins", row, { ...fields, updatedAt, ...withoutUndefined({ encryptedPassword }) });
            ctx.log.event("vault.site_login_saved", { created: false, passwordChanged: encryptedPassword !== undefined });

            return { id: row._id, updatedAt };
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

        return { id, updatedAt: fields.updatedAt };
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
 * What each must hold is decided in `site-login-turn.ts`.
 */
export const siteLoginTurnFields = {
    /** `ToolCtx.headless`: a sub-agent, trigger, task, eval or messenger reply. Nobody is at the app to see the run. */
    headless: v.boolean(),
    /**
     * Whether the turn is not the owner's own (an admin acting as the owner, an extension sign-in, or an approval answered
     * from a session that isn't the owner's live one). Recorded on the turn; a turn that cannot say is not usable.
     */
    impersonated: v.boolean(),
    /** `ToolCtx.dispatchOrigin`: `"lead"` for the owner's own chat, else what started the run (an outside agent, a trigger, a messenger reply). */
    origin: v.string().max(40),
    /** The fill's own tool call when it runs approved, with no step messages: the step is read from the saved rows (`site-login-turn.ts`). */
    ownCallId: v.optional(v.string().max(128)),
    /**
     * The turn's prompt row (the tool context's `promptMessageId`, `agent/client/start.ts`): who wrote it is read from the
     * row, never taken from the run. After a resume or an approval that id is a reply or tool row, which is refused.
     */
    promptMessageId: v.id("messages"),
    /** `ToolCtx.startedBy`: who started the turn. A continuation runs as the owner whoever that was. */
    startedBy: v.string().max(64),
    /**
     * The messages the model saw for the step, as they are (AI SDK `ToolExecutionOptions.messages`): this run's own steps
     * are not on the saved path above the prompt yet. Each is classified by the same allowlist as a saved row; none at all
     * refuses. Too many to send is a refusal too. A message's own `providerOptions` come along: a search hit's mark is there.
     */
    stepMessages: v.array(v.object({ content: v.optional(v.any()), providerOptions: v.optional(v.any()), role: v.string().max(16) })).max(1000),
    /**
     * Every kind of text in the run's system prompt, one per piece as it is assembled: `instructions` (the app's own,
     * always), `personalization`, `teammate`, and for anything else its own kind (`knowledge`, `memory`, `project`,
     * `threadInstructions`, `requestInstructions`, `skills`, `threadNotes`, `attachedDocuments`, …). Any kind but the safe
     * three refuses, so an unnamed one cannot pass.
     */
    systemContext: v.array(v.string().max(40)).max(32),
    /** The source of every tool the model is offered (`ToolSource`: `builtin`, `mcp`, `connector`, `device`); only `builtin` passes. */
    toolSources: v.array(v.string().max(16)).max(500),
};

/**
 * The logins a run of `threadId` may use, for the agent's browser: none unless `siteLoginTurnVerdict` allows the turn
 * (the owner's own turn at the app, in a chat only they can reach, with only safe text in front of the model). Then the
 * owner's own chats get every login; a teammate's thread only the logins naming that teammate, while it still exists
 * and is theirs.
 */
export const usableSiteLogins = async (
    ctx: Pick<QueryCtx, "db">,
    args: { threadId: Id<"threads">; turn: SiteLoginTurn; userId: string },
): Promise<Doc<"savedSiteLogins">[]> => {
    // As list, save and delete: a row stranded on `__root__` (or on a collaborator's shard) is no login of this user's.
    if (!onOwnShard(args.userId)) {
        return [];
    }

    const verdict = await siteLoginTurnVerdict(ctx, args);

    if (!verdict.allowed) {
        return [];
    }

    const rows = await ownLogins(ctx, args.userId);
    const { botId } = verdict.thread;

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
