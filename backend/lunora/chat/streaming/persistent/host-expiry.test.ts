import { describe, expect, it } from "vitest";

import { HOST_STREAM_IDLE_MS, HOST_TURN_MAX_MS } from "../../../acp/lib/constants";
import { bumpedExpiry } from "./host";

describe("bumpedExpiry", () => {
    it("moves the window on once half of it is gone", () => {
        const now = 1_000_000;

        expect(bumpedExpiry({ _creationTime: now - 1000, expiresAt: now + 1 }, now)).toBe(now + HOST_STREAM_IDLE_MS);
        expect(bumpedExpiry({ _creationTime: now - 1000, expiresAt: now + HOST_STREAM_IDLE_MS }, now)).toBeUndefined();
    });

    it("never moves it past the turn's hard deadline, so keepalives cannot keep a turn open", () => {
        const created = 0;
        const deadline = created + HOST_TURN_MAX_MS;
        const now = deadline - 1000;

        expect(bumpedExpiry({ _creationTime: created, expiresAt: now + 1 }, now)).toBe(deadline);
        // At the deadline the window stays where it is, and the reaper ends the turn.
        expect(bumpedExpiry({ _creationTime: created, expiresAt: deadline }, deadline - 10)).toBeUndefined();
    });
});
