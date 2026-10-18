import { describe, expect, it } from "vitest";

import { canConnectFrom } from "./frame-connection";

describe("canConnectFrom", () => {
    it("lets a start or last frame feed only a video or image-to-video node", () => {
        expect(canConnectFrom("frame-end", "video")).toBe(true);
        expect(canConnectFrom("frame-start", "image-to-video")).toBe(true);
        expect(canConnectFrom("frame-start", "ai")).toBe(false);
        expect(canConnectFrom("frame-end", "image")).toBe(false);
    });

    it("refuses a saved picked-frame handle, which is no longer a frame the run reads", () => {
        expect(canConnectFrom("frame-picked", "video")).toBe(false);
    });

    it("leaves every other source handle alone", () => {
        expect(canConnectFrom("output-0", "ai")).toBe(true);
        expect(canConnectFrom(null, "text")).toBe(true);
    });
});
