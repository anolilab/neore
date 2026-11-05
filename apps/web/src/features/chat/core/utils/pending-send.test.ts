import { afterEach, describe, expect, it } from "vitest";

import { clearPendingSend, PENDING_SEND_MAX_AGE_MS, savePendingSend, takePendingSend } from "./pending-send";

describe("pending send", () => {
    afterEach(() => {
        sessionStorage.clear();
    });

    it("hands the saved message over once", () => {
        savePendingSend("hello", 1000);

        expect(takePendingSend(2000)).toBe("hello");
        // A second taker (StrictMode's second effect run, another composer) gets nothing.
        expect(takePendingSend(2000)).toBeUndefined();
    });

    it("keeps only the latest message", () => {
        savePendingSend("first", 1000);
        savePendingSend("second", 1000);

        expect(takePendingSend(1000)).toBe("second");
    });

    it("drops a message older than the limit instead of sending it", () => {
        savePendingSend("stale", 0);

        expect(takePendingSend(PENDING_SEND_MAX_AGE_MS + 1)).toBeUndefined();
        expect(takePendingSend(PENDING_SEND_MAX_AGE_MS + 1)).toBeUndefined();
    });

    it("drops a blank or unreadable entry", () => {
        savePendingSend(" ".repeat(3), 1000);

        expect(takePendingSend(1000)).toBeUndefined();

        sessionStorage.setItem("neore:pending-send", "{not json");

        expect(takePendingSend(1000)).toBeUndefined();
        expect(sessionStorage.getItem("neore:pending-send")).toBeNull();
    });

    it("forgets the message when the sign-in prompt is dismissed", () => {
        savePendingSend("hello", 1000);
        clearPendingSend();

        expect(takePendingSend(1000)).toBeUndefined();
    });
});
