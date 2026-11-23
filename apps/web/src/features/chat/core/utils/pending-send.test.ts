import { afterEach, describe, expect, it } from "vitest";

import { clearPendingSend, PENDING_SEND_MAX_AGE_MS, savePendingSend, takePendingSend } from "./pending-send";

const CHAT = "/chat/thread-a";

describe("pending send", () => {
    afterEach(() => {
        sessionStorage.clear();
    });

    it("hands the saved message over once, in the chat it was typed in", () => {
        savePendingSend("hello", CHAT, 1000);

        expect(takePendingSend(CHAT, 2000)).toStrictEqual({ text: "hello" });
        // A second taker (StrictMode's second effect run, another composer) gets nothing.
        expect(takePendingSend(CHAT, 2000)).toBeUndefined();
    });

    it("never hands it to another chat, and keeps it for its own", () => {
        savePendingSend("hello", CHAT, 1000);

        expect(takePendingSend("/chat/thread-b", 2000)).toBeUndefined();
        expect(takePendingSend("/chat", 2000)).toBeUndefined();
        expect(takePendingSend("/", 2000)).toBeUndefined();
        expect(takePendingSend(CHAT, 2000)).toStrictEqual({ text: "hello" });
    });

    it("drops a message saved 'in the future', after the clock moved back", () => {
        savePendingSend("hello", CHAT, 10_000);

        expect(takePendingSend(CHAT, 1000)).toBeUndefined();
        expect(sessionStorage.getItem("neore:pending-send")).toBeNull();
    });

    it("keeps only the latest message", () => {
        savePendingSend("first", CHAT, 1000);
        savePendingSend("second", CHAT, 1000);

        expect(takePendingSend(CHAT, 1000)).toStrictEqual({ text: "second" });
    });

    it("drops a message older than the limit instead of sending it", () => {
        savePendingSend("stale", CHAT, 0);

        expect(takePendingSend(CHAT, PENDING_SEND_MAX_AGE_MS + 1)).toBeUndefined();
        expect(sessionStorage.getItem("neore:pending-send")).toBeNull();
    });

    it("drops a blank or unreadable entry, wherever it is read", () => {
        savePendingSend(" ".repeat(3), CHAT, 1000);

        expect(takePendingSend("/chat/other", 1000)).toBeUndefined();
        expect(sessionStorage.getItem("neore:pending-send")).toBeNull();

        sessionStorage.setItem("neore:pending-send", "{not json");

        expect(takePendingSend(CHAT, 1000)).toBeUndefined();
        expect(sessionStorage.getItem("neore:pending-send")).toBeNull();
    });

    it("keeps the draft's not-typed mark across the sign-in, and reads an unknown one as marked", () => {
        savePendingSend("from a link", CHAT, 1000, "promptLink");

        expect(takePendingSend(CHAT, 2000)).toStrictEqual({ draftFrom: "promptLink", text: "from a link" });

        sessionStorage.setItem("neore:pending-send", JSON.stringify({ draftFrom: "somewhere", path: CHAT, savedAt: 1000, text: "hello" }));

        expect(takePendingSend(CHAT, 2000)).toStrictEqual({ draftFrom: "promptLink", text: "hello" });
    });

    it("forgets the message when the sign-in prompt is dismissed", () => {
        savePendingSend("hello", CHAT, 1000);
        clearPendingSend();

        expect(takePendingSend(CHAT, 1000)).toBeUndefined();
    });
});
