import { describe, expect, it } from "vitest";

import { hostSessionToStatus, workerRunToStatus } from "./status-mapping";

describe("status mapping", () => {
    it("stamps a host session with its last event, or its creation when it has had none", () => {
        const base = { _id: "s1", agentLabel: "Claude Code", createdAt: 10, folderLabel: "neore", status: "busy", threadId: "t1" };

        expect(hostSessionToStatus({ ...base, lastEventAt: 50 })).toMatchObject({ id: "host:s1", kind: "host", lastSeenAt: 50, threadId: "t1", updatedAt: 50 });
        expect(hostSessionToStatus(base)).toMatchObject({ lastSeenAt: 10, updatedAt: 10 });
    });

    it("versions a worker run by its start, or its creation while it is queued", () => {
        const base = { createdAt: 10, name: "Researcher", runId: "r1", status: "running", workerId: "w1" };

        expect(workerRunToStatus({ ...base, startedAt: 30 }, 99)).toMatchObject({ id: "worker:r1", kind: "worker", threadId: "w1", updatedAt: 30 });
        expect(workerRunToStatus({ ...base, startedAt: null }, 99)).toMatchObject({ updatedAt: 10 });
    });

    it("says a worker run was last seen when it was last read, not when it started", () => {
        const run = { createdAt: 10, name: "Researcher", runId: "r1", startedAt: 30, status: "running", workerId: "w1" };

        expect(workerRunToStatus(run, 99).lastSeenAt).toBe(99);
    });
});
