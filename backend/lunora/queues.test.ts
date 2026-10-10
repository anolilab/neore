import { describe, expect, it, vi } from "vitest";

import { JOB_DISPATCH_TIMEOUT_MS } from "./lib/job-queue-config";
import { jobs } from "./queues";

const message = (id: string, run: () => Promise<unknown>) => {
    return {
        ack: vi.fn(),
        attempts: 1,
        body: { args: { id }, functionPath: "tasks_execute:runTaskRound", shardKey: "user-a" },
        id,
        retry: vi.fn(),
        run: vi.fn(run),
    };
};

describe("jobs consumer", () => {
    it("dispatches each job on its shard with the long timeout, acks the ones that ran, then rethrows a failure", async () => {
        const failure = Object.assign(new Error("Thread not found"), { code: "NOT_FOUND" });
        const ok = message("m1", async () => undefined);
        const failed = message("m2", async () => {
            throw failure;
        });

        await expect(jobs.handler?.({} as never, { messages: [ok, failed], queue: "neore-backend-jobs" } as never)).rejects.toBe(failure);

        expect(ok.run).toHaveBeenCalledWith(
            { __lunoraRef: "tasks_execute:runTaskRound" },
            { id: "m1" },
            { shardKey: "user-a", timeoutMs: JOB_DISPATCH_TIMEOUT_MS },
        );
        expect(ok.ack).toHaveBeenCalledOnce();
        expect(failed.ack).not.toHaveBeenCalled();
    });
});
