/**
 * The thread-title field of `<PersonalizationSettings>`: text typed while an earlier save is still
 * pending must survive that save's cache update, and a saved value must be there after a remount.
 * The settings hooks are replaced by a small in-memory store with a controllable save.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PersonalizationSettings from "./personalization-settings";

const harness = vi.hoisted(() => {
    const store = {
        listeners: new Set<() => void>(),
        pendingSaves: [] as { land: () => void; resolve: () => void; value: string }[],
        settings: { threadTitleInstructions: undefined as string | undefined },
    };

    return { store };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

vi.mock("@/lib/analytics", () => {
    return { trackEvent: vi.fn() };
});

vi.mock("@/features/layout/hooks/use-ui-state", () => {
    return { useUserPreferences: () => ({ onboardingCompleted: false, setOnboardingCompleted: vi.fn() }) };
});

vi.mock("@/features/chat/prompt-improvement/components/system-prompt-optimizer-dialog", () => {
    return { default: () => null };
});

vi.mock("./memory-settings", () => {
    return { default: () => null };
});

vi.mock("@/features/auth/hooks/use-user-settings", async () => {
    const { useSyncExternalStore } = await import("react");
    const { store } = harness;

    return {
        useUpdateUserSettings: () => {
            return {
                mutateAsync: (patch: { threadTitleInstructions?: string }) => {
                    // `onMutate` awaits before it writes the cache, so the optimistic update (`land`) trails the call.
                    const land = () => {
                        store.settings = { ...store.settings, ...patch };

                        for (const listener of store.listeners) {
                            listener();
                        }
                    };

                    return new Promise<void>((resolve) => {
                        store.pendingSaves.push({ land, resolve, value: patch.threadTitleInstructions ?? "" });
                    });
                },
            };
        },
        useUserSettings: () => {
            const data = useSyncExternalStore(
                (listener) => {
                    store.listeners.add(listener);

                    return () => store.listeners.delete(listener);
                },
                () => store.settings,
            );

            return { data, isLoading: false };
        },
    };
});

const field = () => screen.getByLabelText("How should titles be written?") as HTMLInputElement;

describe("PersonalizationSettings thread title instructions", () => {
    beforeEach(() => {
        harness.store.settings = { threadTitleInstructions: undefined };
        harness.store.pendingSaves = [];
    });

    it("shows the stored value", () => {
        harness.store.settings = { threadTitleInstructions: "Write in German" };
        render(<PersonalizationSettings />);

        expect(field().value).toBe("Write in German");
    });

    it("keeps newer text typed while an earlier save is pending", async () => {
        render(<PersonalizationSettings />);

        fireEvent.change(field(), { target: { value: "Short titles" } });
        fireEvent.blur(field());

        expect(harness.store.pendingSaves).toHaveLength(1);

        fireEvent.focus(field());
        fireEvent.change(field(), { target: { value: "Short titles, no emoji" } });

        // The first save's cache update lands only now, after the newer text.
        await act(async () => {
            harness.store.pendingSaves[0]?.land();
        });

        expect(field().value).toBe("Short titles, no emoji");

        await act(async () => {
            harness.store.pendingSaves[0]?.resolve();
        });

        expect(field().value).toBe("Short titles, no emoji");

        // The later blur still saves the newer text.
        fireEvent.blur(field());

        expect(harness.store.pendingSaves.map((save) => save.value)).toEqual(["Short titles", "Short titles, no emoji"]);
    });

    it("keeps a saved value after the card is mounted again", async () => {
        const first = render(<PersonalizationSettings />);

        fireEvent.change(field(), { target: { value: "  Start with a verb  " } });
        fireEvent.blur(field());
        await act(async () => {
            harness.store.pendingSaves[0]?.land();
            harness.store.pendingSaves[0]?.resolve();
        });

        expect(harness.store.pendingSaves[0]?.value).toBe("Start with a verb");

        first.unmount();
        render(<PersonalizationSettings />);

        expect(field().value).toBe("Start with a verb");
    });
});
