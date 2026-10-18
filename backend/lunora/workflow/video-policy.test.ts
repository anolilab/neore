import { MODEL_LOOKUP, type ModelDefinition, UNPRICED_FAL_VIDEO } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { TEXT_TO_VIDEO_PROVIDERS } from "../chat/lib/video-providers";
import type { WorkflowEdge, WorkflowNode } from "./core";
import { DEFAULT_VIDEO_SECONDS, videoDurationOf, videoKindOf } from "./video-inputs";
import {
    frameClipSeconds,
    frameExtractionMicrodollars,
    frameRequestId,
    premiumVideoErrors,
    unrunnableVideoErrors,
    videoRequestId,
    videoRunCost,
} from "./video-policy";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode => {
    return { data, id, position: { x: 0, y: 0 }, type };
};

/** A registry row the tests name by id. A missing row fails here, not as a vacuous pass. */
const row = (id: string): ModelDefinition => {
    const definition = MODEL_LOOKUP.get(id);

    if (!definition) {
        throw new Error(`fixture ${id} is not in the registry`);
    }

    return definition;
};

const registry = [...MODEL_LOOKUP.values()];

/** Paid-plan, 0.50 per 5 s block at 540p, and a duration input of 5 or 9 s. */
const PAID = "fal-ai/luma-dream-machine/ray-2";
/** The free-plan default text-to-video model, with no price. */
const FREE = "fal-ai/ltx-video";
/** Paid-plan, 0.50 per clip, with no duration input. */
const NO_DURATION = "fal-ai/luma-dream-machine";

describe("videoKindOf", () => {
    it("reads the kind from the node type or the mode, and gives no kind to a non-video node", () => {
        expect(videoKindOf(node("a", "video", { mode: "text-to-video" }))).toBe("textToVideo");
        expect(videoKindOf(node("b", "video", { mode: "image-to-video" }))).toBe("imageToVideo");
        expect(videoKindOf(node("c", "image-to-video", { mode: "text-to-video" }))).toBe("imageToVideo");
        expect(videoKindOf(node("d", "text", {}))).toBeUndefined();
    });
});

describe("premiumVideoErrors", () => {
    it("refuses a paid-plan video model on a free plan, naming the node and the model", () => {
        const nodes = [node("n1", "video", { label: "Hero", mode: "text-to-video", model: PAID })];

        expect(premiumVideoErrors(nodes, false)).toStrictEqual([`The "Hero" node: ${row(PAID).name} needs a Pro plan. Pick a free model or upgrade.`]);
    });

    it("allows a paid plan or an admin, and a free model on a free plan", () => {
        const nodes = [node("n1", "image-to-video", { model: PAID }), node("n2", "video", { mode: "text-to-video", model: FREE })];

        expect(premiumVideoErrors(nodes, true)).toStrictEqual([]);
        expect(premiumVideoErrors(nodes, false)).toHaveLength(1);
    });

    it("ignores nodes that are not video nodes", () => {
        expect(premiumVideoErrors([node("t", "text", { model: PAID })], false)).toStrictEqual([]);
    });
});

describe("videoDurationOf and videoRunCost", () => {
    const PAID_OPTIONS = { paidPlan: true, referenceSeconds: 0, startImage: false };

    it("bills the 5 s default when a node sets no length, and the length it asks for otherwise", () => {
        expect(DEFAULT_VIDEO_SECONDS).toBe(5);
        // Ray 2 is 0.50 per 5 s block at 540p: the default 5 s is one block.
        expect(videoRunCost(node("n", "video", { mode: "text-to-video", model: PAID }), PAID_OPTIONS)).toStrictEqual({
            costMicrodollars: 500_000,
            seconds: 5,
        });
        expect(videoRunCost(node("n", "image-to-video", { duration: 9, model: PAID }), PAID_OPTIONS)).toStrictEqual({
            costMicrodollars: 1_000_000,
            seconds: 9,
        });
    });

    it("bills the length the endpoint is sent, capped at the row's maximum", () => {
        expect(videoDurationOf(node("n", "image-to-video", { duration: 30, model: PAID }), row(PAID))).toStrictEqual({ billed: 9, requested: 9 });
    });

    it("treats a non-finite or non-positive length as unset", () => {
        for (const duration of [NaN, -1, 0, Infinity]) {
            expect(videoRunCost(node("n", "image-to-video", { duration, model: PAID }), PAID_OPTIONS).seconds).toBe(5);
        }
    });

    it("bills an endpoint with no duration input by its own price, whatever length was asked for", () => {
        // Luma Dream Machine is 0.50 per clip; the length it was asked for is not sent, so it does not change the price.
        expect(videoRunCost(node("n", "image-to-video", { duration: 3, model: NO_DURATION }), PAID_OPTIONS).costMicrodollars).toBe(500_000);
    });

    it("prices every enabled fal video row in both kinds, and leaves unpriced only the rows the table lists as unpriced", () => {
        // Every provider the video actions run (fal and the text-to-video providers), so a new row cannot ship unbilled.
        const falRows = registry.filter(
            (definition) =>
                definition.mode === "video" &&
                definition.enabled !== false &&
                (definition.provider === "fal" || TEXT_TO_VIDEO_PROVIDERS.includes(definition.provider)),
        );

        expect(falRows.length).toBeGreaterThan(0);

        for (const definition of falRows) {
            for (const type of ["video", "image-to-video"]) {
                const { costMicrodollars, seconds } = videoRunCost(node("n", type, { mode: "text-to-video", model: definition.id }), PAID_OPTIONS);

                expect(seconds).toBeGreaterThan(0);
                expect(costMicrodollars === undefined, definition.id).toBe(definition.modelApiId in UNPRICED_FAL_VIDEO);
            }
        }
    });

    it("caps Pika at its registry maximum of 5 s, which its flat per-clip price assumes, whatever length is asked", () => {
        const pika = "fal-ai/pika/v2.2/text-to-video";

        expect(row(pika).maxVideoDuration).toBe(5);
        expect(videoDurationOf(node("n", "video", { duration: 10, mode: "text-to-video", model: pika }), row(pika))).toStrictEqual({
            billed: 5,
            requested: 5,
        });
        expect(videoRunCost(node("n", "video", { duration: 10, mode: "text-to-video", model: pika }), PAID_OPTIONS).costMicrodollars).toBe(200_000);
    });

    it("bills the fixed clip length of an endpoint with no duration input, such as MiniMax video-01's 6 s", () => {
        const minimax = node("n", "video", { mode: "text-to-video", model: "fal-ai/minimax/video-01" });

        expect(videoDurationOf(minimax, row("fal-ai/minimax/video-01")).billed).toBe(6);
        expect(frameClipSeconds(minimax)).toBe(6);
    });

    it("does not bill a model with no price", () => {
        const unpriced = "fal-ai/unknown/endpoint";

        expect(videoRunCost(node("n", "video", { mode: "text-to-video", model: unpriced }), PAID_OPTIONS).costMicrodollars).toBeUndefined();
    });

    it("bills the resolution the action sends: a free plan is held to 1080p, a paid plan keeps 4k", () => {
        const veo = node("n", "video", { duration: 6, generateAudio: true, mode: "text-to-video", model: "fal-ai/veo3.1", resolution: "4k" });

        // Veo 3.1 at 4k with audio is 0.60 a second; held to 1080p on a free plan, it is 0.40.
        expect(videoRunCost(veo, { paidPlan: true, referenceSeconds: 0, startImage: false }).costMicrodollars).toBe(3_600_000);
        expect(videoRunCost(veo, { paidPlan: false, referenceSeconds: 0, startImage: false }).costMicrodollars).toBe(2_400_000);
    });

    it("bills the start image a text-to-video node sends when a frame is wired (Grok takes 0.01 an image)", () => {
        const grok = "fal/grok-imagine-video-1-5";
        const text = node("n", "video", { mode: "text-to-video", model: grok, resolution: "720p" });

        expect(videoRunCost(text, { paidPlan: true, referenceSeconds: 0, startImage: false }).costMicrodollars).toBe(700_000);
        expect(videoRunCost(text, { paidPlan: true, referenceSeconds: 0, startImage: true }).costMicrodollars).toBe(710_000);
    });

    it("bills a frame extraction at 0.0002 a second of its source clip, and the default clip when there is no video source", () => {
        expect(frameExtractionMicrodollars(5)).toBe(1000);
        expect(frameExtractionMicrodollars(9)).toBe(1800);
        expect(frameClipSeconds(undefined)).toBe(5);
        expect(frameClipSeconds(node("t", "text", {}))).toBe(5);
        expect(frameClipSeconds(node("v", "video", { duration: 9, mode: "text-to-video", model: PAID }))).toBe(9);
    });

    it("keys a frame extraction on the run and the source clip, not the node that reads it", () => {
        expect(frameRequestId("run", "src", "end")).toBe(`workflow-frame:${JSON.stringify(["run", "src", "end"])}`);
    });
});

describe("videoRequestId", () => {
    it("never gives a clip charge the key of a frame extraction, whatever the ids contain", () => {
        // Ids are user-controlled, so these include the separators and the frame suffix the old join used.
        const ids = ["a", "a:b", "frame-start", "a:frame-start", ":", "", "run:x"];
        const clips = new Set(ids.flatMap((runId) => ids.map((nodeId) => videoRequestId(runId, nodeId))));
        const frames = new Set(
            ids.flatMap((runId) => ids.flatMap((sourceId) => ["start", "end"].map((kind) => frameRequestId(runId, sourceId, kind as "start" | "end")))),
        );

        // Distinct (run, node) pairs never collide, and no clip key is any frame key.
        expect(clips.size).toBe(ids.length * ids.length);
        expect(frames.size).toBe(ids.length * ids.length * 2);

        for (const clip of clips) {
            expect(frames.has(clip), clip).toBe(false);
        }
    });

    it("keeps a ':' inside an id from joining two different pairs into one key", () => {
        expect(videoRequestId("a:b", "c")).not.toBe(videoRequestId("a", "b:c"));
        expect(videoRequestId("run", "a:frame-start")).not.toBe(frameRequestId("run", "a", "start"));
    });

    it("keys a node's charge on the run and the node", () => {
        expect(videoRequestId("exec-1", "n1")).toBe(`workflow-video:${JSON.stringify(["exec-1", "n1"])}`);
        expect(videoRequestId("exec-1", "n2")).not.toBe(videoRequestId("exec-1", "n1"));
        expect(videoRequestId("exec-2", "n1")).not.toBe(videoRequestId("exec-1", "n1"));
    });
});

describe("unrunnableVideoErrors: an image-only model", () => {
    // An enabled fal video row that takes an image and no text-only generation (the action throws without a start image).
    const imageOnlyRow = (): ModelDefinition | undefined => {
        for (const definition of MODEL_LOOKUP.values()) {
            if (
                definition.mode === "video" &&
                definition.provider === "fal" &&
                definition.enabled !== false &&
                definition.supportsImageToVideo &&
                !definition.supportsTextToVideo &&
                TEXT_TO_VIDEO_PROVIDERS.includes(definition.provider)
            ) {
                return definition;
            }
        }

        return undefined;
    };

    const imageOnly = imageOnlyRow();

    const edge = (source: string, target: string, sourceHandle?: string): WorkflowEdge => {
        return { id: `${source}-${target}`, source, sourceHandle, target };
    };

    it("has a registry fixture", () => {
        expect(imageOnly, "no enabled image-only fal video row in the registry").toBeDefined();
    });

    it("is refused before any unit is spent when no image reaches the node", () => {
        const t2v = node("t", "video", { label: "Clip", mode: "text-to-video", model: imageOnly?.id });

        expect(unrunnableVideoErrors([t2v], [])).toStrictEqual([`The "Clip" node's model ${imageOnly?.id} needs an image input; wire in an image or a frame`]);
    });

    it("is accepted with a wire from an image source or a frame wire", () => {
        const t2v = node("t", "video", { label: "Clip", mode: "text-to-video", model: imageOnly?.id });
        const image = node("i", "image", { mode: "input" });
        const clip = node("c", "video", { mode: "text-to-video" });

        expect(unrunnableVideoErrors([t2v, image], [edge("i", "t")])).toStrictEqual([]);
        expect(unrunnableVideoErrors([t2v, clip], [edge("c", "t", "frame-end")])).toStrictEqual([]);
    });

    it("is still refused when only a text wire reaches it, since text is not an image", () => {
        const t2v = node("t", "video", { label: "Clip", mode: "text-to-video", model: imageOnly?.id });
        const text = node("x", "text", { mode: "input" });

        expect(unrunnableVideoErrors([t2v, text], [edge("x", "t")])).toHaveLength(1);
    });
});

describe("unrunnableVideoErrors", () => {
    it("accepts the default text-to-video model and an image-to-video node with no model", () => {
        expect(unrunnableVideoErrors([node("n1", "video", { mode: "text-to-video" }), node("n2", "image-to-video", {})])).toStrictEqual([]);
    });

    it("refuses an unknown model, naming the node", () => {
        expect(unrunnableVideoErrors([node("n", "image-to-video", { label: "Still", model: "no-such-model" })])).toStrictEqual([
            `The "Still" node's model no-such-model is not an enabled fal image-to-video model`,
        ]);
    });

    it("refuses an enabled text-only fal row for an image-to-video node: the row takes no image input", () => {
        const textOnly = registry.find(
            (definition) =>
                definition.mode === "video" &&
                definition.enabled !== false &&
                definition.provider === "fal" &&
                definition.supportsTextToVideo === true &&
                definition.supportsImageToVideo !== true,
        );

        expect(textOnly, "an enabled fal text-only video row").toBeDefined();
        expect(unrunnableVideoErrors([node("i", "image-to-video", { label: "Still", model: textOnly?.id })])).toStrictEqual([
            `The "Still" node's model ${textOnly?.id} is not an enabled fal image-to-video model`,
        ]);
    });

    it("refuses a text-to-video model on a provider the action does not call, and an image-to-video model off fal", () => {
        const offText = registry.find(
            (definition) => definition.mode === "video" && definition.enabled !== false && !TEXT_TO_VIDEO_PROVIDERS.includes(definition.provider),
        );
        const offFal = registry.find((definition) => definition.mode === "video" && definition.enabled !== false && definition.provider !== "fal");

        expect(offText).toBeDefined();
        expect(offFal).toBeDefined();
        expect(unrunnableVideoErrors([node("t", "video", { mode: "text-to-video", model: offText?.id })])).toHaveLength(1);
        expect(unrunnableVideoErrors([node("i", "image-to-video", { model: offFal?.id })])).toHaveLength(1);
    });

    it("accepts every enabled fal row that takes an image input for an image-to-video node", () => {
        const fal = [...MODEL_LOOKUP.values()].filter(
            (definition) =>
                definition.mode === "video" && definition.enabled !== false && definition.provider === "fal" && definition.supportsImageToVideo === true,
        );

        expect(fal.length).toBeGreaterThan(0);

        for (const definition of fal) {
            expect(unrunnableVideoErrors([node("i", "image-to-video", { model: definition.id })])).toStrictEqual([]);
        }
    });
});
