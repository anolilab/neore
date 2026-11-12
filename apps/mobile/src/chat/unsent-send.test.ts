import { describe, expect, it } from "vitest";

import { draftAfterUnsent, withoutUnsentRows } from "./unsent-send";

describe("a send the server never accepted", () => {
    it("puts the prompt back in an empty composer", () => {
        expect(draftAfterUnsent("", "hello")).toBe("hello");
        expect(draftAfterUnsent("  ", "hello")).toBe("hello");
    });

    it("keeps what was typed since, after the prompt", () => {
        expect(draftAfterUnsent("and more", "hello")).toBe("hello\n\nand more");
    });

    it("drops only its own local rows", () => {
        const rows = [{ id: "saved" }, { id: "user-1" }, { id: "pending-1" }];

        expect(withoutUnsentRows(rows, ["user-1", "pending-1"])).toStrictEqual([{ id: "saved" }]);
    });
});
