/**
 * The two public import procedures, called as a signed-in user: input bounds, the declared
 * output shape, and the shared rate limit.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { importMemoryFile, previewMemoryImport, saveImportedMemories } from "./import";
import { MEMORY_FILE_INLINE_MAX_ENTRIES, MEMORY_FILE_MAX_BYTES } from "./import-file-logic";
import { IMPORT_MAX_FACTS, IMPORT_MAX_INPUT_CHARS } from "./import-logic";

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

    describe("importMemoryFile", () => {
        const byText = (a: string, b: string): number => a.localeCompare(b);
        const rowsOf = async (): Promise<{ memory: string; source: string; type: string }[]> =>
            await harness.run(async (ctx: any) => await ctx.db.query("memories").collect());
        const stored = async (): Promise<string[]> => {
            const rows = await rowsOf();

            return rows.map((row) => row.memory).toSorted(byText);
        };

        it("imports a small text file, counting duplicates in the file and against stored memories", async () => {
            expect.assertions(2);

            await call(saveImportedMemories, { app: "claude", facts: [FACT] });

            const text = `- ${FACT.memory.toUpperCase()}\n- The user likes green tea\n- the user LIKES green  tea\nToo short\n${"x ".repeat(300)}`;

            await expect(call(importMemoryFile, { content: text, format: "text" })).resolves.toStrictEqual({
                duplicates: 2,
                imported: 1,
                invalid: 1,
                tooLong: 1,
                updated: 0,
            });
            await expect(stored()).resolves.toStrictEqual([FACT.memory, "The user likes green tea"].toSorted(byText));
        });

        it("skips a stored memory repeated in full-width letters", async () => {
            expect.assertions(2);

            await call(saveImportedMemories, { app: "claude", facts: [{ memory: "The user likes green tea", type: "preference" }] });

            await expect(call(importMemoryFile, { content: "Ｔｈｅ ｕｓｅｒ ｌｉｋｅｓ ｇｒｅｅｎ ｔｅａ", format: "text" })).resolves.toMatchObject({
                duplicates: 1,
                imported: 0,
            });
            await expect(stored()).resolves.toStrictEqual(["The user likes green tea"]);
        });

        it("imports a JSON file as source imported, with the type it names", async () => {
            expect.assertions(2);

            await expect(
                call(importMemoryFile, {
                    content: JSON.stringify([{ content: "The user is a nurse in Hamburg", type: "identity" }, "The user likes tea"]),
                    format: "json",
                }),
            ).resolves.toMatchObject({ imported: 2 });

            const rows = await rowsOf();

            expect(rows.map((row) => `${row.source}:${row.type}`).toSorted(byText)).toStrictEqual(["imported:context", "imported:identity"]);
        });

        it("writes a file of exactly the inline limit whole", async () => {
            expect.assertions(1);

            const count = MEMORY_FILE_INLINE_MAX_ENTRIES;
            const content = Array.from({ length: count }, (_, index) => `The user has hobby number ${String(index)}`).join("\n");

            await expect(call(importMemoryFile, { content, format: "text" })).resolves.toMatchObject({ imported: count });
        });

        it("refuses a file over the inline limit with a message about later support, and writes nothing", async () => {
            expect.assertions(2);

            const content = Array.from({ length: MEMORY_FILE_INLINE_MAX_ENTRIES + 1 }, (_, index) => `The user has hobby number ${String(index)}`).join("\n");

            await expect(call(importMemoryFile, { content, format: "text" })).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: expect.stringContaining("later change"),
            });
            await expect(stored()).resolves.toStrictEqual([]);
        });

        it("refuses a malformed or wrongly shaped file with a clear error", async () => {
            expect.assertions(3);

            await expect(call(importMemoryFile, { content: "{ nope", format: "json" })).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: "The file is not valid JSON.",
            });
            await expect(call(importMemoryFile, { content: '{"a":1}', format: "json" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
            await expect(call(importMemoryFile, { content: "\n\n", format: "text" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        });

        it("refuses an oversize file and an unknown format at the boundary", async () => {
            expect.assertions(2);

            await expect(call(importMemoryFile, { content: "x".repeat(MEMORY_FILE_MAX_BYTES + 1), format: "text" })).rejects.toMatchObject({
                code: "VALIDATION_ERROR",
                message: expect.stringContaining("larger than 1 MB"),
            });
            await expect(call(importMemoryFile, { content: "The user likes tea", format: "csv" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });

        it("refuses while memory is off, and shares the import's hourly limit", async () => {
            expect.assertions(2);

            await harness.run(async (ctx: any) => {
                const settings = await ctx.db.query("userSettings").first();

                await ctx.db.patch("userSettings", settings._id, { memoryEnabled: false });
            });

            await expect(call(importMemoryFile, { content: "The user likes tea", format: "text" })).rejects.toMatchObject({ code: "FORBIDDEN" });

            for (let index = 0; index < 9; index += 1) {
                await call(importMemoryFile, { content: "The user likes tea", format: "text" }).catch(() => {});
            }

            await expect(call(importMemoryFile, { content: "The user likes tea", format: "text" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
        });
    });

    it("shares one hourly limit between preview and save", async () => {
        expect.assertions(1);

        for (let index = 0; index < 10; index += 1) {
            await call(saveImportedMemories, { app: "other", facts: [FACT] });
        }

        await expect(call(previewMemoryImport, { text: FACT.memory })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    });
});
