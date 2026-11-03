import { enabledModelOf, MODEL_REGISTRY } from "@neore/ai/models";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCtx } from "../../_generated/server";
import { regenerateParentOf } from "../../agent/agent-switch";
import { vThreadDocFields } from "../../agent/validators";
import type { RunPlan } from "./agent-run";
import { type AutoGate, registryModelForRoute, resolveAutoModel, shouldRouteAuto } from "./auto-model";

const routeViaGateway = vi.fn();
const canRunPaidModel = vi.fn();

vi.mock("./gateway-client", () => {return { routeViaGateway: (...args: unknown[]) => routeViaGateway(...args) }});
vi.mock("./agent-run", () => {return { canRunPaidModel: (...args: unknown[]) => canRunPaidModel(...args) }});

const ctx = {} as ActionCtx;
const plan: RunPlan = { isAdmin: false, plan: null };
const enabledText = MODEL_REGISTRY.filter((row) => enabledModelOf(row.id, { mode: "text" }) && row.supportsToolCalling !== false);
const fallback = enabledText[0]!;
const target = enabledText.find(
    (row) => row.id !== fallback.id && row.supportsImages === true && (row.supportsFileInput === true || row.filterCapabilities?.includes("pdf_comprehension")),
)!;
const noImages = enabledText.find((row) => row.id !== fallback.id && row.supportsImages !== true && row.filterCapabilities?.includes("vision") !== true)!;

const gate = (overrides: Partial<AutoGate> = {}, thread: Partial<AutoGate["thread"]> = {}): AutoGate => {return {
    currentModel: fallback.id,
    isAnonymous: false,
    pinnedByBotOrSkill: false,
    prompt: "hello",
    thread: { autoModel: true, userId: "user-1", ...thread },
    userId: "user-1",
    ...overrides,
}};

const request = {
    fallbackModel: fallback.id,
    filterRules: { blockedProviders: ["x"] },
    hasAttachments: false,
    plan,
    prompt: "hello",
    threadId: "thread-1",
    userId: "user-1",
};
const route = (modelId: string) => {return {
    confidence: 1,
    estimatedCost: 0,
    modelApiId: modelId,
    modelId,
    provider: "openrouter",
    routingReason: "",
    tier: "standard",
}};

describe("shouldRouteAuto", () => {
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
        expect(registryModelForRoute(route("claude-sonnet-4"))?.id).toBe("anthropic/claude-sonnet-4");
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
        expect(routeViaGateway).toHaveBeenCalledWith(ctx, {
            messages: [{ content: "hello", role: "user" }],
            modelFilterRules: { blockedProviders: ["x"] },
            threadId: "thread-1",
            userId: "user-1",
            userTier: "free",
        });
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

    it("keeps the fallback when attachments need a capability the routed model lacks", async () => {
        routeViaGateway.mockResolvedValue(route(noImages.id));

        await expect(resolveAutoModel(ctx, { ...request, hasAttachments: true })).resolves.toBe(fallback.id);
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
