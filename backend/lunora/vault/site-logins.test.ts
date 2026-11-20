/**
 * Saved site logins: the password is stored encrypted and no procedure hands it, or its ciphertext, to a client or the
 * model; only the owner changes a login; a teammate's thread uses only the logins that name that teammate.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/encryption` reads the key when it loads.
const keyBytes = new Uint8Array(32);

crypto.getRandomValues(keyBytes);
vi.stubEnv("ENCRYPTION_KEY", btoa(String.fromCodePoint(...keyBytes)));

const { impersonation, sessionFrom } = vi.hoisted(() => {
    // Set while a test acts as an admin impersonating the signed-in user.
    const state = { by: undefined as string | undefined };

    return {
        impersonation: state,
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, impersonatedBy: state.by, isAdmin: false, userId: context.auth.userId }
                : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

// `servesUser` reads the shard the request runs on; the harness has none, so a test sets it.
const shard = vi.hoisted(() => {
    return { servesOwnUser: true };
});

vi.mock("../lib/shard-context", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-context")>()),
        servesUser: () => shard.servesOwnUser,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const { default: schema } = await import("../schema");
const { decryptKey } = await import("../lib/encryption");
const { ROOT_SHARD_KEY, runInShard } = await import("../lib/shard-context");
// The `cloudflare:workers` test stub (`test/stubs/cloudflare-workers.ts`); a test sets the shard routing switch on it.
const { env: workerEnv } = (await import("cloudflare:workers")) as unknown as { env: { ENVIRONMENT?: string; SHARD_ROUTING?: string } };
const { deleteSiteLogin, listSiteLogins, listUsableSiteLogins, saveSiteLogin, siteLoginForFill } = await import("./site-logins");
const { eraseVaultForUser } = await import("./gdpr");
const { collectFiles } = await import("../gdpr/steps");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const SITE = "https://example.com";
// Plain HTTP, the scheme a login must refuse; joined so no insecure URL literal sits in the source.
const INSECURE_SITE = ["http", "//example.com"].join(":");

const HTTPS_ONLY = /https/;
const PASSWORD_REQUIRED = /password is required/;
const CANNOT_CHANGE = /cannot change/;
const ALREADY_SAVED = /already saved/;
const NOT_FOUND = /not found/;
const OWN_ACCOUNT_ONLY = /own account only/;
const SAVE_WHILE_IMPERSONATING = /cannot be saved while impersonating/;
const DELETE_WHILE_IMPERSONATING = /cannot be deleted while impersonating/;

// Built at run time, so no secret-shaped literal sits in the source.
const PASSWORD = ["pw", crypto.randomUUID(), "x"].join("-");

let harness: ReturnType<typeof lunoraTest>;
let botId = "";
let otherBotId = "";
let plainThread = "";
let botThread = "";
let otherBotThread = "";

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertBot = async (userId: string, name: string) =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("bots", { computerEnabled: false, createdAt: 1, instructions: "", model: "test-model", name, updatedAt: 1, userId }),
    )) as string;

const listLogins = async (userId: string) =>
    (await as(userId).query(listSiteLogins as never, {} as never)) as { logins: Record<string, unknown>[]; userId: string };

const save = async (args: Record<string, unknown>, userId = OWNER) =>
    (await as(userId).mutation(saveSiteLogin as never, { site: SITE, teammateIds: [], username: "ada@example.com", ...args } as never)) as string;

const rows = async () => (await harness.run(async (ctx: any) => await ctx.db.query("savedSiteLogins").collect())) as Record<string, unknown>[];

const usable = async (threadId: string, userId = OWNER, startedBy = userId) =>
    await harness.run(async (ctx: any) => await ctx.runQuery(listUsableSiteLogins, { startedBy, threadId, userId }));

const forFill = async (threadId: string, site = SITE, userId = OWNER, startedBy = userId) =>
    await harness.run(async (ctx: any) => await ctx.runQuery(siteLoginForFill, { site, startedBy, threadId, userId }));

const insertThread = async (fields: Record<string, unknown>) =>
    (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "Other", userId: OWNER, ...fields }))) as string;

beforeEach(async () => {
    shard.servesOwnUser = true;
    impersonation.by = undefined;
    harness = lunoraTest(schema as never);
    botId = await insertBot(OWNER, "Ada");
    otherBotId = await insertBot(OWNER, "Bo");
    plainThread = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "Mine", userId: OWNER }))) as string;
    botThread = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { botId, title: "Ada's", userId: OWNER }))) as string;
    otherBotThread = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { botId: otherBotId, title: "Bo's", userId: OWNER }))) as string;
});

afterEach(() => {
    impersonation.by = undefined;
    harness.close();
});

describe("saving a site login", () => {
    it("stores the password encrypted, and the list shows only that one is set", async () => {
        await save({ label: "Work", password: PASSWORD, site: "https://Example.com/login?next=/" });

        const [row] = await rows();

        expect(row?.["origin"]).toBe(SITE);
        expect(JSON.stringify(row)).not.toContain(PASSWORD);
        expect(await decryptKey(row?.["encryptedPassword"] as string, "site-logins")).toBe(PASSWORD);

        const listed = await listLogins(OWNER);

        expect(listed.userId).toBe(OWNER);

        expect(listed.logins).toStrictEqual([
            { hasPassword: true, id: row?.["_id"], label: "Work", site: SITE, teammateIds: [], updatedAt: expect.any(Number), username: "ada@example.com" },
        ]);
        expect(JSON.stringify(listed)).not.toContain(PASSWORD);
        expect(JSON.stringify(listed)).not.toContain(row?.["encryptedPassword"] as string);
    });

    it("refuses a site that is not https, and a new login without a password", async () => {
        await expect(save({ password: PASSWORD, site: INSECURE_SITE })).rejects.toThrow(HTTPS_ONLY);
        await expect(save({})).rejects.toThrow(PASSWORD_REQUIRED);
        expect(await rows()).toHaveLength(0);
    });

    it("keeps the saved password on an edit without one, and never moves a login to another site", async () => {
        const id = await save({ password: PASSWORD });
        const [before] = await rows();

        await save({ label: "Renamed", loginId: id });
        const [edited] = await rows();

        expect(edited?.["encryptedPassword"]).toBe(before?.["encryptedPassword"]);
        expect(edited?.["label"]).toBe("Renamed");

        await expect(save({ loginId: id, site: "https://evil.example" })).rejects.toThrow(CANNOT_CHANGE);
        const [unmoved] = await rows();

        expect(unmoved?.["origin"]).toBe(SITE);
    });

    it("refuses a second login for the same site", async () => {
        await save({ password: PASSWORD });
        await expect(save({ password: PASSWORD, site: "example.com" })).rejects.toThrow(ALREADY_SAVED);
    });

    it("never stores a teammate that is not the caller's", async () => {
        const strangersBot = await insertBot(STRANGER, "Eve");

        await save({ password: PASSWORD, teammateIds: [strangersBot, botId] });

        const [row] = await rows();

        expect(row?.["teammateIds"]).toStrictEqual([botId]);
    });

    it("drops a teammate that was deleted, so an edit sent before the bot list loaded still saves", async () => {
        const id = await save({ password: PASSWORD, teammateIds: [botId, otherBotId] });

        await harness.run(async (ctx: any) => await ctx.db.delete("bots", otherBotId));
        await save({ loginId: id, teammateIds: [botId, otherBotId] });

        const [row] = await rows();

        expect(row?.["teammateIds"]).toStrictEqual([botId]);
    });

    it("lets no one else change, delete or list the owner's login", async () => {
        const id = await save({ password: PASSWORD });

        await expect(save({ loginId: id, password: "other" }, STRANGER)).rejects.toThrow(NOT_FOUND);
        await expect(as(STRANGER).mutation(deleteSiteLogin as never, { loginId: id } as never)).rejects.toThrow(NOT_FOUND);
        expect(await listLogins(STRANGER)).toStrictEqual({ logins: [], userId: STRANGER });

        await as(OWNER).mutation(deleteSiteLogin as never, { loginId: id } as never);
        expect(await rows()).toHaveLength(0);
    });

    it("refuses a save on a shard that is not the caller's own, where a collaborator's row would escape their erasure", async () => {
        shard.servesOwnUser = false;

        await expect(save({ password: PASSWORD })).rejects.toThrow(OWN_ACCOUNT_ONLY);
        expect(await rows()).toHaveLength(0);
        expect(await listLogins(OWNER)).toStrictEqual({ logins: [], userId: OWNER });
    });

    it("refuses a save on the shared root shard, which the user's export and erasure never read", async () => {
        await runInShard(ROOT_SHARD_KEY, async () => {
            await expect(save({ password: PASSWORD })).rejects.toThrow(OWN_ACCOUNT_ONLY);
            expect(await listLogins(OWNER)).toStrictEqual({ logins: [], userId: OWNER });
        });
        expect(await rows()).toHaveLength(0);
    });

    it("saves on the root shard while development runs every user there, where export and erasure read too", async () => {
        workerEnv.ENVIRONMENT = "development";
        workerEnv.SHARD_ROUTING = "off";

        try {
            await runInShard(ROOT_SHARD_KEY, async () => {
                await save({ password: PASSWORD });
                const listed = await listLogins(OWNER);

                expect(listed.logins).toHaveLength(1);
            });
        } finally {
            delete workerEnv.ENVIRONMENT;
            delete workerEnv.SHARD_ROUTING;
        }
    });
});

describe("while an admin impersonates the owner", () => {
    it("refuses a new login", async () => {
        impersonation.by = "admin-1";

        await expect(save({ password: PASSWORD })).rejects.toThrow(SAVE_WHILE_IMPERSONATING);
        expect(await rows()).toHaveLength(0);
    });

    it("refuses to swap a saved login's username or password, or to add a teammate to it", async () => {
        const id = await save({ password: PASSWORD });
        const [before] = await rows();

        impersonation.by = "admin-1";

        await expect(save({ loginId: id, password: "planted", username: "admin@example.com" })).rejects.toThrow(SAVE_WHILE_IMPERSONATING);
        await expect(save({ loginId: id, teammateIds: [botId] })).rejects.toThrow(SAVE_WHILE_IMPERSONATING);
        expect(await rows()).toStrictEqual([before]);
    });

    it("refuses to delete a login, and still lists them without the password", async () => {
        const id = await save({ password: PASSWORD });

        impersonation.by = "admin-1";

        await expect(as(OWNER).mutation(deleteSiteLogin as never, { loginId: id } as never)).rejects.toThrow(DELETE_WHILE_IMPERSONATING);
        expect(await rows()).toHaveLength(1);

        const listed = await listLogins(OWNER);

        expect(listed.logins).toHaveLength(1);
        expect(JSON.stringify(listed)).not.toContain(PASSWORD);
    });

    it("the owner signed in as themselves still saves, edits and deletes", async () => {
        const id = await save({ password: PASSWORD });

        await save({ loginId: id, password: "changed", teammateIds: [botId], username: "ada2@example.com" });
        const [edited] = await rows();

        expect(edited?.["username"]).toBe("ada2@example.com");
        expect(edited?.["teammateIds"]).toStrictEqual([botId]);

        await as(OWNER).mutation(deleteSiteLogin as never, { loginId: id } as never);
        expect(await rows()).toHaveLength(0);
    });
});

describe("which chats may use a login", () => {
    it("the user's own chats use every login; the model's list carries only site and label", async () => {
        await save({ label: "Work", password: PASSWORD });

        const list = await usable(plainThread);

        expect(list).toStrictEqual([{ label: "Work", site: SITE }]);
        expect(JSON.stringify(list)).not.toContain("ada@example.com");
    });

    it("a teammate without access cannot use the login; one named on it can", async () => {
        await save({ password: PASSWORD, teammateIds: [botId] });

        expect(await usable(otherBotThread)).toStrictEqual([]);
        expect(await forFill(otherBotThread)).toBeNull();
        expect(await usable(botThread)).toStrictEqual([{ site: SITE }]);
        const login = await forFill(botThread);

        expect(login?.username).toBe("ada@example.com");
    });

    it("a login naming no teammate is for the user's own chats only", async () => {
        await save({ password: PASSWORD });

        expect(await usable(botThread)).toStrictEqual([]);
    });

    it("a teammate that was deleted no longer uses it, and nobody else's thread does", async () => {
        await save({ password: PASSWORD, teammateIds: [botId] });
        await harness.run(async (ctx: any) => await ctx.db.delete("bots", botId));

        expect(await usable(botThread)).toStrictEqual([]);
        expect(await usable(plainThread, STRANGER)).toStrictEqual([]);
    });

    it("a turn someone else started gets none, even in the owner's thread", async () => {
        await save({ password: PASSWORD });

        expect(await usable(plainThread, OWNER, STRANGER)).toStrictEqual([]);
        expect(await forFill(plainThread, SITE, OWNER, STRANGER)).toBeNull();
    });

    it("a thread other people can write in or read gets none: shared, public, a group chat, a messenger conversation, deleted", async () => {
        await save({ password: PASSWORD, teammateIds: [botId] });

        const shared = await insertThread({});

        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threadAccess", {
                    grantedAt: 1,
                    grantedBy: OWNER,
                    ownerId: OWNER,
                    permission: "write",
                    threadId: shared,
                    userId: STRANGER,
                }),
        );

        const others = [
            shared,
            await insertThread({ isPublic: true }),
            await insertThread({ groupChat: { mode: "round-robin", participants: [] } }),
            await insertThread({ botId, externalThreadId: "chat-42" }),
            await insertThread({ deleted: true }),
        ];

        for (const threadId of others) {
            expect(await usable(threadId)).toStrictEqual([]);
            expect(await forFill(threadId)).toBeNull();
        }
    });

    it("the fill matches the saved origin exactly: no subdomain, other port or lookalike", async () => {
        await save({ password: PASSWORD });

        for (const site of ["https://login.example.com", "https://example.com:8443", "https://example.com.evil.test", "https://example.com.", INSECURE_SITE]) {
            expect(await forFill(plainThread, site)).toBeNull();
        }

        const login = await forFill(plainThread, "https://example.com/sign-in");

        expect(login?.site).toBe(SITE);
    });
});

describe("GDPR", () => {
    it("the export lists the site, the username and the teammates that may use it, never the password", async () => {
        await save({ password: PASSWORD, teammateIds: [botId] });

        const exported = await harness.run(async (ctx: any) => await ctx.runQuery(collectFiles, { userId: OWNER }));

        expect(exported.siteLogins).toStrictEqual([
            { createdAt: expect.any(Number), site: SITE, teammateIds: [botId], updatedAt: expect.any(Number), username: "ada@example.com" },
        ]);
        expect(JSON.stringify(exported)).not.toContain(PASSWORD);
        expect(JSON.stringify(exported)).not.toContain("v1:");
    });

    it("account deletion removes them", async () => {
        await save({ password: PASSWORD });
        await harness.run(async (ctx: any) => {
            let result = await eraseVaultForUser(ctx, OWNER);

            while (result.hasMore) {
                result = await eraseVaultForUser(ctx, OWNER);
            }
        });

        expect(await rows()).toHaveLength(0);
    });
});
