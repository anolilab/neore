import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatLifecycleControls from "./chat-lifecycle-settings";

const state = vi.hoisted(() => {
    return {
        mutate: vi.fn((_changes: unknown, _options: unknown) => undefined),
        settings: undefined as undefined | Record<string, unknown>,
        updateLatest: vi.fn((_build: (current: unknown) => unknown) => Promise.resolve()),
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/auth/hooks/use-user-settings", () => {
    return {
        useUpdateUserSettings: () => {
            return { isPending: false, mutate: state.mutate, updateLatest: state.updateLatest };
        },
        useUserSettings: () => {
            return { data: state.settings };
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { error: vi.fn(), success: vi.fn() } };
});

beforeEach(() => {
    // The select positions its popup with a ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
        "ResizeObserver",
        class {
            disconnect = vi.fn();

            observe = vi.fn();

            unobserve = vi.fn();
        },
    );
    // Loaded, with no value set: the switch is usable. The loading state is tested on its own below.
    state.settings = {};
    state.mutate.mockClear();
    state.updateLatest.mockClear();
    state.updateLatest.mockImplementation(() => Promise.resolve());
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
});

/** The patch the switch queued: the write builds it from the cache as it stands when its turn comes. */
const queuedPatch = (): unknown => {
    const build = state.updateLatest.mock.calls[0]?.[0];

    return build?.(undefined);
};

describe("ChatLifecycleControls: auto-archive merged chats", () => {
    it("is off when the user never set it", () => {
        render(<ChatLifecycleControls />);

        expect(screen.getByRole("switch", { name: "Auto-archive merged chats" }).getAttribute("aria-checked")).toBe("false");
    });

    it("is disabled until the settings load, so a choice cannot be queued before the server's value is known", () => {
        state.settings = undefined;
        render(<ChatLifecycleControls />);

        const control = screen.getByRole("switch", { name: "Auto-archive merged chats" });

        expect(control.hasAttribute("disabled") || control.dataset.disabled !== undefined).toBe(true);
    });

    it("shows it on when the user turned it on", () => {
        state.settings = { autoArchiveMergedChats: true };
        render(<ChatLifecycleControls />);

        expect(screen.getByRole("switch", { name: "Auto-archive merged chats" }).getAttribute("aria-checked")).toBe("true");
    });

    it("queues the setting as a boolean when the user turns it on", () => {
        render(<ChatLifecycleControls />);

        fireEvent.click(screen.getByRole("switch", { name: "Auto-archive merged chats" }));

        expect(state.updateLatest).toHaveBeenCalledTimes(1);
        expect(queuedPatch()).toStrictEqual({ autoArchiveMergedChats: true });
    });

    it("queues the setting as false when the user turns it off", () => {
        state.settings = { autoArchiveMergedChats: true };
        render(<ChatLifecycleControls />);

        fireEvent.click(screen.getByRole("switch", { name: "Auto-archive merged chats" }));

        expect(queuedPatch()).toStrictEqual({ autoArchiveMergedChats: false });
    });

    it("shows the reason a save was refused, not a generic message", async () => {
        state.updateLatest.mockImplementation(() => Promise.reject(new Error("Too many changes; try again shortly")));
        render(<ChatLifecycleControls />);

        fireEvent.click(screen.getByRole("switch", { name: "Auto-archive merged chats" }));

        await waitFor(() => {
            expect(toast.error).toHaveBeenCalledWith("Too many changes; try again shortly");
        });
    });

    it("announces only the newest of two quick toggles, once it is saved", async () => {
        const settled: (() => void)[] = [];

        state.updateLatest.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    settled.push(resolve);
                }),
        );
        const { rerender } = render(<ChatLifecycleControls />);

        fireEvent.click(screen.getByRole("switch", { name: "Auto-archive merged chats" }));

        // The first write has landed in the cache by the time of the second toggle: the switch shows on, and this toggle turns it off.
        state.settings = { autoArchiveMergedChats: true };
        rerender(<ChatLifecycleControls />);
        fireEvent.click(screen.getByRole("switch", { name: "Auto-archive merged chats" }));

        // The first save lands and its callbacks run; the second is still pending, so nothing is announced yet.
        settled[0]?.();
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        expect(toast.success).not.toHaveBeenCalled();

        settled[1]?.();

        await waitFor(() => {
            expect(toast.success).toHaveBeenCalledTimes(1);
        });
        expect(toast.success).toHaveBeenCalledWith("Merged chats stay as they are");
        expect(state.updateLatest.mock.calls[1]?.[0]?.(undefined)).toStrictEqual({ autoArchiveMergedChats: false });
    });
});

const KEEP_PULL_REQUESTS = /Keep chats with an open pull request/u;

describe("the open pull request toggle", () => {
    it("is on when the setting was never set, since keeping such chats is the default", () => {
        render(<ChatLifecycleControls />);

        expect(screen.getByRole("switch", { name: KEEP_PULL_REQUESTS }).getAttribute("aria-checked")).toBe("true");
    });

    it("shows off when the person turned it off", () => {
        state.settings = { keepOpenPullRequestChats: false };

        render(<ChatLifecycleControls />);

        expect(screen.getByRole("switch", { name: KEEP_PULL_REQUESTS }).getAttribute("aria-checked")).toBe("false");
    });

    it("saves off when the person switches it off", async () => {
        render(<ChatLifecycleControls />);

        await userEvent.click(screen.getByRole("switch", { name: KEEP_PULL_REQUESTS }));

        expect(state.mutate).toHaveBeenCalledWith({ keepOpenPullRequestChats: false }, expect.anything());
    });
});
