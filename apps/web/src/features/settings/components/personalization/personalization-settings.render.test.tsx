/**
 * The thread-title field of `<PersonalizationSettings>`: text typed while an earlier save is still
 * pending must survive that save's cache update, and a saved value must be there after a remount.
 * The settings hooks are replaced by a small in-memory store with a controllable save. The ordering of
 * queued writes belongs to `updateLatest` and is covered in `use-user-settings.test.tsx`.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PersonalizationSettings from "./personalization-settings";

const harness = vi.hoisted(() => {
    const store = {
        listeners: new Set<() => void>(),
        pendingSaves: [] as { land: () => void; resolve: () => void; value: string }[],
        settings: { threadTitleInstructions: undefined as string | undefined },
        userId: "user-1" as string | null,
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

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return { authClient: {} };
        },
    };
});

vi.mock("@/features/auth/hooks/session-user-management", () => {
    return {
        useSession: () => {
            return { data: harness.store.userId === null ? undefined : { user: { id: harness.store.userId } } };
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
    return {
        useUserPreferences: () => {
            return { onboardingCompleted: false, setOnboardingCompleted: vi.fn() };
        },
    };
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
                updateLatest: (build: () => { threadTitleInstructions?: string }) => {
                    const patch = build();
                    // The cache update (`land`) is held back here, so a blur can run before the cache shows the last save.
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
        harness.store.userId = "user-1";
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

    it("sends a reversal made before the cache shows the pending save", () => {
        render(<PersonalizationSettings />);

        fireEvent.change(field(), { target: { value: "Short titles" } });
        fireEvent.blur(field());
        fireEvent.focus(field());
        // Back to the stored value (none) while the first save has not reached the cache.
        fireEvent.change(field(), { target: { value: "" } });
        fireEvent.blur(field());

        expect(harness.store.pendingSaves.map((save) => save.value)).toEqual(["Short titles", ""]);
    });

    it("does not send a blur that repeats the pending save", () => {
        render(<PersonalizationSettings />);

        fireEvent.change(field(), { target: { value: "Short titles" } });
        fireEvent.blur(field());
        fireEvent.focus(field());
        fireEvent.blur(field());

        expect(harness.store.pendingSaves).toHaveLength(1);
    });

    it("keeps a saved value after the card is mounted again", async () => {
        const view = render(<PersonalizationSettings />);

        fireEvent.change(field(), { target: { value: "  Start with a verb  " } });
        fireEvent.blur(field());
        await act(async () => {
            harness.store.pendingSaves[0]?.land();
            harness.store.pendingSaves[0]?.resolve();
        });

        expect(harness.store.pendingSaves[0]?.value).toBe("Start with a verb");

        view.unmount();
        render(<PersonalizationSettings />);

        expect(field().value).toBe("Start with a verb");
    });

    it("does not accept text until the session names the account", () => {
        harness.store.userId = null;

        const view = render(<PersonalizationSettings />);

        expect(field().disabled).toBe(true);

        harness.store.userId = "user-1";
        view.rerender(<PersonalizationSettings />);

        expect(field().disabled).toBe(false);

        fireEvent.change(field(), { target: { value: "Short titles" } });

        expect(field().value).toBe("Short titles");
    });

    it("drops text typed for one account when another signs in, instead of saving it there", () => {
        harness.store.userId = "guest-1";

        const view = render(<PersonalizationSettings />);

        fireEvent.change(field(), { target: { value: "Guest wording" } });

        // Signing in over the guest keeps this page mounted, with the new account's settings.
        harness.store.userId = "user-2";
        view.rerender(<PersonalizationSettings />);

        expect(field().value).toBe("");

        fireEvent.blur(field());

        expect(harness.store.pendingSaves).toHaveLength(0);

        fireEvent.change(field(), { target: { value: "Short titles" } });
        fireEvent.blur(field());

        expect(harness.store.pendingSaves.map((save) => save.value)).toEqual(["Short titles"]);
    });
});
