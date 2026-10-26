import { currentUnlockProof, rememberUnlockProof } from "@neore/client-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import useTanstackOptions from "./use-tanstack-options";

// Only the mutation hooks matter here; each resolves like a successful better-auth call.
vi.mock("../create-auth-hooks", () => {
    const mutation = () => {
        return {
            mutateAsync: vi.fn(async () => {
                return { error: null };
            }),
        };
    };

    return {
        default: () => {
            return {
                useDeletePasskey: mutation,
                useRevokeDeviceSession: mutation,
                useRevokeSession: mutation,
                useSetActiveSession: () => {
                    return {
                        setActiveSessionAsync: vi.fn(async () => {
                            return { error: null };
                        }),
                    };
                },
                useUnlinkAccount: mutation,
                useUpdateUser: mutation,
            };
        },
    };
});

const queryClient = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

describe("switching accounts", () => {
    it("forgets the unlocked chats of the account being left", async () => {
        const { result } = renderHook(() => useTanstackOptions({ authClient: {} as never }), { wrapper });

        rememberUnlockProof("locked-chat", "proof-of-old-account", Date.now() + 60_000);
        expect(currentUnlockProof("locked-chat")).toBe("proof-of-old-account");

        await act(async () => {
            await result.current.mutators.setActiveSession({ sessionToken: "other-session" } as never);
        });

        expect(currentUnlockProof("locked-chat")).toBeUndefined();
    });
});
