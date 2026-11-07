// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { args: unknown; fn: string }[] = [];
const seenOptions: { call?: unknown; fn: string; networkMode?: string; retry?: number }[] = [];
const direct: { args: unknown; call?: unknown }[] = [];
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
        useQueryClient: () => {
            return {};
        },
        useMutation: (options: { call?: unknown; fn: string; networkMode?: string; retry?: number }) => {
            seenOptions.push(options);

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
                            mutationOptions: (_overrides?: unknown, call?: unknown) => {
                                return {
                                    call,
                                    fn: "snooze",
                                    mutationFn: async (args: unknown) => {
                                        direct.push({ args, call });

                                        return null;
                                    },
                                };
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
        direct.length = 0;
        seenOptions.length = 0;
        toasts.length = 0;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("writes a custom time directly and online only; a preset keeps the client's queued default", async () => {
        const { result } = renderHook(() => useThreadStateActions());

        await expect(result.current.snoozeAt("t1", 1000, undefined)).resolves.toBe("saved");

        expect(direct).toMatchObject([{ args: { threadId: "t1", until: 1000 }, call: { onlineOnly: true } }]);

        const presets = seenOptions.filter((options) => options.fn === "snooze");

        expect(presets.every((options) => options.networkMode === undefined)).toBe(true);
    });

    it("snoozes, then undoes to a plain unsnooze when nothing was snoozed before", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
        const { result } = renderHook(() => useThreadStateActions());

        result.current.snooze("t1", "hour", undefined);
        await flush();

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ args: { chosenAt: 1000, threadId: "t1" }, fn: "snooze" });
        expect(toasts).toHaveLength(1);

        // The undo is a choice made later, so it carries the later time.
        clock.mockReturnValue(5000);
        toasts[0]?.options?.action?.onClick();
        await flush();

        expect(calls[1]).toMatchObject({ args: { chosenAt: 5000, threadId: "t1" }, fn: "unsnooze" });
    });

    it("undoes a snooze back to the earlier wake time, stamped with the time of the undo", async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
        const { result } = renderHook(() => useThreadStateActions());
        const earlier = 1000 + 86_400_000;

        result.current.snooze("t1", "hour", earlier);
        await flush();

        clock.mockReturnValue(5000);
        toasts[0]?.options?.action?.onClick();
        await flush();

        expect(calls[1]).toMatchObject({ args: { chosenAt: 5000, threadId: "t1", until: earlier }, fn: "snooze" });
    });

    it("unsnoozes, and undo snoozes it again until the same time", async () => {
        const { result } = renderHook(() => useThreadStateActions());
        const until = Date.now() + 3_600_000;

        result.current.unsnooze("t1", until);
        await flush();

        expect(calls[0]).toMatchObject({ args: { threadId: "t1" }, fn: "unsnooze" });

        toasts[0]?.options?.action?.onClick();
        await flush();

        expect(calls[1]).toMatchObject({ args: { threadId: "t1", until }, fn: "snooze" });
    });
});
