/**
 * A second `/clear` while the first is still out sends nothing: each call carries its own id, so the server could not
 * tell the two apart and would write two "New context" dividers.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import useClearContext from "./use-clear-context";

const harness = vi.hoisted(() => {
    return { calls: [] as { resolve: () => void }[] };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), info: vi.fn() } };
});

vi.mock("@/features/chat/core/utils/thread-id", () => {
    return { getValidThreadId: (threadId: string | undefined) => threadId };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useLunoraActionOptions: () => {
            return {
                mutationFn: async () =>
                    await new Promise<void>((resolve) => {
                        harness.calls.push({ resolve });
                    }),
            };
        },
    };
});

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

describe(useClearContext, () => {
    it("sends one clear for two calls made while the first is out, and a later one after it landed", async () => {
        expect.assertions(4);

        const { result } = renderHook(() => useClearContext("thread-1"), { wrapper });

        let first: Promise<boolean> | undefined;
        let second: Promise<boolean> | undefined;

        act(() => {
            first = result.current.clear();
            second = result.current.clear();
        });

        await expect(second).resolves.toBe(false);
        expect(harness.calls).toHaveLength(1);

        await act(async () => {
            harness.calls[0]?.resolve();
            await first;
        });

        await expect(first).resolves.toBe(true);

        await act(async () => {
            void result.current.clear();
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
        });

        expect(harness.calls).toHaveLength(2);
        harness.calls[1]?.resolve();
    });
});
