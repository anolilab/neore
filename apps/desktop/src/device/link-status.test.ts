import { describe, expect, it } from "vitest";

import { describeLink, multiplexingNote } from "./link-status";
import type { ReconnectView } from "./types";

const view = (change: Partial<ReconnectView>): ReconnectView => {
    return {
        attempt: null,
        maxAttempts: 5,
        nextAttemptAt: null,
        phase: "waiting",
        reason: null,
        ...change,
    };
};

describe("describeLink", () => {
    it("names the platform of a connected server", () => {
        expect(describeLink({ connected: true, platform: "linux", reconnect: null }, 0)).toBe("connected (linux)");
    });

    it("says nothing about reconnecting for a server nobody connected", () => {
        expect(describeLink({ connected: false, platform: null, reconnect: null }, 0)).toBe("not connected");
    });

    it("counts down to the next attempt and names the attempt", () => {
        const reconnect = view({ attempt: 2, nextAttemptAt: 10_000 });

        expect(describeLink({ connected: false, platform: null, reconnect }, 6500)).toBe("connection lost — reconnecting (attempt 2 of 5) in 4 s");
        expect(describeLink({ connected: false, platform: null, reconnect }, 99_000)).toContain("in 1 s");
    });

    it("says an attempt is running", () => {
        expect(describeLink({ connected: false, platform: null, reconnect: view({ attempt: 3, phase: "connecting" }) }, 0)).toBe(
            "reconnecting (attempt 3 of 5)…",
        );
        expect(describeLink({ connected: false, platform: null, reconnect: view({ phase: "connecting" }) }, 0)).toBe("reconnecting…");
    });

    it("gives the reason it stopped and points at Retry", () => {
        const text = describeLink({ connected: false, platform: null, reconnect: view({ phase: "gaveUp", reason: "the login was refused" }) }, 0);

        expect(text).toContain("the login was refused");
        expect(text).toContain("Retry");
    });
});

describe("multiplexingNote", () => {
    it("only speaks where connections are not shared", () => {
        expect(multiplexingNote(true)).toBeNull();
        expect(multiplexingNote(false)).toContain("one ssh process of its own");
    });
});
