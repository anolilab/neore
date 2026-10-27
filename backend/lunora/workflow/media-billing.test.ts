import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import type { WorkflowNode } from "./core";
import { imageCountOf, mediaKindOf, mediaRequestId, withMediaCharge, workflowMediaErrors } from "./media-billing";
import type { RunAccount } from "./run-setup";
import { workflowRunErrors } from "./run-setup";
import { executionContextOf } from "./test-execution-context";

const node = (id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode => {
    return { data, id, position: { x: 0, y: 0 }, type };
};

const account = (overrides: Partial<RunAccount> = {}): RunAccount => {
    return { isAdmin: false, isAnonymous: false, orgId: "org-1", plan: null, ...overrides };
};

/** Every `case` label of both dispatchers, with the quota its node draws on. */
const KIND_BY_CASE: Record<string, ReturnType<typeof mediaKindOf>> = {
    "advanced-controls": undefined,
    ai: undefined,
    audio: "Audio",
    "background-removal": "Image",
    branch: undefined,
    "character-ref": "Image",
    code: undefined,
    controlnet: "Image",
    file: undefined,
    image: "Image",
    "image-to-video": "Video",
    img2img: "Image",
    inpaint: "Image",
    "object-editor": "Image",
    outpaint: "Image",
    output: undefined,
    "parallel-compare": "Image",
    "style-ref": "Image",
    text: undefined,
    transcription: "Audio",
    upscale: "Image",
    video: "Video",
};

const byName = (a: string, b: string): number => a.localeCompare(b);

const caseLabelsOf = (file: string): string[] =>
    [...readFileSync(join(import.meta.dirname, file), "utf8").matchAll(/^ +case "([\w-]+)":/gm)].map((match) => match[1] as string).toSorted(byName);

describe(mediaKindOf, () => {
    it.each(["executor.ts", "http.ts"])("classifies every case label of %s", (file) => {
        expect(caseLabelsOf(file)).toStrictEqual(Object.keys(KIND_BY_CASE).toSorted(byName));
    });

    it.each(Object.entries(KIND_BY_CASE))("%s → %s", (type, kind) => {
        expect(mediaKindOf(node("n", type, { mode: "generate" }))).toBe(kind);
    });

    it("does not count an input image node, which runs nothing", () => {
        expect(mediaKindOf(node("n", "image", { mode: "input" }))).toBeUndefined();
    });
});

describe(workflowMediaErrors, () => {
    it("refuses a guest with an image node once", () => {
        expect(
            workflowRunErrors(account({ isAnonymous: true }), { edges: [], nodes: [node("i", "image", { mode: "generate", prompt: "a cat" })] }),
        ).toStrictEqual(["Create an account to generate media in a workflow"]);
    });

    it("leaves a guest with a video node the video message only", () => {
        const nodes = [node("v", "video", { prompt: "a cat" }), node("i", "image", { mode: "generate" })];

        expect(workflowMediaErrors(account({ isAnonymous: true }), nodes)).toStrictEqual([]);
        expect(workflowRunErrors(account({ isAnonymous: true }), { edges: [], nodes })).toStrictEqual(["Create an account to generate video in a workflow"]);
    });

    it("lets a signed-in user run an image node", () => {
        expect(workflowMediaErrors(account(), [node("i", "image", { mode: "generate" })])).toStrictEqual([]);
    });

    it("lets a guest run a text-only graph", () => {
        expect(workflowMediaErrors(account({ isAnonymous: true }), [node("t", "text"), node("o", "output")])).toStrictEqual([]);
    });
});

describe(withMediaCharge, () => {
    const run = executionContextOf({ orgId: "org-1" });

    it("takes the daily units the executor asks for, then runs the paid call", async () => {
        const runMutation = vi.fn(async () => true);
        const paid = vi.fn(async () => "url");

        await expect(
            withMediaCharge({ runMutation } as never, run, node("i", "upscale"), "user-1", async (charge) => {
                await charge(3);

                return await paid();
            }),
        ).resolves.toBe("url");
        expect(runMutation).toHaveBeenCalledExactlyOnceWith(internal.chat.daily_charge.chargeDailyUnit, {
            count: 3,
            kind: "Image",
            organizationId: "org-1",
            requestId: mediaRequestId("run", "i"),
            userId: "user-1",
        });
        expect(paid).toHaveBeenCalledOnce();
    });

    it("charges a three-image node three units in one keyed charge, and a parallel-compare node one per model", async () => {
        const runMutation = vi.fn(async () => true);

        await withMediaCharge({ runMutation } as never, run, node("i", "image", { mode: "generate" }), "user-1", async (charge) => {
            await charge(imageCountOf(3));
        });
        await withMediaCharge({ runMutation } as never, run, node("p", "parallel-compare"), "user-1", async (charge) => {
            await charge(4);
        });

        expect(runMutation.mock.calls.map(([, args]: any[]) => [args.count, args.kind, args.requestId])).toStrictEqual([
            [3, "Image", mediaRequestId("run", "i")],
            [4, "Image", mediaRequestId("run", "p")],
        ]);
    });

    it("runs no paid call when a multi-image charge is refused", async () => {
        const paid = vi.fn(async () => "url");

        await expect(
            withMediaCharge({ runMutation: vi.fn(async () => false) } as never, run, node("i", "image", { mode: "generate" }), "user-1", async (charge) => {
                await charge(3);

                return await paid();
            }),
        ).rejects.toThrow("daily image generation limit");
        expect(paid).not.toHaveBeenCalled();
    });

    it("takes nothing when the executor fails validation before it charges", async () => {
        const runMutation = vi.fn(async () => true);

        await withMediaCharge({ runMutation } as never, run, node("i", "image"), "user-1", async () => {
            return { error: "No prompt provided" };
        });

        expect(runMutation).not.toHaveBeenCalled();
    });

    it("charges an audio node to the audio quota", async () => {
        const runMutation = vi.fn(async () => true);

        await withMediaCharge({ runMutation } as never, run, node("a", "transcription"), "user-1", async (charge) => {
            await charge(1);

            return "text";
        });

        expect(runMutation).toHaveBeenCalledWith(internal.chat.daily_charge.chargeDailyUnit, expect.objectContaining({ count: 1, kind: "Audio" }));
    });

    it("refuses a spent quota before the paid call", async () => {
        const paid = vi.fn(async () => "url");

        await expect(
            withMediaCharge({ runMutation: vi.fn(async () => false) } as never, run, node("i", "inpaint"), "user-1", async (charge) => {
                await charge(1);

                return await paid();
            }),
        ).rejects.toThrow("You've reached your daily image generation limit.");
        expect(paid).not.toHaveBeenCalled();
    });

    it("does not charge an input image node, even when asked to", async () => {
        const runMutation = vi.fn(async () => true);

        await withMediaCharge({ runMutation } as never, run, node("i", "image", { mode: "input" }), "user-1", async (charge) => {
            await charge(1);

            return "url";
        });

        expect(runMutation).not.toHaveBeenCalled();
    });

    it("clamps an image count to the per-request cap, and to at least one", () => {
        expect([imageCountOf(undefined), imageCountOf(0), imageCountOf(2.9), imageCountOf(4), imageCountOf(50), imageCountOf(NaN)]).toStrictEqual([
            1, 1, 2, 4, 4, 1,
        ]);
    });

    it("keys the unit apart from the video unit of the same node", () => {
        expect(mediaRequestId("run", "n")).toBe('workflow-media:["run","n"]');
    });
});
