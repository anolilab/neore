/**
 * The two public import procedures, called as a signed-in user: input bounds, the declared
 * output shape, and the shared rate limit.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { IMPORT_MAX_FACTS, IMPORT_MAX_INPUT_CHARS } from "./import-logic";
import { previewMemoryImport, saveImportedMemories } from "./import";

const { generateText, registry, sessionFrom } = vi.hoisted(() => {
    return {
        generateText: vi.fn(),
        registry: new Map<string, unknown>(),
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, plan: null, role: null, userId: context.auth.userId }
                : null,
    };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});
vi.mock("../chat/lib/model-filter-rules", () => {
    return {
        getUtilityModelForUser: async () => {
            return {};
        },
        loadModelFilterRules: async () => {
            return {};
        },
    };
});
vi.mock("../lib/utility-model", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/utility-model")>()),
        getUtilityModel: async () => {
            return {};
        },
    };
});
vi.mock("../lib/services", () => {
    return { gatewayFetch: () => async () => new Response("{}") };
});
vi.mock("../agent/client/search", () => {
    return {
        embedMany: async () => {
            throw new Error("no embeddings in this test");
        },
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

const USER = "user-a";
const FACT = { memory: "The user is a nurse in Hamburg", type: "identity" as const };

let harness: ReturnType<typeof lunoraTest>;

const call = async (procedure: unknown, args: object): Promise<unknown> =>
    await harness.withIdentity({ userId: USER } as never).action(procedure as never, args as never);

beforeAll(async () => {
    registerModule(registry, "memory_functions", await import("./functions"));
    registerModule(registry, "lib_rate_limiter_mutations", await import("../lib/rate-limiter-mutations"));
});

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });
    });
});

afterEach(() => {
    harness.close();
    generateText.mockReset();
});

describe("memory import procedures", () => {
    it("previews and saves through the declared output shapes", async () => {
        expect.assertions(2);

        generateText.mockResolvedValue({ output: { keep: [{ line: 1, type: "identity" }] } });

        await expect(call(previewMemoryImport, { text: `- ${FACT.memory}\nHere is what I know` })).resolves.toStrictEqual({
            cut: 0,
            dropped: 1,
            facts: [FACT],
        });
        await expect(call(saveImportedMemories, { app: "claude", facts: [FACT] })).resolves.toStrictEqual({ added: 1, alreadyKnown: 0, updated: 0 });
    });

    it("refuses a paste or a fact list past its bound before any model call", async () => {
        expect.assertions(3);

        await expect(call(previewMemoryImport, { text: "x".repeat(IMPORT_MAX_INPUT_CHARS + 1) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
            call(saveImportedMemories, {
                app: "claude",
                facts: Array.from({ length: IMPORT_MAX_FACTS + 1 }, (_, index) => {
                    return { ...FACT, memory: `${FACT.memory} ${String(index)}` };
                }),
            }),
        ).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
        expect(generateText).not.toHaveBeenCalled();
    });

    it("shares one hourly limit between preview and save", async () => {
        expect.assertions(1);

        for (let index = 0; index < 10; index += 1) {
            await call(saveImportedMemories, { app: "other", facts: [FACT] });
        }

        await expect(call(previewMemoryImport, { text: FACT.memory })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    });
});
