import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { forgetAllUnlockProofs, rememberUnlockProof } from "@/lib/lunora/unlock-proofs";

import { useModelStore } from "../stores/model-store";
import useComparisonChat from "./use-comparison-chat";

const settings = { newChatsTemporary: false };
const mutations: { args: Record<string, unknown>; name: string }[] = [];

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray) => strings[0] };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUserSettings: () => {
            return { data: settings };
        },
    };
});

vi.mock("@/hooks/use-gateway-models", () => {
    return {
        useGatewayModels: () => [
            { filterCapabilities: ["reasoning"], id: "model-a" },
            { filterCapabilities: ["text"], id: "model-b" },
            { filterCapabilities: ["effort_control"], id: "model-c" },
        ],
    };
});

vi.mock("@/lib/env", () => {
    return {
        default: { VITE_LLM_GATEWAY_URL: "https://gateway.test" },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    functions: {
                        createThread: {
                            mutationOptions: () => {
                                return { name: "createThread" };
                            },
                        },
                        createThreadRelationshipPublic: {
                            mutationOptions: () => {
                                return { name: "createThreadRelationshipPublic" };
                            },
                        },
                    },
                },
            };
        },
        useLunora: () => {
            return { getAuthToken: () => "token" };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: (options: { name: string }) => {
            return {
                mutateAsync: async (args: Record<string, unknown>) => {
                    mutations.push({ args, name: options.name });

                    return options.name === "createThread" ? `thread-${mutations.length}` : undefined;
                },
            };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useNavigate: () => vi.fn(),
    };
});

const createdThreads = () => mutations.filter((entry) => entry.name === "createThread").map((entry) => entry.args);

beforeEach(() => {
    mutations.length = 0;
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ streamId: "stream" }, { status: 200 })),
    );
    useModelStore.getState().setPendingSettings(undefined);
});

describe("useComparisonChat temporary choice", () => {
    it("creates a new comparison, its parent and both children, as temporary when the setting is on", async () => {
        settings.newChatsTemporary = true;
        useModelStore.getState().setPendingSettings({ retentionHours: 12 });

        const { result } = renderHook(() => useComparisonChat({ jwtToken: "jwt" }));

        await act(async () => {
            await result.current.sendComparisonMessage("hi", ["model-a", "model-b"]);
        });

        expect(createdThreads()).toHaveLength(3);

        for (const args of createdThreads()) {
            expect(args).toMatchObject({ retentionHours: 12, temporary: true });
        }
    });

    it("creates them permanent when the setting is off", async () => {
        settings.newChatsTemporary = false;

        const { result } = renderHook(() => useComparisonChat({ jwtToken: "jwt" }));

        await act(async () => {
            await result.current.sendComparisonMessage("hi", ["model-a", "model-b"]);
        });

        expect(createdThreads()).toHaveLength(3);

        for (const args of createdThreads()) {
            expect(args).not.toHaveProperty("temporary");
        }
    });

    it("adds children to an existing comparison permanently, whatever the setting", async () => {
        settings.newChatsTemporary = true;

        const { result } = renderHook(() => useComparisonChat({ jwtToken: "jwt", parentThreadId: "parent" }));

        await act(async () => {
            await result.current.sendComparisonMessage("hi", ["model-a", "model-b"]);
        });

        expect(createdThreads()).toHaveLength(2);

        for (const args of createdThreads()) {
            expect(args).not.toHaveProperty("temporary");
        }
    });
});

describe("useComparisonChat follow-ups to existing children", () => {
    it("sends each locked child its own unlock proof, and sends none to an open child", async () => {
        rememberUnlockProof("child-locked", "proof-child", Date.now() + 60_000);

        const { result } = renderHook(() => useComparisonChat({ jwtToken: "jwt", parentThreadId: "parent" }));

        await act(async () => {
            await result.current.sendToExistingChildren("follow-up", [
                { model: "model-a", threadId: "child-locked" },
                { model: "model-b", threadId: "child-open" },
            ]);
        });

        const bodies = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
        const locked = bodies.find((body) => body.threadId === "child-locked");
        const open = bodies.find((body) => body.threadId === "child-open");

        expect(locked).toMatchObject({ prompt: "follow-up", unlockProof: "proof-child" });
        expect(open).toBeDefined();
        expect(open).not.toHaveProperty("unlockProof");

        forgetAllUnlockProofs();
    });
});

describe("useComparisonChat reasoning effort", () => {
    const sentBodies = () => vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

    it("gives the pending effort only to the child whose model reasons, on creation", async () => {
        useModelStore.getState().setPendingSettings({ reasoningEffort: 75 });

        const { result } = renderHook(() => useComparisonChat({ jwtToken: "jwt" }));

        await act(async () => {
            await result.current.sendComparisonMessage("hi", ["model-a", "model-b"]);
        });

        const children = createdThreads().filter((args) => args.model !== "unknown" && args.branchName === args.model);

        expect(children.find((args) => args.model === "model-a")).toMatchObject({ reasoningEffort: 75 });
        expect(children.find((args) => args.model === "model-b")?.reasoningEffort).toBeUndefined();
        expect(sentBodies().find((body) => body.model === "model-a")).toMatchObject({ reasoningEffort: 75 });
        expect(sentBodies().find((body) => body.model === "model-b")?.reasoningEffort).toBeUndefined();
    });

    it("keeps the pending effort for a model that only advertises effort control", async () => {
        useModelStore.getState().setPendingSettings({ reasoningEffort: 50 });

        const { result } = renderHook(() => useComparisonChat({ jwtToken: "jwt", parentThreadId: "parent" }));

        await act(async () => {
            await result.current.sendToExistingChildren("again", [
                { model: "model-c", threadId: "child-c" },
                { model: "model-b", threadId: "child-b" },
            ]);
        });

        expect(sentBodies().find((body) => body.threadId === "child-c")).toMatchObject({ reasoningEffort: 50 });
        expect(sentBodies().find((body) => body.threadId === "child-b")?.reasoningEffort).toBeUndefined();
    });

    it("does the same for a follow-up to existing children", async () => {
        useModelStore.getState().setPendingSettings({ reasoningEffort: 25 });

        const { result } = renderHook(() => useComparisonChat({ jwtToken: "jwt", parentThreadId: "parent" }));

        await act(async () => {
            await result.current.sendToExistingChildren("again", [
                { model: "model-a", threadId: "child-a" },
                { model: "model-b", threadId: "child-b" },
            ]);
        });

        expect(sentBodies().find((body) => body.threadId === "child-a")).toMatchObject({ reasoningEffort: 25 });
        expect(sentBodies().find((body) => body.threadId === "child-b")?.reasoningEffort).toBeUndefined();
    });
});
