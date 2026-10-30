// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { args: unknown; fn: string }[] = [];
const toasts: { message: string; options?: { action?: { onClick: () => void } } }[] = [];

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: (options: { fn: string }) => {
            return {
                mutateAsync: async (args: unknown) => {
                    calls.push({ args, fn: options.fn });
                },
            };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                chat: {
                    thread_state: {
                        snoozeThread: {
                            mutationOptions: () => {
                                return { fn: "snooze" };
                            },
                        },
                        unsnoozeThread: {
                            mutationOptions: () => {
                                return { fn: "unsnooze" };
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return {
        showError: () => {},
        showSuccess: (message: string, options?: { action?: { onClick: () => void } }) => {
            toasts.push({ message, options });
        },
    };
});

const { useThreadStateActions } = await import("./use-thread-state-actions");

const flush = () =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

describe("useThreadStateActions", () => {
    beforeEach(() => {
        calls.length = 0;
        toasts.length = 0;
    });

    it("snoozes, then undoes to a plain unsnooze when nothing was snoozed before", async () => {
        const { result } = renderHook(() => useThreadStateActions());

        result.current.snooze("t1", "hour", undefined);
        await flush();

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ args: { threadId: "t1" }, fn: "snooze" });
        expect(toasts).toHaveLength(1);

        toasts[0]?.options?.action?.onClick();
        await flush();

        expect(calls[1]).toEqual({ args: { threadId: "t1" }, fn: "unsnooze" });
    });

    it("undoes a snooze back to the earlier wake time", async () => {
        const { result } = renderHook(() => useThreadStateActions());
        const earlier = Date.now() + 86_400_000;

        result.current.snooze("t1", "hour", earlier);
        await flush();
        toasts[0]?.options?.action?.onClick();
        await flush();

        expect(calls[1]).toEqual({ args: { threadId: "t1", until: earlier }, fn: "snooze" });
    });

    it("unsnoozes, and undo snoozes it again until the same time", async () => {
        const { result } = renderHook(() => useThreadStateActions());
        const until = Date.now() + 3_600_000;

        result.current.unsnooze("t1", until);
        await flush();

        expect(calls[0]).toEqual({ args: { threadId: "t1" }, fn: "unsnooze" });

        toasts[0]?.options?.action?.onClick();
        await flush();

        expect(calls[1]).toEqual({ args: { threadId: "t1", until }, fn: "snooze" });
    });
});
