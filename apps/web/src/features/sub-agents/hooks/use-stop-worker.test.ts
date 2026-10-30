import { describe, expect, it } from "vitest";

import { quietMinutesAt } from "./use-stop-worker";

const MINUTE = 60_000;

describe(quietMinutesAt, () => {
    it("is null for a worker that is not running, or still within the threshold", () => {
        expect(quietMinutesAt(10 * MINUTE, null, 5 * MINUTE)).toBeNull();
        expect(quietMinutesAt(10 * MINUTE, 6 * MINUTE, 5 * MINUTE)).toBeNull();
    });

    it("counts whole minutes of silence once the threshold has passed", () => {
        expect(quietMinutesAt(10 * MINUTE, 5 * MINUTE, 5 * MINUTE)).toBe(5);
        expect(quietMinutesAt(10 * MINUTE + 59_000, 5 * MINUTE, 5 * MINUTE)).toBe(5);
    });
});
