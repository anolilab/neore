/**
 * `expensiveEndpointRateLimit` refuses, at creation, a multiplier that would give a
 * tier a limit with no native binding. Such a limit answers 503 on every request.
 */
import { describe, expect, it } from "vitest";

import { expensiveEndpointRateLimit } from "./rate-limit.js";

const NO_BINDING_RE = /no native rate-limit binding/;

describe("expensiveEndpointRateLimit", () => {
    it.each([1, 0.5])("accepts a multiplier of %s, which gives every tier a bound limit", (tierMultiplier) => {
        expect(() => expensiveEndpointRateLimit({ tierMultiplier })).not.toThrow();
    });

    it("refuses a multiplier that gives a tier an unbound limit", () => {
        expect(() => expensiveEndpointRateLimit({ tierMultiplier: 0.2 })).toThrow(NO_BINDING_RE);
    });
});
