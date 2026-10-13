import { describe, expect, it, vi } from "vitest";

import { withoutStage } from "./queue-stage.js";

const makeBatch = (queue: string) => {
    return { ackAll: vi.fn(), messages: [], queue, retryAll: vi.fn() };
};

describe(withoutStage, () => {
    it.each([
        ["neore-backend-jobs-pr-12", "pr-12", "neore-backend-jobs"],
        ["neore-backend-jobs-dlq-staging", "staging", "neore-backend-jobs-dlq"],
        ["neore-backend-jobs-preview", "preview", "neore-backend-jobs"],
    ])("routes %s (stage %s) as %s", (queue, stage, expected) => {
        expect(withoutStage(makeBatch(queue), stage).queue).toBe(expected);
    });

    it("leaves production, which keeps the bare name, alone", () => {
        const batch = makeBatch("neore-backend-jobs");

        expect(withoutStage(batch, "")).toBe(batch);
        expect(withoutStage(batch, undefined)).toBe(batch);
    });

    it("leaves a queue that does not carry the stage alone", () => {
        const batch = makeBatch("neore-backend-jobs");

        expect(withoutStage(batch, "pr-12")).toBe(batch);
    });

    it("still acks and retries the original batch", () => {
        const batch = makeBatch("neore-backend-jobs-pr-12");
        const routed = withoutStage(batch, "pr-12");

        routed.ackAll();
        routed.retryAll({ delaySeconds: 5 });

        expect(batch.ackAll).toHaveBeenCalledTimes(1);
        expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 5 });
    });
});
