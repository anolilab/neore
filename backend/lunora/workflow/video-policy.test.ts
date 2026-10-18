import { MODEL_LOOKUP, type ModelDefinition } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { TEXT_TO_VIDEO_PROVIDERS } from "../chat/lib/video-providers";
import type { WorkflowNode } from "./core";
import { videoKindOf } from "./video-inputs";
import { DEFAULT_VIDEO_SECONDS, premiumVideoErrors, unrunnableVideoErrors, videoDurationOf, videoRequestId, videoRunCost } from "./video-policy";

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

/** Paid-plan, priced 120,000 microdollars a second, and a duration input of 5 or 9 s. */
const PAID = "fal-ai/luma-dream-machine/ray-2";
/** Paid-plan, priced 75,000 a second, with no duration input: the endpoint bills the 5 s default. */
const NO_DURATION = "fal-ai/luma-dream-machine";
/** The free-plan default text-to-video model, with no price. */
const FREE = "fal-ai/ltx-video";

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
    const rate = row(PAID).costPerSecondMicrodollars ?? 0;

    it("bills the 5 s default when a node sets no length, and the length it asks for otherwise", () => {
        expect(DEFAULT_VIDEO_SECONDS).toBe(5);
        expect(videoRunCost(node("n", "video", { mode: "text-to-video", model: PAID }))).toStrictEqual({
            costMicrodollars: 5 * rate,
            seconds: 5,
        });
        expect(videoRunCost(node("n", "image-to-video", { duration: 9, model: PAID }))).toStrictEqual({ costMicrodollars: 9 * rate, seconds: 9 });
    });

    it("bills the length the endpoint is sent, capped at the row's maximum", () => {
        expect(videoDurationOf(node("n", "image-to-video", { duration: 30, model: PAID }), row(PAID))).toStrictEqual({ billed: 9, requested: 9 });
    });

    it("treats a non-finite or non-positive length as unset", () => {
        for (const duration of [NaN, -1, 0, Infinity]) {
            expect(videoRunCost(node("n", "image-to-video", { duration, model: PAID })).seconds).toBe(5);
        }
    });

    it("bills an endpoint with no duration input at the 5 s the gateway bills, never as free", () => {
        const priced = row(NO_DURATION).costPerSecondMicrodollars ?? 0;

        expect(videoRunCost(node("n", "image-to-video", { duration: 3, model: NO_DURATION }))).toStrictEqual({
            costMicrodollars: 5 * priced,
            seconds: 5,
        });
    });

    it("prices every enabled priced video row in both kinds, so none is billed free by accident", () => {
        const priced = [...MODEL_LOOKUP.values()].filter(
            (definition) => definition.mode === "video" && definition.enabled !== false && definition.costPerSecondMicrodollars !== undefined,
        );

        expect(priced.length).toBeGreaterThan(0);

        for (const definition of priced) {
            for (const type of ["video", "image-to-video"]) {
                const { costMicrodollars, seconds } = videoRunCost(node("n", type, { mode: "text-to-video", model: definition.id }));

                expect(seconds).toBeGreaterThan(0);
                expect(costMicrodollars).toBe(Math.round(seconds * (definition.costPerSecondMicrodollars ?? 0)));
            }
        }
    });

    it("does not bill a model with no price", () => {
        expect(videoRunCost(node("n", "video", { mode: "text-to-video", model: FREE })).costMicrodollars).toBeUndefined();
    });
});

describe("videoRequestId", () => {
    it("keys a node's charge on the run and the node", () => {
        expect(videoRequestId("exec-1", "n1")).toBe("workflow-video:exec-1:n1");
        expect(videoRequestId("exec-1", "n2")).not.toBe(videoRequestId("exec-1", "n1"));
        expect(videoRequestId("exec-2", "n1")).not.toBe(videoRequestId("exec-1", "n1"));
    });
});

describe("unrunnableVideoErrors", () => {
    it("accepts the default text-to-video model and an image-to-video node with no model", () => {
        expect(unrunnableVideoErrors([node("n1", "video", { mode: "text-to-video" }), node("n2", "image-to-video", {})])).toStrictEqual([]);
    });

    it("refuses an unknown model, naming the node", () => {
        expect(unrunnableVideoErrors([node("n", "image-to-video", { label: "Still", model: "no-such-model" })])).toStrictEqual([
            `The "Still" node's model no-such-model is not an enabled fal video model`,
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

    it("accepts every enabled fal video row for an image-to-video node", () => {
        const fal = [...MODEL_LOOKUP.values()].filter(
            (definition) => definition.mode === "video" && definition.enabled !== false && definition.provider === "fal",
        );

        expect(fal.length).toBeGreaterThan(0);

        for (const definition of fal) {
            expect(unrunnableVideoErrors([node("i", "image-to-video", { model: definition.id })])).toStrictEqual([]);
        }
    });
});
