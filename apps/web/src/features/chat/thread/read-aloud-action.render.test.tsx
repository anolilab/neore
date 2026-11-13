/* eslint-disable max-classes-per-file -- two inert stand-ins for browser APIs jsdom lacks */

/**
 * Read aloud ends with the message's row. Rows are never unmounted by scrolling (the message list keeps them all), so
 * a row goes only when its thread does: leaving a thread, the shared thread page included, stops the reading.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReadAloudAction from "./read-aloud-action";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

/* eslint-disable class-methods-use-this -- inert stand-ins for browser APIs jsdom lacks */
/** An utterance that never ends on its own, like a long reply still being read. */
class SilentUtterance {
    public lang = "";

    public constructor(public readonly text: string) {}

    public addEventListener(): void {}
}

/** The button's tooltip positions itself with an observer the setup's stub cannot construct. */
class InertResizeObserver {
    public disconnect(): void {}

    public observe(): void {}

    public unobserve(): void {}
}
/* eslint-enable class-methods-use-this */

describe("read aloud", () => {
    const speech = { cancel: vi.fn(), speak: vi.fn() };

    beforeEach(() => {
        speech.cancel.mockClear();
        speech.speak.mockClear();
        vi.stubGlobal("speechSynthesis", speech);
        vi.stubGlobal("SpeechSynthesisUtterance", SilentUtterance);
        vi.stubGlobal("ResizeObserver", InertResizeObserver);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("keeps reading while the message stays on the page, and stops when the message leaves it", async () => {
        const user = userEvent.setup();
        const { unmount } = render(<ReadAloudAction messageId="m1" text="A long reply." />);

        await user.click(screen.getByRole("button", { name: "Read aloud" }));

        const cancelsWhileStarting = speech.cancel.mock.calls.length;

        expect(speech.speak).toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Stop reading" })).toBeTruthy();

        // Leaving the thread (a shared thread's page as well) unmounts the row.
        unmount();

        expect(speech.cancel.mock.calls.length).toBeGreaterThan(cancelsWhileStarting);
    });
});
