import { describe, expect, it } from "vitest";

import formatMessageTime from "./format-message-time";

/** Newer ICU versions put a narrow no-break space before the AM/PM marker. */
const plain = (text: string): string => text.replaceAll(/\s/g, " ");

const AT = Date.UTC(2026, 9, 19, 17, 32);

describe(formatMessageTime, () => {
    it("shows date and time in the reader's locale", () => {
        expect(plain(formatMessageTime(AT, "en-US", "UTC"))).toBe("10/19/26, 5:32 PM");
        expect(plain(formatMessageTime(AT, "de-DE", "UTC"))).toBe("19.10.26, 17:32");
    });

    it("follows the time zone", () => {
        expect(plain(formatMessageTime(AT, "en-US", "Asia/Tokyo"))).toBe("10/20/26, 2:32 AM");
    });
});
