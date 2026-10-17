/** The resume lookup finds an eligible thread however far down the activity list it sits. */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { latestResumableThread } from "./resume";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const OWNER = "user-owner";
const OUTSIDE_SCOPE = 650;

describe("latestResumableThread", () => {
    it("finds a thread more than 500 threads down, past other workspaces", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const target = await harness.run(async (context: any) => {
                // Newest first by updatedAt: 650 threads in another organization, then the personal one.
                for (let index = 0; index < OUTSIDE_SCOPE; index += 1) {
                    await context.db.insert("threads", {
                        model: "m",
                        organizationId: "org-other",
                        status: "active",
                        title: `o${String(index)}`,
                        updatedAt: 10_000 - index,
                        userId: OWNER,
                    });
                }

                return await context.db.insert("threads", { model: "m", status: "active", title: "mine", updatedAt: 1, userId: OWNER });
            });

            const result = await harness.withIdentity({ userId: OWNER }).query(latestResumableThread as never, { organizationId: null } as never);

            expect(result).toBe(target);
        } finally {
            harness.close();
        }
    });
});
