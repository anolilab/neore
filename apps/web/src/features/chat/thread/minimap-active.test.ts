import { describe, expect, it } from "vitest";

import { lastReachedId } from "./minimap-active";

describe("lastReachedId", () => {
    it("picks the last prompt, in rail order, that has reached the band", () => {
        expect(lastReachedId(["a", "b", "c", "d"], new Set(["a", "b"]))).toBe("b");
    });

    it("is undefined when no prompt has reached the band yet", () => {
        expect(lastReachedId(["a", "b"], new Set())).toBeUndefined();
    });

    it("skips a prompt that was never observed, so an unmounted row is not picked", () => {
        expect(lastReachedId(["a", "b", "c"], new Set(["a", "c"]))).toBe("c");
        expect(lastReachedId(["a", "b"], new Set(["x"]))).toBeUndefined();
    });
});
