import { describe, expect, it } from "vitest";

import { controlRefusalText, isTakenOverByOwnView, leaseHolder } from "./browser-control";

describe(leaseHolder, () => {
    it("tells the view's own lease from another view's of the same person and another person's", () => {
        expect(leaseHolder({ byYou: true, claimIds: ["a"], until: 200 }, "a", 100)).toBe("mine");
        expect(leaseHolder({ byYou: true, claimIds: ["b"], until: 200 }, "a", 100)).toBe("other-view");
        expect(leaseHolder({ byYou: false, until: 200 }, "a", 100)).toBe("other-person");
    });

    it("reads a lease that ended on the server's clock as none", () => {
        expect(leaseHolder({ byYou: true, claimIds: ["a"], until: 100 }, "a", 100)).toBe("none");
        expect(leaseHolder(undefined, "a", 100)).toBe("none");
    });

    it("never calls a lease another view's while the status names no claims or the view holds none", () => {
        expect(isTakenOverByOwnView({ byYou: true, until: 200 }, "a")).toBe(false);
        expect(isTakenOverByOwnView({ byYou: true, claimIds: ["b"], until: 200 }, undefined)).toBe(false);
    });
});

describe(controlRefusalText, () => {
    it("says why control was refused, naming the person's other window for a held lease", () => {
        expect(controlRefusalText("held")).toContain("Hand it back there first");
        expect(controlRefusalText("taken")).toBe("Someone else is controlling this browser.");
        expect(controlRefusalText("unavailable")).toBe("Taking control is not available right now.");
    });
});
