// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { args: unknown; fn: string }[] = [];
const toasts: { message: string; options?: { action?: { onClick: () => void } } }[] = [];
const errors: string[] = [];
// What the next write answers; reset after each test.
const answer: { next?: { applied: boolean } } = {};

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

                    return answer.next;
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
        showError: (message: string) => {
            errors.push(message);
        },
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
        errors.length = 0;
        answer.next = undefined;
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

        expect(calls[1]).toMatchObject({ args: { threadId: "t1" }, fn: "unsnooze" });
    });

    it("undoes a snooze back to the earlier wake time", async () => {
        const { result } = renderHook(() => useThreadStateActions());
        const earlier = Date.now() + 86_400_000;

        result.current.snooze("t1", "hour", earlier);
        await flush();
        toasts[0]?.options?.action?.onClick();
        await flush();

        expect(calls[1]).toMatchObject({ args: { threadId: "t1", until: earlier }, fn: "snooze" });
    });

    it("snoozes until a custom time, and undo restores the previous snooze with a later choice stamp", async () => {
        const { result } = renderHook(() => useThreadStateActions());
        const previous = Date.now() + 86_400_000;
        const custom = Date.now() + 3 * 86_400_000;

        result.current.snoozeAt("t1", custom, previous);
        await flush();
        toasts[0]?.options?.action?.onClick();
        await flush();

        const [chosen, undone] = calls as { args: { chosenAt: number; until: number } }[];

        expect(chosen?.args.until).toBe(custom);
        expect(undone).toMatchObject({ args: { threadId: "t1", until: previous }, fn: "snooze" });
        expect(undone!.args.chosenAt).toBeGreaterThan(chosen!.args.chosenAt);
    });

    it("says a snooze the server did not apply was not applied, with no success toast or undo", async () => {
        const { result } = renderHook(() => useThreadStateActions());

        answer.next = { applied: false };
        result.current.snoozeAt("t1", Date.now() + 86_400_000, undefined);
        await flush();

        expect(errors).toEqual(["This thread changed since, so this was not applied."]);
        expect(toasts).toHaveLength(0);
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
