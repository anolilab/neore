import { describe, expect, it } from "vitest";

import { canConnectFrom, hasFrameEdgeInto } from "./frame-connection";

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

    it("refuses a second frame into a target that already has one, but not any other wire", () => {
        expect(canConnectFrom("frame-end", "video", true)).toBe(false);
        expect(canConnectFrom("frame-start", "image-to-video", false)).toBe(true);
        expect(canConnectFrom("output-0", "video", true)).toBe(true);
    });

    it("sees a frame wire already into the target, and not one into another node", () => {
        const edges = [
            { sourceHandle: "frame-start", target: "gen" },
            { sourceHandle: "output-0", target: "other" },
        ];

        expect(hasFrameEdgeInto(edges, "gen")).toBe(true);
        expect(hasFrameEdgeInto(edges, "other")).toBe(false);
        expect(hasFrameEdgeInto(edges, "missing")).toBe(false);
    });

    it("leaves every other source handle alone", () => {
        expect(canConnectFrom("output-0", "ai")).toBe(true);
        expect(canConnectFrom(null, "text")).toBe(true);
    });
});
