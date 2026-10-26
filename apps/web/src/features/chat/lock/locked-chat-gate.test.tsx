/**
 * `<LockedChatGate>` with the REAL unlock store, cRPC and query options. Only the
 * transport (`useLunora`'s client) and i18n are faked: the fake client refuses a
 * read whose proof is not the current passcode epoch's, the way the backend does,
 * and records the args it got.
 */

import { currentUnlockProof, forgetAllUnlockProofs, forgetUnlockProof, rememberUnlockProof } from "@neore/client-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LockedChatGate } from "./locked-chat-gate";

const harness = vi.hoisted(() => {
    // `validProof` is the passcode epoch: null accepts any proof, a string accepts only that one.
    const state = { failNetwork: false, hang: false, passcodeRemoved: false, validProof: null as string | null };
    const client = {
        action: vi.fn(),
        getAuthToken: () => null,
        mutation: vi.fn(),
        onAuthTokenChange: () => () => {},
        query: vi.fn(async (_reference: unknown, args: { unlockProof?: string }) => {
            if (state.hang) {
                return new Promise<never>(() => {});
            }

            if (state.failNetwork) {
                throw new Error("network down");
            }

            const accepted = state.passcodeRemoved || (args.unlockProof !== undefined && (state.validProof === null || args.unlockProof === state.validProof));

            if (!accepted) {
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

    const view = render(
        <QueryClientProvider client={queryClient}>
            <LockedChatGate threadId="thread-1">
                <p>chat body</p>
            </LockedChatGate>
        </QueryClientProvider>,
    );

    return { ...view, queryClient };
};

const promptHeading = () => screen.findByRole("heading", { name: "This chat is locked" });

const lastReadArgs = (): Record<string, unknown> => {
    const { calls } = harness.client.query.mock;

    return (calls.at(-1)?.[1] ?? {}) as Record<string, unknown>;
};

/** Lets pending promises and timers run, so a refetch loop would show up as more calls. */
const settle = async (ms = 50) => {
    await act(async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    });
};

beforeEach(() => {
    harness.client.query.mockClear();
    harness.state.passcodeRemoved = false;
    harness.state.validProof = null;
    harness.state.failNetwork = false;
    harness.state.hang = false;
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

describe("a stale proof behind its gate (the passcode epoch rotated elsewhere)", () => {
    it("a refused read hides the mounted chat, forgets the proof and shows the prompt", async () => {
        const { queryClient } = renderGate();

        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-old", Date.now() + 60_000);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();

        // Another tab or device rotates the epoch; this tab's proof is now refused on refetch.
        harness.state.validProof = "proof-new";
        await act(async () => {
            await queryClient.invalidateQueries();
        });

        expect(await promptHeading()).toBeTruthy();
        expect(screen.queryByText("chat body")).toBeNull();
        expect(currentUnlockProof("thread-1")).toBeUndefined();
    });

    it("does not loop: once the stale proof is forgotten, the refusal settles", async () => {
        const { queryClient } = renderGate();

        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-old", Date.now() + 60_000);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();
        harness.state.validProof = "proof-new";
        await act(async () => {
            await queryClient.invalidateQueries();
        });
        await promptHeading();

        const callsAfterRefusal = harness.client.query.mock.calls.length;

        await settle();

        expect(harness.client.query.mock.calls).toHaveLength(callsAfterRefusal);
    });

    it("a fresh unlock after the stale refusal renders the chat again", async () => {
        const { queryClient } = renderGate();

        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-old", Date.now() + 60_000);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();
        harness.state.validProof = "proof-new";
        await act(async () => {
            await queryClient.invalidateQueries();
        });
        await promptHeading();

        act(() => {
            rememberUnlockProof("thread-1", "proof-new", Date.now() + 60_000);
        });

        expect(await screen.findByText("chat body")).toBeTruthy();
        expect(lastReadArgs()).toMatchObject({ unlockProof: "proof-new" });
        expect(screen.queryByRole("heading", { name: "This chat is locked" })).toBeNull();
    });

    it("keeps the chat and the proof when the refetch is still accepted (no false positive)", async () => {
        const { queryClient } = renderGate();

        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-ok", Date.now() + 60_000);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();

        await act(async () => {
            await queryClient.invalidateQueries();
        });

        expect(screen.getByText("chat body")).toBeTruthy();
        expect(currentUnlockProof("thread-1")).toBe("proof-ok");
    });
});

describe("a relocked chat whose read is pending or fails", () => {
    it("stays hidden behind the prompt while the read is pending", async () => {
        renderGate();
        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();

        harness.state.hang = true;
        act(() => {
            forgetUnlockProof("thread-1");
        });

        expect(await promptHeading()).toBeTruthy();
        expect(screen.queryByText("chat body")).toBeNull();
    });

    it("shows the read's own error, not the unlock prompt, for a failure that is not a lock refusal", async () => {
        renderGate();
        await promptHeading();
        act(() => {
            rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);
        });
        expect(await screen.findByText("chat body")).toBeTruthy();

        harness.state.failNetwork = true;
        act(() => {
            forgetUnlockProof("thread-1");
        });

        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.getByText("network down")).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "This chat is locked" })).toBeNull();
        expect(screen.queryByText("chat body")).toBeNull();
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
