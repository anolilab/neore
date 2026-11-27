// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Settings = { scheduleIdeasEnabled?: boolean } | null;

const store = vi.hoisted(() => {
    return { listeners: new Set<() => void>(), value: null as Settings | undefined, writes: [] as boolean[] };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

// The settings cache: a write is applied at once, as the real hook does, and later reads see it. `updateExact` sends the
// patch it is given; `updateLatest` sends what the cache holds when its queued turn comes, like the real queue.
vi.mock("@/features/auth/hooks/use-user-settings", async () => {
    const { useSyncExternalStore } = await import("react");

    const apply = (patch: { scheduleIdeasEnabled: boolean }) => {
        store.value = { ...store.value, ...patch };

        for (const listener of store.listeners) {
            listener();
        }
    };

    return {
        useUpdateUserSettings: () => {
            return {
                updateExact: (patch: { scheduleIdeasEnabled: boolean }) => {
                    apply(patch);
                    store.writes.push(patch.scheduleIdeasEnabled);

                    return Promise.resolve();
                },
                updateLatest: (build: (current: Settings | undefined) => { scheduleIdeasEnabled: boolean }) => {
                    apply(build(store.value));

                    return (async () => {
                        await Promise.resolve();
                        store.writes.push(store.value?.scheduleIdeasEnabled === true);
                    })();
                },
            };
        },
        useUserSettings: () => {
            return {
                data: useSyncExternalStore(
                    (listener) => {
                        store.listeners.add(listener);

                        return () => store.listeners.delete(listener);
                    },
                    () => store.value,
                ),
            };
        },
    };
});

const { default: ScheduleIdeasSwitch } = await import("./schedule-ideas-switch");

const NAME = "Suggest scheduled tasks";
const FROM_OWN_MESSAGES = /only on your own recent messages/;
const DAILY_AND_UNASKED = /Once a day.*Nothing is created until you accept/;
const MEMORY_OFF_NOTE = /No ideas are made while memory is off/;

const control = () => screen.getByRole("switch", { name: NAME });
const isOn = (): boolean => control().getAttribute("aria-checked") === "true";
const isDisabled = (): boolean => control().matches(":disabled, [data-disabled]");

describe("ScheduleIdeasSwitch", () => {
    beforeEach(() => {
        store.value = null;
        store.writes = [];
    });

    it("starts off and says what the ideas are made from, how often, and that nothing is created unasked", () => {
        render(<ScheduleIdeasSwitch memoryEnabled />);

        expect(isOn()).toBe(false);
        expect(control().getAttribute("aria-describedby")).toBe("schedule-ideas-description");
        expect(screen.getByText(FROM_OWN_MESSAGES).textContent).toMatch(DAILY_AND_UNASKED);
    });

    it("saves the value the switch reports", () => {
        render(<ScheduleIdeasSwitch memoryEnabled />);

        fireEvent.click(control());

        expect(store.writes).toEqual([true]);
        expect(isOn()).toBe(true);
    });

    it("ends in the state of the last of two quick taps", () => {
        render(<ScheduleIdeasSwitch memoryEnabled />);

        fireEvent.click(control());
        fireEvent.click(control());

        expect(store.writes).toEqual([true, false]);
        expect(isOn()).toBe(false);

        fireEvent.click(control());
        fireEvent.click(control());
        fireEvent.click(control());

        expect(store.writes).toEqual([true, false, true, false, true]);
        expect(isOn()).toBe(true);
    });

    it("is disabled with memory off and saves nothing", () => {
        render(<ScheduleIdeasSwitch memoryEnabled={false} />);

        expect(isDisabled()).toBe(true);
        expect(screen.getByText(MEMORY_OFF_NOTE)).toBeTruthy();

        fireEvent.click(control());

        expect(store.writes).toEqual([]);
    });

    it("can still be turned off while memory is off and it was left on, then cannot be turned back on", () => {
        store.value = { scheduleIdeasEnabled: true };
        render(<ScheduleIdeasSwitch memoryEnabled={false} />);

        expect(isOn()).toBe(true);
        expect(isDisabled()).toBe(false);

        fireEvent.click(control());

        expect(store.writes).toEqual([false]);
        expect(isOn()).toBe(false);
        expect(isDisabled()).toBe(true);
    });

    it("sends false and then true for a quick off and on, so the erase of the off save is never skipped", async () => {
        store.value = { scheduleIdeasEnabled: true };
        render(<ScheduleIdeasSwitch memoryEnabled />);

        fireEvent.click(control());
        fireEvent.click(control());
        await Promise.resolve();

        expect(store.writes).toEqual([false, true]);
    });

    it("is disabled until the settings have loaded", () => {
        store.value = undefined;
        render(<ScheduleIdeasSwitch memoryEnabled />);

        expect(isDisabled()).toBe(true);
    });
});
