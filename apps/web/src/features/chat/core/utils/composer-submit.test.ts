import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    hasPendingComposerAttach,
    onComposerAttachRequest,
    onComposerSubmitRequest,
    requestComposerAttach,
    requestComposerSubmit,
    withdrawComposerAttach,
} from "./composer-submit";

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

/** Takes whatever request is still pending, so each case starts from an empty channel. */
const drainAttach = () => {
    const stop = onComposerAttachRequest("drain", () => {});

    // Any pending request is taken: one for another account is dropped, an untagged one goes to the no-op handler.
    stop();
};

describe(requestComposerAttach, () => {
    beforeEach(() => {
        drainAttach();
    });

    it("joins drops for one account that arrive before the composer takes them, so none is lost", () => {
        const first = new File(["a"], "a.txt");
        const second = new File(["b"], "b.txt");

        requestComposerAttach({ accountId: "u1", files: [first] });
        requestComposerAttach({ accountId: "u1", files: [second] });

        const handler = vi.fn();
        const stop = onComposerAttachRequest("u1", handler);

        expect(handler).toHaveBeenCalledExactlyOnceWith({ accountId: "u1", files: [first, second] });

        stop();
    });

    it("replaces a held drop with one for another account, never mixing their files", () => {
        const mine = new File(["a"], "a.txt");
        const theirs = new File(["b"], "b.txt");

        requestComposerAttach({ accountId: "u1", files: [mine] });
        requestComposerAttach({ accountId: "u2", files: [theirs] });

        const handler = vi.fn();
        const stop = onComposerAttachRequest("u2", handler);

        expect(handler).toHaveBeenCalledExactlyOnceWith({ accountId: "u2", files: [theirs] });

        stop();
    });

    it("drops files meant for another account instead of uploading them", () => {
        requestComposerAttach({ accountId: "u1", files: [new File(["a"], "a.txt")] });

        const handler = vi.fn();
        const stop = onComposerAttachRequest("u2", handler);

        expect(handler).not.toHaveBeenCalled();
        expect(hasPendingComposerAttach()).toBe(false);

        stop();
    });

    it("hands a drop made before the session was known to whichever account takes it", () => {
        const file = new File(["a"], "a.txt");

        requestComposerAttach({ files: [file] });

        const handler = vi.fn();
        const stop = onComposerAttachRequest("u1", handler);

        expect(handler).toHaveBeenCalledExactlyOnceWith({ accountId: undefined, files: [file] });

        stop();
    });
});

describe(withdrawComposerAttach, () => {
    beforeEach(() => {
        drainAttach();
    });

    it("takes back only the files of a drop whose chat did not open", () => {
        const kept = new File(["a"], "a.txt");
        const withdrawn = new File(["b"], "b.txt");

        requestComposerAttach({ accountId: "u1", files: [kept] });
        requestComposerAttach({ accountId: "u1", files: [withdrawn] });
        withdrawComposerAttach([withdrawn]);

        const handler = vi.fn();
        const stop = onComposerAttachRequest("u1", handler);

        expect(handler).toHaveBeenCalledExactlyOnceWith({ accountId: "u1", files: [kept] });

        stop();
    });

    it("leaves nothing pending once every file is taken back", () => {
        const file = new File(["a"], "a.txt");

        requestComposerAttach({ accountId: "u1", files: [file] });

        expect(hasPendingComposerAttach()).toBe(true);

        withdrawComposerAttach([file]);

        expect(hasPendingComposerAttach()).toBe(false);
    });
});
