/**
 * The session read behind an MCP app call's cap: a session that cannot be validated must not read as the personal space,
 * and a valid one gives its verified active organization.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { getSessionOrganizationForCap } from "./session-organization";

const USER = "user-a";
const HOUR_MS = 60 * 60 * 1000;

let harness: ReturnType<typeof lunoraTest>;

const insertSession = async (fields: { activeOrganizationId?: string; expiresAt: number; userId?: string }): Promise<string> =>
    await harness.run(
        async (ctx: any) => await ctx.db.insert("session", { createdAt: 0, token: `token-${String(Math.random())}`, updatedAt: 0, userId: USER, ...fields }),
    );

const read = async (sessionId: string, userId = USER): Promise<unknown> =>
    await harness.run(async (ctx: any) => await ctx.runQuery(getSessionOrganizationForCap, { sessionId, userId }));

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("getSessionOrganizationForCap", () => {
    it("gives the personal space for a valid session with no active organization", async () => {
        expect(await read(await insertSession({ expiresAt: Date.now() + HOUR_MS }))).toStrictEqual({ organizationId: null });
    });

    it("gives the active organization of a valid session whose user is still a member", async () => {
        await harness.run(async (ctx: any) => await ctx.db.insert("member", { createdAt: 0, organizationId: "org-a", role: "member", userId: USER }));

        const sessionId = await insertSession({ activeOrganizationId: "org-a", expiresAt: Date.now() + HOUR_MS });

        expect(await read(sessionId)).toStrictEqual({ organizationId: "org-a" });
    });

    it("cannot validate an expired session, another user's session or a missing one", async () => {
        const expired = await insertSession({ expiresAt: Date.now() - HOUR_MS });
        const someoneElses = await insertSession({ expiresAt: Date.now() + HOUR_MS, userId: "user-b" });

        expect(await read(expired)).toBeNull();
        expect(await read(someoneElses)).toBeNull();
        expect(await read("session-that-does-not-exist")).toBeNull();
    });
});
