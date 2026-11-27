/**
 * What a failed approval continuation tells the person and a waiting parent: a reason that will not change is said as it is, so
 * the owner is not told to retry something that fails the same way every time.
 */
import { describe, expect, it } from "vitest";

import { LEFT_ORGANIZATION_MESSAGE } from "../../auth/lib/organization-policy";
import { AgentRunError, continuationFailureMessage } from "./agent-run";

describe("continuationFailureMessage", () => {
    it("tells an owner who left the run's organization why, not to retry", () => {
        expect(continuationFailureMessage(new AgentRunError("left-organization", LEFT_ORGANIZATION_MESSAGE))).toBe(LEFT_ORGANIZATION_MESSAGE);
    });

    it("says a request that is no longer pending is gone", () => {
        expect(continuationFailureMessage(new AgentRunError("stale-approval", "anything"))).toBe("This tool request is no longer pending.");
    });

    it("asks for a retry after any other failure, without its details", () => {
        expect(continuationFailureMessage(new Error("gateway timed out"))).toBe("An error occurred while continuing the response. Please try again.");
    });
});
