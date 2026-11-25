/**
 * Redeeming a thread invite only ever raises access: a grantee who redeems a
 * weaker link keeps what they have, and one who redeems a stronger link gets it.
 * Lowering access goes through the grant editors.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { deleteShardRoute, setShardRoute } from "../lib/shard-routes";
import schema from "../schema";
import { setThreadFollowState } from "./follows/functions";
import { acceptThreadInvite, createThreadInvite } from "./sharing";

const registry = vi.hoisted(() => new Map<string, unknown>());
/** The invitee's id, for the mocks hoisted above the test's own state. */
const GRANTEE_ID = vi.hoisted(() => {
    return { value: "" };
});
/** Runs right after the accept's grant and follow writes, before its second merge check: where a merge mark can land. */
const afterFollow = vi.hoisted(() => {
    return { run: undefined as ((context: any) => Promise<void>) | undefined };
});
/**
 * The follow rows the accept wrote and the ones it took back. In production each committed on its own; the harness
 * keeps them in the caller's transaction, which a refusal rolls back, so the calls are what is checked.
 */
const follows = vi.hoisted(() => {
    return { after: [] as (string | null)[], removed: [] as unknown[], written: [] as unknown[] };
});

vi.mock("./follows/functions", async (importOriginal) => {
    const original = await importOriginal<typeof import("./follows/functions")>();

    return {
        ...original,
        ensureThreadFollowDefault: async (...args: Parameters<typeof original.ensureThreadFollowDefault>) => {
            const written = await original.ensureThreadFollowDefault(...args);

            if (args[1].userId === GRANTEE_ID.value) {
                follows.written.push(written);
            }

            await afterFollow.run?.(args[0]);

            return written;
        },
        withdrawThreadFollowDefault: async (...args: Parameters<typeof original.withdrawThreadFollowDefault>) => {
            follows.removed.push(args[1]);

            const withdrawn = await original.withdrawThreadFollowDefault(...args);
            // The row as the take-back left it, read in its transaction: the harness rolls the refused accept back after.
            const row = await args[0].db.threadFollows.findFirst({ consistency: "primary", where: { _id: args[1].id } });

            follows.after.push(row?.state ?? null);

            return withdrawn;
        },
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "chat_sharing", await import("./sharing"));
    registerModule(registry, "agent_sharing", await import("../agent/sharing"));
});

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: null,
                      email: `${context.auth.userId}@example.com`,
                      id: context.auth.userId,
                      isAdmin: false,
                      name: context.auth.userId,
                      userId: context.auth.userId,
                  }
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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

let harness: ReturnType<typeof lunoraTest>;
let OWNER: string;
let GRANTEE: string;

const insertUser = async (isAnonymous = false): Promise<string> =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("user", {
                createdAt: 0,
                email: `${String(Math.random())}@example.com`,
                emailVerified: false,
                isAnonymous,
                name: "U",
                updatedAt: 0,
            }),
    )) as string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const newThread = async (): Promise<string> =>
    await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

const giveAccess = async (threadId: string, permission: string, revision?: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("threadAccess", {
            grantedAt: Date.now(),
            grantedBy: OWNER,
            ownerId: OWNER,
            permission,
            ...(revision !== undefined && { revision }),
            threadId,
            userId: GRANTEE,
        });
    });
};

const permissionOf = async (threadId: string): Promise<string | undefined> =>
    await harness.run(async (ctx: any) => {
        const rows = (await ctx.db.query("threadAccess").collect()) as { permission: string; threadId: string; userId: string }[];

        return rows.find((row) => row.threadId === threadId && row.userId === GRANTEE)?.permission;
    });

/** The invitee's follow states for a chat (the sharer follows it too, from the invite). */
const followsOf = async (threadId: string): Promise<string[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = (await ctx.db.threadFollows.findMany({ where: { threadId, userId: GRANTEE } })) as { page: { state: string }[] };

        return page.map((row) => row.state);
    });

const redeem = async (threadId: string, permission: string): Promise<{ permission: string }> => {
    const { inviteToken } = (await as(OWNER).mutation(
        createThreadInvite as never,
        { expirationType: "1_day", invitedEmail: "grantee@example.com", permission, threadId } as never,
    )) as { inviteToken: string };

    return (await as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)) as { permission: string };
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    OWNER = await insertUser();
    GRANTEE = await insertUser();
    GRANTEE_ID.value = GRANTEE;
    follows.after = [];
    follows.removed = [];
    follows.written = [];
});

afterEach(() => {
    afterFollow.run = undefined;
    harness.close();
});

describe("acceptThreadInvite", () => {
    it("keeps a write grant when a read invite is redeemed", async () => {
        const threadId = await newThread();

        await giveAccess(threadId, "write");

        await expect(redeem(threadId, "read")).resolves.toMatchObject({ permission: "write" });
        await expect(permissionOf(threadId)).resolves.toBe("write");
    });

    it("raises a read grant when a write invite is redeemed", async () => {
        const threadId = await newThread();

        await giveAccess(threadId, "read");

        await expect(redeem(threadId, "write")).resolves.toMatchObject({ permission: "write" });
        await expect(permissionOf(threadId)).resolves.toBe("write");
    });

    it("creates the grant when there is none", async () => {
        const threadId = await newThread();

        await expect(redeem(threadId, "read")).resolves.toMatchObject({ permission: "read" });
        await expect(permissionOf(threadId)).resolves.toBe("read");
    });

    it("refuses a guest deleted by its merge, whose mark is gone, and leaves no grant", async () => {
        const threadId = await newThread();
        const { inviteToken } = (await as(OWNER).mutation(
            createThreadInvite as never,
            { expirationType: "1_day", invitedEmail: "grantee@example.com", permission: "read", threadId } as never,
        )) as { inviteToken: string };
        const guest = await insertUser(true);

        // The guest's merge finished: the guest is deleted and its mark gone, but a token issued before still names it.
        await harness.run(async (ctx: any) => await ctx.db.delete("user", guest));

        await expect(as(guest).mutation(acceptThreadInvite as never, { inviteToken } as never)).rejects.toThrow("moved to a signed-in account");

        const rows = (await harness.run(async (ctx: any) => await ctx.db.query("threadAccess").collect())) as { userId: string }[];

        expect(rows.filter((row) => row.userId === guest)).toStrictEqual([]);
    });

    it.each([
        ["with no grant", undefined],
        ["with a read grant", "read"],
    ])("refuses an invite to a chat whose owner is a merging guest, %s, and leaves it pending", async (_case, existing) => {
        const threadId = await newThread();

        if (existing !== undefined) {
            await giveAccess(threadId, existing);
        }

        const { inviteToken } = (await as(OWNER).mutation(
            createThreadInvite as never,
            { expirationType: "1_day", invitedEmail: "grantee@example.com", permission: "write", threadId } as never,
        )) as { inviteToken: string };

        // The owner's merge has started: the invite still names the guest, whose shard the merge empties.
        await harness.run(async (ctx: any) => await setShardRoute(ctx, "merged-guest", OWNER, "owner-account"));

        await expect(as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)).rejects.toThrow("moving to its owner's signed-in account");
        await expect(permissionOf(threadId)).resolves.toBe(existing);
        // No follow of a chat the invitee did not join: the one the accept wrote is taken back.
        expect(follows.removed).toStrictEqual(follows.written.filter((id) => id !== null));

        const invites = (await harness.run(async (ctx: any) => await ctx.db.threadInvites.findMany({ where: { threadId } }))) as { page: { status: string }[] };

        expect(invites.page.map((row) => row.status)).toStrictEqual(["pending"]);
    });

    it.each([
        ["takes back the grant it created", undefined],
        ["puts back the role it raised", "read"],
    ])("when the owner's merge starts after the grant is written, %s and leaves the invite pending", async (_case, existing) => {
        const threadId = await newThread();

        if (existing !== undefined) {
            await giveAccess(threadId, existing);
        }

        const accessId = await harness.run(async (ctx: any) => {
            const rows = (await ctx.db.query("threadAccess").collect()) as { _id: string; threadId: string }[];

            return rows.find((row) => row.threadId === threadId)?._id;
        });
        const { inviteToken } = (await as(OWNER).mutation(
            createThreadInvite as never,
            { expirationType: "1_day", invitedEmail: "grantee@example.com", permission: "write", threadId } as never,
        )) as { inviteToken: string };
        const undone: unknown[] = [];

        // The mark lands between the accept's grant write (which checked it and found none) and its second check. In
        // production the grant write committed on its own; the harness keeps nested writes in the caller's transaction, so
        // the call taking it back is what is checked here, and `undoInviteGrant` below shows what that call does.
        afterFollow.run = async (context) => {
            const runMutation = context.runMutation.bind(context);

            context.runMutation = async (reference: unknown, args: unknown) => {
                if (reference === registry.get("agent_sharing:undoInviteGrant")) {
                    undone.push(args);
                }

                return await runMutation(reference, args);
            };

            await setShardRoute(context, "merged-guest", OWNER, "owner-account");
        };

        await expect(as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)).rejects.toThrow("moving to its owner's signed-in account");
        await expect(permissionOf(threadId)).resolves.toBe(existing);
        // No follow of a chat the invitee did not join: the one the accept wrote is taken back.
        expect(follows.removed).toStrictEqual(follows.written.filter((id) => id !== null));

        expect(undone).toStrictEqual([
            existing === undefined
                ? { accessId: expect.any(String), revision: expect.any(Number) }
                : { accessId, previous: existing, revision: expect.any(Number) },
        ]);

        const invites = (await harness.run(async (ctx: any) => await ctx.db.threadInvites.findMany({ where: { threadId } }))) as { page: { status: string }[] };

        expect(invites.page.map((row) => row.status)).toStrictEqual(["pending"]);
    });

    it("keeps a follow the invitee chose before when the owner's merge starts after the grant is written", async () => {
        const threadId = await newThread();
        const { inviteToken } = (await as(OWNER).mutation(
            createThreadInvite as never,
            { expirationType: "1_day", invitedEmail: "grantee@example.com", permission: "write", threadId } as never,
        )) as { inviteToken: string };

        await harness.run(async (ctx: any) => await ctx.db.insert("threadFollows", { createdAt: 0, state: "muted", threadId, updatedAt: 0, userId: GRANTEE }));

        afterFollow.run = async (context) => {
            await setShardRoute(context, "merged-guest", OWNER, "owner-account");
        };

        await expect(as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)).rejects.toThrow("moving to its owner's signed-in account");
        await expect(followsOf(threadId)).resolves.toStrictEqual(["muted"]);
        expect(follows.written).toStrictEqual([null]);
        expect(follows.removed).toStrictEqual([]);
    });

    it("takes back the unchanged follow default when the owner's merge starts after the accept wrote it", async () => {
        const threadId = await newThread();
        const { inviteToken } = (await as(OWNER).mutation(
            createThreadInvite as never,
            { expirationType: "1_day", invitedEmail: "grantee@example.com", permission: "write", threadId } as never,
        )) as { inviteToken: string };

        afterFollow.run = async (context) => {
            await setShardRoute(context, "merged-guest", OWNER, "owner-account");
        };

        await expect(as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)).rejects.toThrow("moving to its owner's signed-in account");
        expect(follows.written).toStrictEqual([expect.objectContaining({ state: "on" })]);
        // The default the accept wrote is gone once the take-back ran.
        expect(follows.after).toStrictEqual([null]);
    });

    it("keeps a follow the invitee changed after the accept wrote its default, when the owner's merge starts", async () => {
        const threadId = await newThread();
        const { inviteToken } = (await as(OWNER).mutation(
            createThreadInvite as never,
            { expirationType: "1_day", invitedEmail: "grantee@example.com", permission: "write", threadId } as never,
        )) as { inviteToken: string };

        // The invitee mutes the chat in the same millisecond the default was written, then the merge mark lands.
        afterFollow.run = async (context) => {
            await setThreadFollowState(context, { now: context.now, state: "muted", threadId: threadId as never, userId: GRANTEE });
            await setShardRoute(context, "merged-guest", OWNER, "owner-account");
        };

        await expect(as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)).rejects.toThrow("moving to its owner's signed-in account");
        expect(follows.removed).toHaveLength(1);
        // Their choice outlives the take-back of the default.
        expect(follows.after).toStrictEqual(["muted"]);
    });

    it("keeps a follow the invitee set back to the default's own state after the accept wrote it", async () => {
        const threadId = await newThread();
        const { inviteToken } = (await as(OWNER).mutation(
            createThreadInvite as never,
            { expirationType: "1_day", invitedEmail: "grantee@example.com", permission: "write", threadId } as never,
        )) as { inviteToken: string };

        // An explicit "on" matches the default's state: the later stamp is what tells it apart.
        afterFollow.run = async (context) => {
            await setThreadFollowState(context, { now: context.now, state: "on", threadId: threadId as never, userId: GRANTEE });
            await setShardRoute(context, "merged-guest", OWNER, "owner-account");
        };

        await expect(as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)).rejects.toThrow("moving to its owner's signed-in account");
        expect(follows.after).toStrictEqual(["on"]);
    });

    it("refuses once it saw the owner's merge mark, even when the merge ends before a second look", async () => {
        const threadId = await newThread();
        const { inviteToken } = (await as(OWNER).mutation(
            createThreadInvite as never,
            { expirationType: "1_day", invitedEmail: "grantee@example.com", permission: "write", threadId } as never,
        )) as { inviteToken: string };

        // The mark lands after the grant write; the merge then ends (its mark goes last) while the grant is taken back.
        let markGone = false;

        afterFollow.run = async (context) => {
            const runMutation = context.runMutation.bind(context);

            context.runMutation = async (reference: unknown, args: unknown) => {
                const result = await runMutation(reference, args);

                if (reference === registry.get("agent_sharing:undoInviteGrant")) {
                    await deleteShardRoute(context, "merged-guest", OWNER);
                    markGone = true;
                }

                return result;
            };

            await setShardRoute(context, "merged-guest", OWNER, "owner-account");
        };

        await expect(as(GRANTEE).mutation(acceptThreadInvite as never, { inviteToken } as never)).rejects.toThrow("moving to its owner's signed-in account");
        // The merge did end during this accept, before its refusal: the refusal rests on the mark it saw, not a second look.
        expect(markGone).toBe(true);

        const invites = (await harness.run(async (ctx: any) => await ctx.db.threadInvites.findMany({ where: { threadId } }))) as { page: { status: string }[] };

        expect(invites.page.map((row) => row.status)).toStrictEqual(["pending"]);
    });
});

describe("raiseInviteGrant", () => {
    const raise = async (accessId: string, permission: string) =>
        await harness.run(async (ctx: any) => await ctx.runMutation(registry.get("agent_sharing:raiseInviteGrant"), { accessId, permission }));
    const accessOf = async (threadId: string) =>
        await harness.run(async (ctx: any) => {
            const rows = (await ctx.db.query("threadAccess").collect()) as { _id: string; revision?: number; threadId: string }[];

            return rows.find((row) => row.threadId === threadId)!;
        });

    it("records the role the write replaced, not one an earlier read saw", async () => {
        const threadId = await newThread();

        // The accept read `read`; a change since made it `write`, which is what the write replaces and an undo restores.
        await giveAccess(threadId, "write", 2);

        const { _id } = await accessOf(threadId);

        await expect(raise(_id, "admin")).resolves.toStrictEqual({ kind: "raised", previous: "write", revision: 3 });
        await expect(permissionOf(threadId)).resolves.toBe("admin");
    });

    it("keeps a grant that already gives as much, writing nothing", async () => {
        const threadId = await newThread();

        await giveAccess(threadId, "admin", 2);

        const { _id } = await accessOf(threadId);

        await expect(raise(_id, "write")).resolves.toStrictEqual({ kind: "kept", permission: "admin" });
        await expect(accessOf(threadId)).resolves.toMatchObject({ revision: 2 });
    });
});

describe("undoInviteGrant", () => {
    const grantOf = async (threadId: string) =>
        await harness.run(async (ctx: any) => {
            const rows = (await ctx.db.query("threadAccess").collect()) as { _id: string; threadId: string; userId: string }[];

            return rows.find((row) => row.threadId === threadId && row.userId === GRANTEE);
        });

    const undo = async (args: Record<string, unknown>) =>
        await harness.run(async (ctx: any) => await ctx.runMutation(registry.get("agent_sharing:undoInviteGrant"), args));

    it("removes a grant the accept created", async () => {
        const threadId = await newThread();

        await giveAccess(threadId, "write", 3);

        const { _id } = (await grantOf(threadId))!;

        await undo({ accessId: _id, revision: 3 });

        await expect(grantOf(threadId)).resolves.toBeUndefined();
    });

    it("puts back the role a grant had before the accept raised it", async () => {
        const threadId = await newThread();

        await giveAccess(threadId, "write", 3);

        const { _id } = (await grantOf(threadId))!;

        await undo({ accessId: _id, previous: "read", revision: 3 });

        await expect(permissionOf(threadId)).resolves.toBe("read");
    });

    it.each([
        ["removing the grant the accept created", undefined],
        ["putting back the role the accept raised", "read"],
    ])("keeps an administrator's write since the accept, with the same role, instead of %s", async (_case, previous) => {
        const threadId = await newThread();

        // The accept wrote revision 3; an administrator then wrote the grant again (same role, a new revision).
        await giveAccess(threadId, "write", 4);

        const { _id } = (await grantOf(threadId))!;

        await undo({ accessId: _id, ...(previous !== undefined && { previous }), revision: 3 });

        await expect(permissionOf(threadId)).resolves.toBe("write");
        await expect(grantOf(threadId)).resolves.toMatchObject({ revision: 4 });
    });
});
