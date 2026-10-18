import { describe, expect, it } from "vitest";

import { isCaptureTargetLoaded, pickedFrameTime, videoUrlOfOutput } from "./video-frame";

describe("pickedFrameTime", () => {
    it("takes the requested time, clamped into the clip and off its final sample", () => {
        expect(pickedFrameTime(5, 2.5)).toBe(2.5);
        expect(pickedFrameTime(5, 9)).toBeCloseTo(5 - 1 / 24);
        expect(pickedFrameTime(5, -1)).toBe(0);
    });
});

describe("videoUrlOfOutput", () => {
    it("returns an https clip url from the stored shape or an older top-level one", () => {
        expect(videoUrlOfOutput({ assets: [{ videoUrl: "https://v3.fal.media/a.mp4" }] })).toBe("https://v3.fal.media/a.mp4");
        expect(videoUrlOfOutput({ videoUrl: "https://v3.fal.media/b.mp4" })).toBe("https://v3.fal.media/b.mp4");
    });

    it("refuses plaintext http, except on a loopback host used in local development", () => {
        // eslint-disable-next-line unicorn/prefer-https -- the case under test is a plaintext url
        expect(videoUrlOfOutput({ videoUrl: "http://example.com/a.mp4" })).toBeUndefined();
        expect(videoUrlOfOutput({ videoUrl: "http://localhost:8788/signed/a.mp4" })).toBe("http://localhost:8788/signed/a.mp4");
    });

    it("refuses other schemes, malformed urls and missing output", () => {
        // eslint-disable-next-line no-script-url -- the case under test is a script url
        expect(videoUrlOfOutput({ videoUrl: "javascript:alert(1)" })).toBeUndefined();
        expect(videoUrlOfOutput({ videoUrl: "httpx://a" })).toBeUndefined();
        expect(videoUrlOfOutput({ videoUrl: "not a url" })).toBeUndefined();
        expect(videoUrlOfOutput(undefined)).toBeUndefined();
    });
});

describe("isCaptureTargetLoaded", () => {
    const start = { nodeId: "video-1", projectId: "wf-a" };

    it("admits the capture while the same workflow is loaded and its video node is still in it", () => {
        expect(isCaptureTargetLoaded({ nodes: [{ id: "video-1" }], projectId: "wf-a" }, start)).toBe(true);
    });

    it("drops the capture once another workflow is loaded, even when a node has the same id", () => {
        expect(isCaptureTargetLoaded({ nodes: [{ id: "video-1" }], projectId: "wf-b" }, start)).toBe(false);
        expect(isCaptureTargetLoaded({ nodes: [{ id: "video-1" }], projectId: null }, start)).toBe(false);
    });

    it("drops the capture when the video node was deleted meanwhile", () => {
        expect(isCaptureTargetLoaded({ nodes: [{ id: "other" }], projectId: "wf-a" }, start)).toBe(false);
    });
});
