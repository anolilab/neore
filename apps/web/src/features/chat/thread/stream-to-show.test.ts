import { describe, expect, it } from "vitest";

import { selectStreamIdToShow, selectStreamTokenFor } from "./stream-to-show";

describe(selectStreamIdToShow, () => {
    it("prefers the live stream id", () => {
        expect(selectStreamIdToShow("live", "pending", { role: "user" })).toBe("live");
    });

    it("shows the stream this client started before the live query reports it", () => {
        expect(selectStreamIdToShow(null, "pending", { role: "user" })).toBe("pending");
        expect(selectStreamIdToShow(null, "pending", undefined)).toBe("pending");
    });

    it("drops the started stream once the reply has settled", () => {
        expect(selectStreamIdToShow(null, "pending", { role: "assistant", status: "success" })).toBeNull();
        expect(selectStreamIdToShow(null, "pending", { role: "assistant", status: "failed" })).toBeNull();
        expect(selectStreamIdToShow(null, "pending", { role: "assistant", status: "pending" })).toBe("pending");
    });

    it("shows nothing with neither", () => {
        expect(selectStreamIdToShow(null, null, { role: "user" })).toBeNull();
        expect(selectStreamIdToShow(null, undefined, { role: "user" })).toBeNull();
    });
});

describe(selectStreamTokenFor, () => {
    it("hands out the started stream's token for that stream", () => {
        expect(selectStreamTokenFor("pending", "pending", "token")).toBe("token");
    });

    it("never pairs the token with a different live stream", () => {
        // A regenerate reported by the live query while the previous send's credentials linger.
        expect(selectStreamTokenFor("regenerated", "previous", "previous-token")).toBeNull();
    });

    it("has no token without a stream or credentials", () => {
        expect(selectStreamTokenFor(null, "pending", "token")).toBeNull();
        expect(selectStreamTokenFor("pending", null, null)).toBeNull();
    });
});
