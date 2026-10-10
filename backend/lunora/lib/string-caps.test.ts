/**
 * `MAX_LENGTH` caps on client-reachable string arguments are enforced at the
 * argument boundary: an oversize value never reaches the handler.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { createProject } from "../projects/functions";
import schema from "../schema";
import { MAX_LENGTH } from "./validators";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "agent_projects", await import("../agent/projects"));
});

vi.mock("./crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { id: context.auth.userId, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("./crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const MENTIONS_TITLE = /title/iu;

describe("string argument caps", () => {
    it("rejects a title past its cap and stores one at the cap", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const as = harness.withIdentity({ userId: "user-1" });
            const atCap = "t".repeat(MAX_LENGTH.long);

            // Refused by the argument validator, not by anything the handler does.
            await expect(as.mutation(createProject as never, { title: `${atCap}x` } as never)).rejects.toThrow(MENTIONS_TITLE);

            const id = (await as.mutation(createProject as never, { title: atCap } as never)) as string;
            const stored = await harness.run(async (context: any) => await context.db.projects.findFirst({ where: { _id: id } }));

            expect(stored?.title).toHaveLength(MAX_LENGTH.long);
        } finally {
            harness.close();
        }
    });
});
