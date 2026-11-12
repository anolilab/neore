// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { observeUniverAccessibility } from "./univer-accessibility";

describe(observeUniverAccessibility, () => {
    afterEach(() => {
        vi.useRealTimers();
        document.body.replaceChildren();
    });

    it("resets a canvas's positive tabindex that Univer writes after inserting it", async () => {
        vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });

        const root = document.createElement("div");
        const canvas = document.createElement("canvas");

        document.body.append(root);
        root.append(canvas);

        const stop = observeUniverAccessibility(root);

        // No node is added here: only the attribute changes.
        canvas.setAttribute("tabindex", "1");
        await Promise.resolve();
        vi.advanceTimersToNextFrame();

        expect(canvas.getAttribute("tabindex")).toBe("0");
        stop();
    });
});
