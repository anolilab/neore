/**
 * A host-run thread is never shared, made public or turned into a group chat (plans/acp-agent-host.md §5.1): a
 * grant or a public copy would let someone else's request reach a computer that never agreed to answer it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
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

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/internal", async (importOriginal) => {
    const { registeredApi } = await import("../../test/registered-api");

    return registeredApi(await importOriginal(), registry);
});

const { registerModule } = await import("../../test/registered-api");
const { default: schema } = await import("../schema");
const sharing = await import("../chat/sharing");
const group = await import("../chat/group/functions");

registerModule(registry, "agent_sharing", await import("../agent/sharing"));
registerModule(registry, "agent_threads", await import("../agent/threads"));
registerModule(registry, "chat_sharing", sharing);
registerModule(registry, "lib_shard_routes", await import("../lib/shard-routes"));

const COMPUTER = /runs on your computer/u;

let harness: ReturnType<typeof lunoraTest>;
let ownerId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertThread = async (fields: Record<string, unknown> = {}) =>
    (await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { createdBy: ownerId, status: "active", title: "t", updatedAt: 1, userId: ownerId, ...fields }),
    )) as string;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    ownerId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("user", { createdAt: 0, email: "owner@example.com", emailVerified: true, name: "O", updatedAt: 0 }),
    )) as string;
});

afterEach(() => {
    harness.close();
});

describe("a host-run thread", () => {
    it("takes no invite", async () => {
        const threadId = await insertThread({ runner: "host" });
        const invite = { expirationType: "1_day", invitedEmail: "friend@example.com", permission: "read", threadId };

        await expect(as(ownerId).mutation(sharing.createThreadInvite as never, invite as never)).rejects.toThrow(COMPUTER);
    });

    it("cannot be made public", async () => {
        const threadId = await insertThread({ runner: "host" });

        await expect(as(ownerId).mutation(sharing.toggleThreadVisibility as never, { isPublic: true, threadId } as never)).rejects.toThrow(COMPUTER);
    });

    it("cannot be turned into a group chat", async () => {
        const threadId = await insertThread({ runner: "host" });

        await expect(
            as(ownerId).mutation(group.updateGroupChat as never, { mode: "round-robin", skillIds: ["skill-a", "skill-b"], threadId } as never),
        ).rejects.toThrow(COMPUTER);
    });

    it("can still be made private", async () => {
        const threadId = await insertThread({ runner: "host" });

        await expect(as(ownerId).mutation(sharing.toggleThreadVisibility as never, { isPublic: false, threadId } as never)).resolves.toMatchObject({
            isPublic: false,
        });
    });
});

describe("a cloud thread", () => {
    it("is shared and made public as before", async () => {
        const threadId = await insertThread();
        const invite = { expirationType: "1_day", invitedEmail: "friend@example.com", permission: "read", threadId };

        await expect(as(ownerId).mutation(sharing.createThreadInvite as never, invite as never)).resolves.toHaveProperty("inviteToken");
        await expect(as(ownerId).mutation(sharing.toggleThreadVisibility as never, { isPublic: true, threadId } as never)).resolves.toMatchObject({
            isPublic: true,
        });
    });
});
