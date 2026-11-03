import { enabledModelOf, MODEL_REGISTRY } from "@neore/ai/models";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "../../_generated/server";
import { regenerateParentOf } from "../../agent/agent-switch";
import { vThreadDocFields } from "../../agent/validators";
import type { RunPlan } from "./agent-run";
import { backupCapabilities } from "./backup-model";
import { type AutoGate, registryModelForRoute, resolveAutoModel, shouldRouteAuto } from "./auto-model";

const routeViaGateway = vi.fn();
const canRunPaidModel = vi.fn();

vi.mock("./gateway-client", () => {
    return { routeViaGateway: (...args: unknown[]) => routeViaGateway(...args) };
});
vi.mock("./agent-run", () => {
    return { canRunPaidModel: (...args: unknown[]) => canRunPaidModel(...args) };
});

const ctx = {} as ActionCtx;
const plan: RunPlan = { isAdmin: false, plan: null };
const enabledText = MODEL_REGISTRY.filter((row) => enabledModelOf(row.id, { mode: "text" }) && row.supportsToolCalling !== false);
const fallback = enabledText[0]!;
const target = enabledText.find(
    (row) => row.id !== fallback.id && row.supportsImages === true && (row.supportsFileInput === true || row.filterCapabilities?.includes("pdf_comprehension")),
)!;
const noImages = enabledText.find((row) => row.id !== fallback.id && row.supportsImages !== true && row.filterCapabilities?.includes("vision") !== true)!;

const filesOnly = enabledText.find((row) => row.id !== fallback.id && !backupCapabilities(row).images && backupCapabilities(row).files)!;
const imagesOnly = enabledText.find((row) => row.id !== fallback.id && backupCapabilities(row).images && !backupCapabilities(row).files)!;

const gate = (overrides: Partial<AutoGate> = {}, thread: Partial<AutoGate["thread"]> = {}): AutoGate => {
    return {
        currentModel: fallback.id,
        isAnonymous: false,
        pinnedByBotOrSkill: false,
        prompt: "hello",
        requestedModel: undefined,
        thread: { autoModel: true, model: fallback.id, userId: "user-1", ...thread },
        userId: "user-1",
        ...overrides,
    };
};

const request = {
    conversation: async () => {
        return { contextTokens: 0, files: false, images: false };
    },
    fallbackModel: fallback.id,
    filterRules: { blockedProviders: ["x"] },
    plan: async () => plan,
    prompt: "hello",
    threadId: "thread-1",
    userId: "user-1",
};
const route = (modelId: string) => {
    return {
        confidence: 1,
        estimatedCost: 0,
        modelApiId: modelId,
        modelId,
        provider: "openrouter",
        routingReason: "",
        tier: "standard",
    };
};

describe("shouldRouteAuto", () => {
    it("does not route a send that names a model other than the thread's own", () => {
        expect(shouldRouteAuto(gate({ requestedModel: target.id }))).toBe(false);
        expect(shouldRouteAuto(gate({ requestedModel: fallback.id }))).toBe(true);
    });

    it("routes a plain hosted text thread that opted in", () => {
        expect(shouldRouteAuto(gate())).toBe(true);
    });

    it.each([
        ["off", gate({}, { autoModel: undefined })],
        ["switched", gate({}, { activeAgent: { kind: "model", model: fallback.id } })],
        ["a bot thread", gate({}, { botId: "bot-1" as never })],
        ["a host thread", gate({}, { runner: "host" })],
        ["a collaborator's turn", gate({ userId: "user-2" })],
        ["a guest", gate({ isAnonymous: true })],
        ["a pinned bot or skill model", gate({ pinnedByBotOrSkill: true })],
        ["an empty prompt", gate({ prompt: "  " })],
        ["a custom endpoint", gate({ currentModel: "custom:abc/model" })],
        ["a model outside the registry", gate({ currentModel: "no-such-model" })],
    ])("does not route %s", (_name, input) => {
        expect(shouldRouteAuto(input)).toBe(false);
    });
});

describe("registryModelForRoute", () => {
    it("takes an exact registry id", () => {
        expect(registryModelForRoute(route(fallback.id))?.id).toBe(fallback.id);
    });

    it("maps the gateway's short id onto the registry's vendor-prefixed one", () => {
        expect(registryModelForRoute({ ...route("claude-sonnet-4"), modelApiId: "anthropic/claude-sonnet-4" })?.id).toBe("anthropic/claude-sonnet-4");
    });

    it("does not match a name on another provider (Google's own model is not the OpenRouter entry)", () => {
        expect(registryModelForRoute({ ...route("gemini-2.5-flash"), modelApiId: "gemini-2.5-flash", provider: "google" })).toBeUndefined();
    });

    it("is none for a gateway-only model", () => {
        expect(registryModelForRoute(route("cf-llama-4-scout"))).toBeUndefined();
    });
});

describe("resolveAutoModel", () => {
    beforeEach(() => {
        routeViaGateway.mockReset();
        canRunPaidModel.mockReset().mockResolvedValue(true);
    });

    it("runs the routed model and sends the filter rules, user, thread and plan tier", async () => {
        routeViaGateway.mockResolvedValue(route(target.id));

        await expect(resolveAutoModel(ctx, request)).resolves.toBe(target.id);
        expect(routeViaGateway).toHaveBeenCalledWith(
            ctx,
            {
                messages: [{ content: "hello", role: "user" }],
                modelFilterRules: { blockedProviders: ["x"] },
                threadId: "thread-1",
                userId: "user-1",
                userTier: "free",
            },
            { timeoutMs: 4500 },
        );
    });

    it("keeps the fallback when the routed id is not a registry model", async () => {
        routeViaGateway.mockResolvedValue(route("cf-llama-4-scout"));

        await expect(resolveAutoModel(ctx, request)).resolves.toBe(fallback.id);
    });

    it("keeps the fallback when the plan cannot run the routed model", async () => {
        routeViaGateway.mockResolvedValue(route(target.id));
        canRunPaidModel.mockResolvedValue(false);

        await expect(resolveAutoModel(ctx, request)).resolves.toBe(fallback.id);
    });

    it("keeps the fallback when the filters exclude the routed model", async () => {
        routeViaGateway.mockResolvedValue(route(target.id));

        await expect(resolveAutoModel(ctx, { ...request, filterRules: { blockedModels: [target.id] } })).resolves.toBe(fallback.id);
    });

    it("keeps the fallback when images are in the conversation and the routed model cannot see them", async () => {
        routeViaGateway.mockResolvedValue(route(noImages.id));

        await expect(
            resolveAutoModel(ctx, {
                ...request,
                conversation: async () => {
                    return { contextTokens: 0, files: false, images: true };
                },
            }),
        ).resolves.toBe(fallback.id);
    });

    it("accepts a model that reads files but not images when only files are in the conversation", async () => {
        routeViaGateway.mockResolvedValue(route(filesOnly.id));

        await expect(
            resolveAutoModel(ctx, {
                ...request,
                conversation: async () => {
                    return { contextTokens: 0, files: true, images: false };
                },
            }),
        ).resolves.toBe(filesOnly.id);
    });

    it("accepts a model that sees images but not files when only images are in the conversation", async () => {
        routeViaGateway.mockResolvedValue(route(imagesOnly.id));

        await expect(
            resolveAutoModel(ctx, {
                ...request,
                conversation: async () => {
                    return { contextTokens: 0, files: false, images: true };
                },
            }),
        ).resolves.toBe(imagesOnly.id);
    });

    it("keeps the fallback when files are in the conversation and the routed model cannot read them", async () => {
        routeViaGateway.mockResolvedValue(route(imagesOnly.id));

        await expect(
            resolveAutoModel(ctx, {
                ...request,
                conversation: async () => {
                    return { contextTokens: 0, files: true, images: false };
                },
            }),
        ).resolves.toBe(fallback.id);
    });

    it("passes the size of a long conversation to the gateway", async () => {
        routeViaGateway.mockResolvedValue(route(target.id));

        await resolveAutoModel(ctx, {
            ...request,
            conversation: async () => {
                return { contextTokens: 50_000, files: false, images: false };
            },
        });

        expect(routeViaGateway).toHaveBeenCalledWith(ctx, expect.objectContaining({ contextTokens: 50_000 }), { timeoutMs: 4500 });
    });

    it("sends model lists in both spellings the gateway may know", async () => {
        routeViaGateway.mockResolvedValue(route(target.id));

        await resolveAutoModel(ctx, { ...request, filterRules: { allowedModels: ["anthropic/claude-sonnet-4"] } });

        expect(routeViaGateway).toHaveBeenCalledWith(
            ctx,
            expect.objectContaining({ modelFilterRules: { allowedModels: ["anthropic/claude-sonnet-4", "claude-sonnet-4"] } }),
            { timeoutMs: 4500 },
        );
    });

    it("keeps the fallback when the plan cannot be read", async () => {
        routeViaGateway.mockResolvedValue(route(target.id));

        await expect(
            resolveAutoModel(ctx, {
                ...request,
                plan: async () => {
                    throw new Error("plan unavailable");
                },
            }),
        ).resolves.toBe(fallback.id);
        expect(routeViaGateway).not.toHaveBeenCalled();
    });

    it("keeps the fallback when the gateway fails", async () => {
        routeViaGateway.mockRejectedValue(new Error("Gateway route failed (403)"));

        await expect(resolveAutoModel(ctx, request)).resolves.toBe(fallback.id);
    });
});

describe("a regenerate on an auto thread", () => {
    it("writes no switch divider: the thread was never switched, so the prompt stays the parent", async () => {
        const thread = { _id: "thread-1", userId: "user-1" } as Parameters<typeof regenerateParentOf>[1];

        await expect(regenerateParentOf({} as Parameters<typeof regenerateParentOf>[0], thread, "prompt-1" as never, target.id)).resolves.toBe("prompt-1");
    });
});

describe("the thread row", () => {
    it("declares autoModel in the doc fields every thread output validator spreads", () => {
        expect(vThreadDocFields).toHaveProperty("autoModel");
    });
});
