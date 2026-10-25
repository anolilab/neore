/**
 * The effort shortcuts: each press moves the pending reasoning effort one stop, clamped at both
 * ends, for a model that reasons, and does nothing to the value for one that does not.
 */
import { act, render } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useModelStore } from "@/features/chat/core/stores/model-store";

import ComposerEffortShortcuts from "./composer-effort-shortcuts";

// Unit tests do not compile the Lingui macros.
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { _: (descriptor: { message: string }) => descriptor.message },
                t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@/features/chat/model-settings/reasoning-effort-selector", () => {
    return {
        EFFORT_LABEL_MESSAGES: {
            0: { message: "Low" },
            25: { message: "Medium-Low" },
            50: { message: "Medium" },
            75: { message: "Medium-High" },
            100: { message: "High" },
        },
    };
});

vi.mock("sonner", () => {
    return { toast: { info: vi.fn() } };
});

const { models, thread } = vi.hoisted(() => {
    return {
        models: { current: [] as unknown[] },
        thread: { current: undefined as { reasoningEffort?: number } | undefined },
    };
});

vi.mock("@/features/chat/core/context/chat-context", () => {
    return { useChatThread: () => {return { thread: thread.current }} };
});

vi.mock("@/features/chat/core/hooks/use-current-model", () => {
    return { default: () => "reasoner" };
});

vi.mock("@/hooks/use-feature-flagged-models", () => {
    return { default: () => models.current };
});

const press = (name: "decreaseEffort" | "increaseEffort") => {
    act(() => {
        globalThis.dispatchEvent(new Event(`composer.${name}`));
    });
};

const pendingEffort = () => useModelStore.getState().pendingSettings?.reasoningEffort;

beforeEach(() => {
    useModelStore.getState().setPendingSettings(undefined);
    thread.current = undefined;
    models.current = [{ filterCapabilities: ["reasoning"], id: "reasoner" }];
    vi.mocked(toast.info).mockClear();
});

describe("composer effort shortcuts", () => {
    it("starts from Medium and steps up and down one stop per press", () => {
        render(<ComposerEffortShortcuts />);

        press("increaseEffort");
        expect(pendingEffort()).toBe(75);

        press("increaseEffort");
        expect(pendingEffort()).toBe(100);

        press("decreaseEffort");
        expect(pendingEffort()).toBe(75);
        expect(toast.info).toHaveBeenLastCalledWith("Reasoning effort: Medium-High");
    });

    it("clamps at the highest and the lowest stop", () => {
        render(<ComposerEffortShortcuts />);

        for (let index = 0; index < 6; index += 1) {
            press("increaseEffort");
        }

        expect(pendingEffort()).toBe(100);

        for (let index = 0; index < 8; index += 1) {
            press("decreaseEffort");
        }

        expect(pendingEffort()).toBe(0);
    });

    it("continues from the thread's stored effort when nothing is pending", () => {
        thread.current = { reasoningEffort: 25 };
        render(<ComposerEffortShortcuts />);

        press("increaseEffort");

        expect(pendingEffort()).toBe(50);
    });

    it("keeps the other pending settings", () => {
        useModelStore.getState().setPendingSettings({ language: "de" });
        render(<ComposerEffortShortcuts />);

        press("increaseEffort");

        expect(useModelStore.getState().pendingSettings).toStrictEqual({ language: "de", reasoningEffort: 75 });
    });

    it("leaves the value alone for a model without reasoning", () => {
        models.current = [{ filterCapabilities: [], id: "reasoner" }];
        render(<ComposerEffortShortcuts />);

        press("increaseEffort");

        expect(pendingEffort()).toBeUndefined();
        expect(toast.info).toHaveBeenCalledWith("This model has no reasoning effort");
    });

    it("stops listening when it unmounts", () => {
        const { unmount } = render(<ComposerEffortShortcuts />);

        unmount();
        press("increaseEffort");

        expect(pendingEffort()).toBeUndefined();
    });
});
