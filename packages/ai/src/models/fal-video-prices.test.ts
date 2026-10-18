import { describe, expect, it } from "vitest";

import { FAL_VIDEO_INPUTS, FAL_VIDEO_PRICES, falVideoFixedSecondsOf, falVideoMicrodollarsOf, falVideoPriceOf, UNPRICED_FAL_VIDEO } from "./fal-video-inputs";
import { MODEL_REGISTRY } from "./registry";

const enabledFalVideoRows = MODEL_REGISTRY.filter((row) => row.mode === "video" && row.provider === "fal" && row.enabled !== false);
const input = (seconds: number, options: { generateAudio?: boolean; resolution?: string } = {}, extra: { images?: number; referenceSeconds?: number } = {}) => {
    return {
        images: extra.images ?? 0,
        options,
        referenceSeconds: extra.referenceSeconds ?? 0,
        seconds,
    };
};

describe("the fal video price table and the registry", () => {
    it("prices or lists as unpriced every enabled fal video row, so a new row cannot ship free", () => {
        for (const row of enabledFalVideoRows) {
            const priced = Object.hasOwn(FAL_VIDEO_PRICES, row.modelApiId);
            const unpriced = Object.hasOwn(UNPRICED_FAL_VIDEO, row.modelApiId);

            expect(priced !== unpriced, `${row.id} must be priced or unpriced, once`).toBe(true);
        }
    });

    it("has no price or unpriced entry for an endpoint without an enabled fal video row", () => {
        const enabled = new Set(enabledFalVideoRows.map((row) => row.modelApiId));

        for (const endpoint of [...Object.keys(FAL_VIDEO_PRICES), ...Object.keys(UNPRICED_FAL_VIDEO)]) {
            expect(enabled.has(endpoint), endpoint).toBe(true);
        }
    });

    it("names only enabled video rows in the unpriced list, each with a reason, and never a priced one", () => {
        const enabled = new Set(enabledFalVideoRows.map((row) => row.modelApiId));

        for (const [endpoint, reason] of Object.entries(UNPRICED_FAL_VIDEO)) {
            expect(enabled.has(endpoint), endpoint).toBe(true);
            expect(reason.length).toBeGreaterThan(0);
            expect(Object.hasOwn(FAL_VIDEO_PRICES, endpoint), endpoint).toBe(false);
        }
    });

    it("prices every resolution the endpoint takes, and only the endpoints that take one", () => {
        for (const [endpoint, price] of Object.entries(FAL_VIDEO_PRICES)) {
            const spec = FAL_VIDEO_INPUTS[endpoint];
            const values = spec && spec !== "unverified" && spec.resolution ? spec.resolution.values : [];

            if (price.byResolution) {
                expect(spec, endpoint).not.toBe("unverified");

                for (const value of values) {
                    expect(price.byResolution, `${endpoint} ${value}`).toHaveProperty([value]);
                }
            } else {
                expect(values, endpoint).toHaveLength(0);
            }
        }
    });

    it("gives an audio-tiered rate only where the endpoint has an audio default to choose it", () => {
        for (const [endpoint, price] of Object.entries(FAL_VIDEO_PRICES)) {
            const rates = [price.rate, ...Object.values(price.byResolution ?? {})];
            const audioTiered = rates.some((rate) => typeof rate === "object");
            const spec = FAL_VIDEO_INPUTS[endpoint];

            if (audioTiered) {
                expect(spec !== "unverified" && typeof spec?.audioDefault === "boolean", endpoint).toBe(true);
            }
        }
    });
});

describe("falVideoMicrodollarsOf", () => {
    it("bills a per-second rate over the billed seconds", () => {
        expect(falVideoMicrodollarsOf("fal-ai/kling-video/v2.5-turbo/pro/text-to-video", input(5))).toBe(350_000);
        expect(falVideoMicrodollarsOf("fal-ai/kling-video/v2.5-turbo/pro/text-to-video", input(10))).toBe(700_000);
        expect(falVideoMicrodollarsOf("fal-ai/veo2", input(5))).toBe(2_500_000);
    });

    it("bills a flat per-clip price regardless of length", () => {
        expect(falVideoMicrodollarsOf("fal-ai/ltx-video", input(5))).toBe(20_000);
        expect(falVideoMicrodollarsOf("fal-ai/stable-video", input(4))).toBe(75_000);
        expect(falVideoMicrodollarsOf("fal-ai/minimax/hailuo-02/pro/image-to-video", input(6))).toBe(480_000);
    });

    it("bills a block tier rounded up per block (Ray 2: 0.50 per 5 s at 540p, 2x at 720p, 4x at 1080p)", () => {
        const ray = "fal-ai/luma-dream-machine/ray-2";

        expect(falVideoMicrodollarsOf(ray, input(5))).toBe(500_000);
        expect(falVideoMicrodollarsOf(ray, input(9))).toBe(1_000_000);
        expect(falVideoMicrodollarsOf(ray, input(5, { resolution: "1080p" }))).toBe(2_000_000);
        expect(falVideoMicrodollarsOf(ray, input(9, { resolution: "1080p" }))).toBe(4_000_000);
        expect(falVideoMicrodollarsOf(ray, input(5, { resolution: "720p" }))).toBe(1_000_000);
    });

    it("bills a duration table by the clip length (Hailuo 2.3 Fast i2v: 0.19 for 6 s, 0.32 for 10 s)", () => {
        const fast = "fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video";

        expect(falVideoMicrodollarsOf(fast, input(6))).toBe(190_000);
        expect(falVideoMicrodollarsOf(fast, input(10))).toBe(320_000);
        expect(falVideoMicrodollarsOf("fal-ai/minimax/hailuo-2.3/standard/text-to-video", input(10))).toBe(560_000);
    });

    it("charges the highest duration tier for a length the table does not list", () => {
        expect(falVideoMicrodollarsOf("fal-ai/minimax/hailuo-2.3/standard/image-to-video", input(8))).toBe(560_000);
    });

    it("bills the endpoint default for a resolution it does not take, since the action sends none", () => {
        expect(falVideoMicrodollarsOf("fal-ai/pika/v2.2/text-to-video", input(5, { resolution: "4k" }))).toBe(200_000);
    });

    it("bills a per-second Hailuo 02 Standard clip at 0.045 whatever the resolution (512P is charged the 768P rate)", () => {
        expect(falVideoMicrodollarsOf("fal-ai/minimax/hailuo-02/standard/image-to-video", input(6, { resolution: "512P" }))).toBe(270_000);
        expect(falVideoMicrodollarsOf("fal-ai/minimax/hailuo-02/standard/image-to-video", input(6, { resolution: "768P" }))).toBe(270_000);
    });

    it("bills a fixed-length endpoint at its fixed length, whatever duration it was asked for", () => {
        expect(falVideoMicrodollarsOf("fal-ai/kling-video/o1/standard/video-to-video/edit", input(3))).toBe(1_260_000);
    });

    it("bills the audio option the endpoint is sent, and its audio default when the option is unset (Veo 3.1)", () => {
        const veo = "fal-ai/veo3.1";

        expect(falVideoMicrodollarsOf(veo, input(5, { generateAudio: true, resolution: "1080p" }))).toBe(2_000_000);
        expect(falVideoMicrodollarsOf(veo, input(5, { generateAudio: false, resolution: "1080p" }))).toBe(1_000_000);
        expect(falVideoMicrodollarsOf(veo, input(5, { resolution: "720p" }))).toBe(2_000_000);
        expect(falVideoMicrodollarsOf(veo, input(5, { generateAudio: false, resolution: "4k" }))).toBe(2_000_000);
        expect(falVideoMicrodollarsOf("fal-ai/veo3.1/fast", input(5, { generateAudio: true, resolution: "1080p" }))).toBe(750_000);
    });

    it("bills Veo 3 and Veo 3 Fast from the widget's audio-off and audio-on rates", () => {
        expect(falVideoMicrodollarsOf("fal-ai/veo3", input(5, { generateAudio: true }))).toBe(2_000_000);
        expect(falVideoMicrodollarsOf("fal-ai/veo3/fast", input(5, { generateAudio: true }))).toBe(750_000);
    });

    it("bills Kling v3 Pro i2v on, its audio default, at 0.168 and off at 0.112 per second", () => {
        expect(falVideoMicrodollarsOf("fal-ai/kling-video/v3/pro/image-to-video", input(5))).toBe(840_000);
        expect(falVideoMicrodollarsOf("fal-ai/kling-video/v3/pro/image-to-video", input(5, { generateAudio: false }))).toBe(560_000);
    });

    it("bills Kling O3 Standard i2v off at 0.084 by default and on at 0.112", () => {
        expect(falVideoMicrodollarsOf("fal-ai/kling-video/o3/standard/image-to-video", input(5))).toBe(420_000);
        expect(falVideoMicrodollarsOf("fal-ai/kling-video/o3/standard/image-to-video", input(5, { generateAudio: true }))).toBe(560_000);
        expect(falVideoMicrodollarsOf("fal-ai/kling-video/o3/4k/image-to-video", input(5))).toBe(2_100_000);
    });

    it("bills Seedance 2.0 from the page's 720p and 1080p rates, and 4k from its token formula", () => {
        const standard = "bytedance/seedance-2.0/text-to-video";

        expect(falVideoMicrodollarsOf("bytedance/seedance-2.0/fast/text-to-video", input(10, { resolution: "720p" }))).toBe(2_419_000);
        expect(falVideoMicrodollarsOf(standard, input(10, { resolution: "720p" }))).toBe(3_034_000);
        expect(falVideoMicrodollarsOf(standard, input(10, { resolution: "1080p" }))).toBe(6_820_000);
        expect(falVideoMicrodollarsOf(standard, input(10, { resolution: "4k" }))).toBe(15_552_000);
    });

    it("bills a Seedance 2.0 reference clip with video inputs at 0.6x over the output and the reference seconds sent", () => {
        const reference = "bytedance/seedance-2.0/reference-to-video";

        expect(falVideoMicrodollarsOf(reference, input(10, { resolution: "720p" }))).toBe(3_034_000);
        // A 2 s generated reference: 0.6 x 0.3034 x (10 + 2) = 2.18.
        expect(falVideoMicrodollarsOf(reference, input(10, { resolution: "720p" }, { referenceSeconds: 2 }))).toBe(2_184_480);
        // A reference of unknown length (an upload) takes the endpoint's 15 s budget: 0.6 x 0.3034 x 25 = 4.55.
        expect(falVideoMicrodollarsOf(reference, input(10, { resolution: "720p" }, { referenceSeconds: 15 }))).toBe(4_551_000);
    });

    it("rounds a reference charge to the nearest microdollar, so an exact multiple does not gain one", () => {
        // Fast 720p at 0.2419 a second: 0.6 x 0.2419 x 15 s = 2.1771, an exact multiple floats can nudge past its last digit.
        expect(falVideoMicrodollarsOf("bytedance/seedance-2.0/fast/reference-to-video", input(10, { resolution: "720p" }, { referenceSeconds: 5 }))).toBe(
            2_177_100,
        );
    });

    it("bills Seedance 1.5 Pro from its token formula, 2.40 with audio and 1.20 without per million tokens", () => {
        const seedance = "fal-ai/bytedance/seedance/v1.5/pro/text-to-video";

        expect(falVideoMicrodollarsOf(seedance, input(5, { generateAudio: true, resolution: "720p" }))).toBe(259_200);
        expect(falVideoMicrodollarsOf(seedance, input(5, { generateAudio: false, resolution: "720p" }))).toBe(129_600);
    });

    it("bills Omni per second by resolution (10 s at 1080p is 1.50, at 360p 0.30)", () => {
        const omni = "google/gemini-omni-flash/v1.1/reference-to-video";

        expect(falVideoMicrodollarsOf(omni, input(10, { resolution: "1080p" }))).toBe(1_500_000);
        expect(falVideoMicrodollarsOf(omni, input(10, { resolution: "360p" }))).toBe(300_000);
    });

    it("bills Grok per second by resolution, plus 0.01 for each image sent", () => {
        const grok = "xai/grok-imagine-video/v1.5/image-to-video";

        expect(falVideoMicrodollarsOf(grok, input(5, { resolution: "720p" }, { images: 1 }))).toBe(710_000);
        expect(falVideoMicrodollarsOf(grok, input(5, { resolution: "480p" }, { images: 0 }))).toBe(400_000);
    });

    it("leaves an endpoint with no price unpriced, rather than pricing it at a sibling's rate", () => {
        expect(falVideoPriceOf("fal-ai/unknown/endpoint")).toBeUndefined();
        expect(falVideoMicrodollarsOf("fal-ai/unknown/endpoint", input(5))).toBeUndefined();
    });

    it("takes the fixed clip length of an endpoint with no duration input from its price", () => {
        expect(falVideoFixedSecondsOf("fal-ai/minimax/video-01")).toBe(6);
        expect(falVideoFixedSecondsOf("fal-ai/minimax/hailuo-02/pro/image-to-video")).toBe(6);
        expect(falVideoFixedSecondsOf("fal-ai/kling-video/o1/standard/video-to-video/edit")).toBe(10);
        expect(falVideoFixedSecondsOf("fal-ai/ltx-video")).toBeUndefined();
    });
});
