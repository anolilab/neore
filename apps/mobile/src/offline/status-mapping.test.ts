import { describe, expect, it } from "vitest";

import { hostSessionToStatus, workerRunToStatus } from "./status-mapping";

describe("status mapping", () => {
    it("stamps a host session with its last event, or its creation when it has had none", () => {
        const base = { _id: "s1", agentLabel: "Claude Code", createdAt: 10, folderLabel: "neore", status: "busy", threadId: "t1" };

        expect(hostSessionToStatus({ ...base, lastEventAt: 50 })).toMatchObject({ id: "host:s1", kind: "host", lastSeenAt: 50, threadId: "t1", updatedAt: 50 });
        expect(hostSessionToStatus(base)).toMatchObject({ lastSeenAt: 10, updatedAt: 10 });
    });

    it("stamps a worker run with its start, or its creation while it is queued", () => {
        const base = { createdAt: 10, name: "Researcher", runId: "r1", status: "running", workerId: "w1" };

        expect(workerRunToStatus({ ...base, startedAt: 30 })).toMatchObject({ id: "worker:r1", kind: "worker", threadId: "w1", updatedAt: 30 });
        expect(workerRunToStatus({ ...base, startedAt: null })).toMatchObject({ updatedAt: 10 });
    });
});
