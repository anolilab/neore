import { describe, expect, it, vi } from "vitest";

import { onComposerSubmitRequest, requestComposerSubmit } from "./composer-submit";

describe(requestComposerSubmit, () => {
    it("holds a request until the composer subscribes, then delivers it once", () => {
        requestComposerSubmit({ text: "from the quick composer" });

        const first = vi.fn();
        const stopFirst = onComposerSubmitRequest(first);

        expect(first).toHaveBeenCalledExactlyOnceWith({ text: "from the quick composer" });

        stopFirst();

        // Already taken: a composer mounting later does not send it again.
        const second = vi.fn();
        const stopSecond = onComposerSubmitRequest(second);

        expect(second).not.toHaveBeenCalled();

        stopSecond();
    });

    it("delivers requests made while the composer is mounted", () => {
        const handler = vi.fn();
        const stop = onComposerSubmitRequest(handler);

        requestComposerSubmit({ text: "a" });
        requestComposerSubmit({ text: "a" });

        expect(handler).toHaveBeenCalledTimes(2);

        stop();
    });
});
