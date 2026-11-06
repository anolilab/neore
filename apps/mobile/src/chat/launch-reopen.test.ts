import { describe, expect, it } from "vitest";

import { canClaimLaunchReopen } from "./launch-reopen";

describe("canClaimLaunchReopen", () => {
    it("is granted to the first screen of a launch only", () => {
        expect(canClaimLaunchReopen()).toBe(true);
        expect(canClaimLaunchReopen()).toBe(false);
        expect(canClaimLaunchReopen()).toBe(false);
    });
});
