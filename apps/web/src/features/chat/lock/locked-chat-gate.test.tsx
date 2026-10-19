/**
 * `<LockedChatGate>` with the REAL unlock store, cRPC and query options. Only the
 * transport (`useLunora`'s client) and i18n are faked: the fake client refuses a
 * read without a proof the way the backend does, and records the args it got.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetAllUnlockProofs, forgetUnlockProof, rememberUnlockProof } from "@/lib/lunora/unlock-proofs";

import { LockedChatGate } from "./locked-chat-gate";

const harness = vi.hoisted(() => {
    const state = { passcodeRemoved: false };
    const client = {
        action: vi.fn(),
        getAuthToken: () => null,
        mutation: vi.fn(),
        onAuthTokenChange: () => () => {},
        query: vi.fn(async (_reference: unknown, args: { unlockProof?: string }) => {
            if (args.unlockProof === undefined && !state.passcodeRemoved) {
                throw Object.assign(new Error("This chat is locked"), { data: { code: "THREAD_LOCKED" } });
            }

            return { messages: [], thread: { _id: "thread-1" } };
        }),
        setWsToken: () => {},
        subscribe: vi.fn(),
    };

    return { client, state };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@lunora/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lunora/react")>();

    return { ...actual, useLunora: () => harness.client };
});

const renderGate = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    return render(
        <QueryClientProvider client={queryClient}>
            <LockedChatGate threadId="thread-1">
                <p>chat body</p>
            </LockedChatGate>
        </QueryClientProvider>,
    );
};

const promptHeading = () => screen.findByRole("heading", { name: "This chat is locked" });

const lastReadArgs = (): Record<string, unknown> => {
    const { calls } = harness.client.query.mock;

    return (calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;
};

beforeEach(() => {
    harness.client.query.mockClear();
    harness.state.passcodeRemoved = false;
});

afterEach(() => {
    forgetAllUnlockProofs();
});

describe("a locked chat behind its gate", () => {
    it("shows the unlock prompt, not the chat, while no proof is in memory", async () => {
        renderGate();

        expect(await promptHeading()).toBeTruthy();
        expect(screen.queryByText("chat body")).toBeNull();
    });

    it("mounts the chat once the proof is remembered, and reads it with that proof", async () => {
        renderGate();
        await promptHeading();

        act(() => {
            rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);
        });

        expect(await screen.findByText("chat body")).toBeTruthy();
        expect(lastReadArgs()).toMatchObject({ threadId: "thread-1", unlockProof: "proof-1" });
    });

    it("hides the chat at once when the proof is forgotten (Lock now)", async () => {
        renderGate();
        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();

        act(() => {
            forgetUnlockProof("thread-1");
        });

        expect(screen.queryByText("chat body")).toBeNull();
        expect(await promptHeading()).toBeTruthy();
        expect(lastReadArgs()).not.toHaveProperty("unlockProof");
    });

    it("hides the chat when the proof expires", async () => {
        renderGate();
        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-1", Date.now() + 50);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();

        expect(await promptHeading()).toBeTruthy();
        expect(screen.queryByText("chat body")).toBeNull();
    });

    it("shows the chat again after a relock when its passcode was removed (no refusal)", async () => {
        renderGate();
        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();

        harness.state.passcodeRemoved = true;
        act(() => {
            forgetUnlockProof("thread-1");
        });

        expect(await screen.findByText("chat body")).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "This chat is locked" })).toBeNull();
    });
});

describe("a chat that is not locked", () => {
    it("renders at once, with no proof and no prompt", async () => {
        harness.state.passcodeRemoved = true;

        renderGate();

        expect(await screen.findByText("chat body")).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "This chat is locked" })).toBeNull();
        expect(lastReadArgs()).not.toHaveProperty("unlockProof");
    });
});
