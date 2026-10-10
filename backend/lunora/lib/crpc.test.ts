import { v } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { authAction, authMutation, authQuery, liteAuthQuery, optionalAuthQuery, publicQuery, requireDevelopment } from "./crpc";

// The deploy sets `ENVIRONMENT` to "production" or "preview" (`alchemy.run.ts`).
vi.mock("../env", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../env")>()), ENVIRONMENT: "production" };
});

const USER = { isAdmin: false, plan: "free", userId: "user-1" };

// Session resolution is not under test here — only which middleware runs.
vi.mock("./crpc-auth-helpers", async (importOriginal) => {
    const fake = async () => USER;

    return {
        ...(await importOriginal<typeof import("./crpc-auth-helpers")>()),
        getSessionUser: fake,
        getSessionUserForQuery: fake,
        getSessionUserForQueryLite: fake,
        getSessionUserWithAnonymous: fake,
    };
});

/**
 * A registered procedure is `{ args, handler(ctx, args), kind }` at runtime. The
 * guarded builders wrap `ctx.db` for row-level security, so the context carries
 * an (empty) one — the handlers here never read it.
 */
const invoke = async (procedure: unknown): Promise<unknown> =>
    (procedure as { handler: (context: object, args: object) => Promise<unknown> }).handler({ db: {} }, {});

describe("procedure builders in production", () => {
    it.each([
        [
            "publicQuery",
            publicQuery
                .input({})
                .output(v.string())
                .query(async () => "ok"),
        ],
        [
            "optionalAuthQuery",
            optionalAuthQuery
                .input({})
                .output(v.string())
                .query(async () => "ok"),
        ],
        [
            "authQuery",
            authQuery
                .input({})
                .output(v.string())
                .query(async () => "ok"),
        ],
        [
            "liteAuthQuery",
            liteAuthQuery
                .input({})
                .output(v.string())
                .query(async () => "ok"),
        ],
        [
            "authMutation",
            authMutation
                .input({})
                .output(v.string())
                .mutation(async () => "ok"),
        ],
        [
            "authAction",
            authAction
                .input({})
                .output(v.string())
                .action(async () => "ok"),
        ],
    ])("%s is not blocked by the development guard", async (_name, procedure) => {
        await expect(invoke(procedure)).resolves.toBe("ok");
    });

    it.each([
        [
            "authQuery",
            authQuery
                .use(requireDevelopment())
                .input({})
                .output(v.string())
                .query(async () => "ok"),
        ],
        [
            "authMutation",
            authMutation
                .use(requireDevelopment())
                .input({})
                .output(v.string())
                .mutation(async () => "ok"),
        ],
        [
            "authAction",
            authAction
                .use(requireDevelopment())
                .input({})
                .output(v.string())
                .action(async () => "ok"),
        ],
    ])("%s with an explicit requireDevelopment() is rejected", async (_name, procedure) => {
        await expect(invoke(procedure)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});

