import { describe, expect, it } from "vitest";

import { canConnectFrom } from "./frame-connection";

describe("canConnectFrom", () => {
    it("lets a captured frame feed only a video or image-to-video node", () => {
        expect(canConnectFrom("frame-end", "video")).toBe(true);
        expect(canConnectFrom("frame-start", "image-to-video")).toBe(true);
        expect(canConnectFrom("frame-picked", "ai")).toBe(false);
        expect(canConnectFrom("frame-picked", "image")).toBe(false);
    });

    it("leaves every other source handle alone", () => {
        expect(canConnectFrom("output-0", "ai")).toBe(true);
        expect(canConnectFrom(null, "text")).toBe(true);
    });
});
