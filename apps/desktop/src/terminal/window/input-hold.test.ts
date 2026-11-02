import { describe, expect, it } from "vitest";

import { createInputHold } from "./input-hold";

describe("createInputHold", () => {
    it("hands over, in order, what the view answered while the shell was starting", () => {
        const hold = createInputHold(100);

        hold.hold("\u{1B}[?62;4c");
        hold.hold("\u{1B}[>0;276;0c");

        expect(hold.take()).toBe("\u{1B}[?62;4c\u{1B}[>0;276;0c");
        expect(hold.take()).toBe("");
    });

    it("forgets what was held for a shell that never started", () => {
        const hold = createInputHold(100);

        hold.hold("abc");
        hold.clear();

        expect(hold.take()).toBe("");
    });

    it("keeps no more than its limit", () => {
        const hold = createInputHold(4);

        hold.hold("abc");
        hold.hold("defg");

        expect(hold.take()).toBe("abcd");
    });
});
