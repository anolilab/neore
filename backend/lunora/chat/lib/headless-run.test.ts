/**
 * What a headless run puts in front of the model. The agent is a stand-in whose
 * instructions come from the REAL system-prompt builder (`getSystemPrompt`),
 * exactly as `get-agent.ts` builds them, so the assertions are about the prompt
 * text a messenger sender's reply is generated from.
 */
import { getSystemPrompt } from "@neore/ai/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mappedReferences } from "../../../test/registered-api";

// A reference is read as its dispatch key, which the fake ctx below switches on.
vi.mock("../../_generated/api", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));
vi.mock("../../_generated/internal", async (importOriginal) => mappedReferences(await importOriginal(), (reference) => reference.__lunoraRef));

const seen = vi.hoisted(() => {
    return { buildOptions: [] as unknown[], failAt: undefined as "generate" | "keys" | "thread" | undefined, system: [] as string[], tools: [] as string[][] };
});

vi.mock("./get-agent", () => {
    return {
        default: async (
            _model: string,
            options: {
                language?: string;
                location?: string;
                personalization?: Parameters<typeof getSystemPrompt>[3];
                timezone?: string;
                tools?: Record<string, unknown>;
            },
        ) => {
            seen.tools.push(Object.keys(options.tools ?? {}));

            const instructions = getSystemPrompt(options.timezone, options.location, options.language, options.personalization);
            const thread = {
                generateText: async (args: { system?: string }) => {
                    if (seen.failAt === "generate") {
                        throw new Error("model call failed");
                    }

                    seen.system.push(args.system ?? instructions);

                    return { text: "reply" };
                },
            };

            return {
                continueThread: async () => {
                    return { thread };
                },
                createThread: async () => {
                    if (seen.failAt === "thread") {
                        throw new Error("thread creation failed");
                    }

                    return { thread, threadId: "thread-new" };
                },
                options: { instructions },
            };
        },
    };
});

vi.mock("./agent-tools", () => {
    return {
        buildAgentTools: async (_ctx: unknown, options: unknown) => {
            seen.buildOptions.push(options);

            return {
                mcpClients: [],
                mcpLabels: { mcp_notes_search: { serverName: "notes", toolName: "search" } },
                tools: { browser: {}, dateTime: {}, imageGeneration: {}, mcp_notes_search: {}, webSearch: {} },
            };
        },
    };
});

const { runHeadlessAgent } = await import("./headless-run");

const PREFS = {
    aboutMe: "SECRET-ABOUT-ME lives in Berlin with two cats",
    customInstructions: "SECRET-INSTRUCTIONS always sign as Captain",
    language: "en",
    location: "SECRET-LOCATION",
    memoryEnabled: false,
    nickname: "SECRET-NICKNAME",
    profession: "SECRET-PROFESSION",
};

const fakeCtx = () =>
    ({
        runAction: vi.fn(),
        runMutation: vi.fn(async () => null),
        runQuery: vi.fn(async (reference: string) => {
            if (reference === "auth_functions:getUserPreferencesQuery") {
                return PREFS;
            }

            if (reference === "auth_functions:getDecryptedProviderKeysQuery") {
                if (seen.failAt === "keys") {
                    throw new Error("provider keys unavailable");
                }

                return {};
            }

            throw new Error(`unexpected query ${reference}`);
        }),
        scheduler: { runAfter: vi.fn() },
    }) as never;

const SECRETS = ["SECRET-ABOUT-ME", "SECRET-NICKNAME", "SECRET-PROFESSION", "SECRET-INSTRUCTIONS", "SECRET-LOCATION"];

describe("runHeadlessAgent personalization", () => {
    beforeEach(() => {
        seen.system = [];
    });

    it("keeps the owner's personalization out of a messenger reply", async () => {
        await runHeadlessAgent(fakeCtx(), {
            maxSteps: 3,
            memory: false,
            model: "test-model",
            personalization: "none",
            thread: { threadId: "thread-1" },
            tools: "none",
            userId: "owner",
        });

        expect(seen.system).toHaveLength(1);

        for (const secret of SECRETS) {
            expect(seen.system[0]).not.toContain(secret);
        }
    });

    it("gives a run the user reads their full personalization", async () => {
        await runHeadlessAgent(fakeCtx(), {
            memory: false,
            model: "test-model",
            personalization: "full",
            prompt: "Do the thing",
            thread: { title: "Trigger: x" },
            tools: "none",
            userId: "owner",
        });

        for (const secret of SECRETS) {
            expect(seen.system[0]).toContain(secret);
        }
    });
});

describe("runHeadlessAgent tool allowlist", () => {
    beforeEach(() => {
        seen.buildOptions = [];
        seen.tools = [];
    });

    const run = async (extra: Partial<Parameters<typeof runHeadlessAgent>[1]>) =>
        await runHeadlessAgent(fakeCtx(), {
            maxSteps: 5,
            memory: false,
            model: "test-model",
            personalization: "none",
            thread: { threadId: "thread-1" },
            tools: "headless",
            userId: "owner",
            ...extra,
        });

    it("narrows to the allowlist and drops MCP tools unless told to keep them", async () => {
        await run({ toolAllowlist: ["webSearch", "imageGeneration"] });
        await run({ toolAllowlist: ["webSearch", "imageGeneration"], toolAllowlistKeepsMcp: true });

        expect(seen.tools).toStrictEqual([
            ["imageGeneration", "webSearch"],
            ["imageGeneration", "mcp_notes_search", "webSearch"],
        ]);
    });

    it("offers extra built-ins to the tool builder as candidates, headless", async () => {
        await run({ additionalTools: ["imageGeneration"], toolAllowlist: ["imageGeneration"] });

        expect(seen.buildOptions[0]).toMatchObject({ headless: true, skillTools: { additionalTools: ["imageGeneration"] } });
    });
});

describe("runHeadlessAgent onGenerationStart", () => {
    const run = async (onGenerationStart: () => void) =>
        await runHeadlessAgent(fakeCtx(), {
            memory: false,
            model: "test-model",
            onGenerationStart,
            personalization: "full",
            prompt: "Do the thing",
            thread: { title: "Trigger: x" },
            tools: "none",
            userId: "owner",
        });

    beforeEach(() => {
        seen.failAt = undefined;
    });

    it("is called once, right before the model is asked", async () => {
        const started = vi.fn();

        await run(started);

        expect(started).toHaveBeenCalledTimes(1);
    });

    it("is not called when the provider keys fail to load", async () => {
        const started = vi.fn();

        seen.failAt = "keys";
        await expect(run(started)).rejects.toThrow("provider keys unavailable");
        expect(started).not.toHaveBeenCalled();
    });

    it("is not called when the thread cannot be created", async () => {
        const started = vi.fn();

        seen.failAt = "thread";
        await expect(run(started)).rejects.toThrow("thread creation failed");
        expect(started).not.toHaveBeenCalled();
    });

    it("is called when the model call itself fails", async () => {
        const started = vi.fn();

        seen.failAt = "generate";
        await expect(run(started)).rejects.toThrow("model call failed");
        expect(started).toHaveBeenCalledTimes(1);
    });
});
