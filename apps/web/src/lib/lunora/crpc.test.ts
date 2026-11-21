import { connectLiveQueries, forgetAllUnlockProofs, rememberUnlockProof } from "@neore/client-runtime";
import type { QueryKey } from "@tanstack/react-query";
import { onlineManager, QueryClient } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiPath } from "./crpc";
import { runLunoraAction, useCRPC } from "./crpc";

const harness = vi.hoisted(() => {
    const client = {
        action: vi.fn(),
        canQueueOffline: vi.fn((_shardKey?: string) => true),
        getAuthToken: () => null,
        mutation: vi.fn(async () => null),
        onAuthTokenChange: () => () => {},
        onIdentityChange: () => () => {},
        query: vi.fn(async (_reference: unknown, _args: unknown) => "rpc"),
        setWsTicket: () => {},
        subscribe: vi.fn(() => () => {}),
    };

    return { client };
});

vi.mock("@lunora/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@lunora/react")>();

    return { ...actual, useLunora: () => harness.client };
});

afterEach(() => {
    forgetAllUnlockProofs();
    onlineManager.setOnline(true);
    harness.client.canQueueOffline.mockReturnValue(true);
    harness.client.mutation.mockClear();
});

describe("a mutation sent offline", () => {
    const send = async (call?: { onlineOnly?: true }): Promise<unknown> => {
        const { result } = renderHook(() => useCRPC());
        const options = result.current.auth.functions.setSubAgentRole.mutationOptions(undefined, call);

        return await (options.mutationFn as (args: object) => Promise<unknown>)({ config: null, role: "review" });
    };

    it("goes to the client at once when the client can queue it", async () => {
        onlineManager.setOnline(false);

        await send();

        expect(harness.client.mutation).toHaveBeenCalledTimes(1);
    });

    it("waits for the network when the client cannot queue it yet", async () => {
        onlineManager.setOnline(false);
        harness.client.canQueueOffline.mockReturnValue(false);

        const sent = send();

        await Promise.resolve();
        expect(harness.client.mutation).not.toHaveBeenCalled();

        onlineManager.setOnline(true);
        await sent;

        expect(harness.client.mutation).toHaveBeenCalledTimes(1);
    });

    it("does not wait for a sensitive mutation, which the client refuses offline", async () => {
        onlineManager.setOnline(false);
        harness.client.canQueueOffline.mockReturnValue(false);

        const { result } = renderHook(() => useCRPC());
        const options = result.current.chat.request_secret.answerSecretRequest.mutationOptions();

        await (options.mutationFn as (args: object) => Promise<unknown>)({});

        expect(harness.client.mutation).toHaveBeenCalledTimes(1);
    });

    it("does not wait when the call asks to fail offline", async () => {
        onlineManager.setOnline(false);
        harness.client.canQueueOffline.mockReturnValue(false);

        await send({ onlineOnly: true });

        expect(harness.client.mutation).toHaveBeenCalledTimes(1);
    });
});

describe("ApiPath (the type NEVER_LIVE is keyed by)", () => {
    it("accepts a generated procedure path and rejects a typo at typecheck", () => {
        const known: ApiPath = "chat_functions:searchThreads";
        // @ts-expect-error — not a procedure: a renamed or misspelled NEVER_LIVE key fails `pnpm lint:types`.
        const typo: ApiPath = "chat_functions:serchThreads";

        expect([known, typo]).toHaveLength(2);
    });
});

describe("action calls on a locked chat the user unlocked", () => {
    it("send the in-memory proof, for the mutation hook and the action hook alike", async () => {
        rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);

        const action = vi.fn(async () => null);

        // `useLunoraActionOptions` and `useAction` both go through `runLunoraAction`.
        await runLunoraAction({ action } as never, { name: "updateThread" } as never, { threadId: "thread-1", title: "Renamed" });

        expect(action).toHaveBeenCalledWith({ name: "updateThread" }, { threadId: "thread-1", title: "Renamed", unlockProof: "proof-1" }, {});

        forgetAllUnlockProofs();
    });

    it("sends no proof for a chat the user has not unlocked", async () => {
        const action = vi.fn(async () => null);

        await runLunoraAction({ action } as never, { name: "updateThread" } as never, { threadId: "thread-2", title: "Renamed" });

        expect(action).toHaveBeenCalledWith({ name: "updateThread" }, { threadId: "thread-2", title: "Renamed" }, {});
    });
});

describe("a locked chat's read when the live socket falls back to RPC", () => {
    it("sends the proof with the fallback RPC, the same args the subscription would carry", async () => {
        rememberUnlockProof("thread-1", "proof-1", Date.now() + 60_000);
        const disconnect = connectLiveQueries(harness.client as never, new QueryClient(), vi.fn() as never);
        const { result } = renderHook(() => useCRPC());
        const options = result.current.chat.functions.getThread.queryOptions({ threadId: "thread-1" as never });

        await (options.queryFn as (context: { queryKey: QueryKey }) => Promise<unknown>)({ queryKey: options.queryKey });

        expect(harness.client.query).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ threadId: "thread-1", unlockProof: "proof-1" }),
            expect.anything(),
        );

        disconnect();
    });

    it("sends no proof for a chat that is not unlocked", async () => {
        const disconnect = connectLiveQueries(harness.client as never, new QueryClient(), vi.fn() as never);
        const { result } = renderHook(() => useCRPC());
        const options = result.current.chat.functions.getThread.queryOptions({ threadId: "thread-2" as never });

        await (options.queryFn as (context: { queryKey: QueryKey }) => Promise<unknown>)({ queryKey: options.queryKey });

        const args: unknown = harness.client.query.mock.calls.at(-1)?.[1];

        expect(args).not.toHaveProperty("unlockProof");

        disconnect();
    });
});
