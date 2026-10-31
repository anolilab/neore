import type { CachedStatus } from "./types";

interface HostSessionView {

    _id: string;
    agentLabel: string;
    createdAt: number;
    folderLabel: string;
    lastEventAt?: number;
    status: string;
    threadId: string;
}

interface WorkerRunView {
    createdAt: number;
    name: string;
    runId: string;
    startedAt: number | null | undefined;
    status: string;
    workerId: string;
}

/** A host session as a status row on its thread; its last event is the last the phone heard of it. */
export const hostSessionToStatus = (session: HostSessionView): CachedStatus => {
    const updatedAt = session.lastEventAt ?? session.createdAt;

    return {
        // eslint-disable-next-line no-underscore-dangle -- the Lunora document id
        id: `host:${session._id}`,
        kind: "host",
        label: `${session.agentLabel} · ${session.folderLabel}`,
        lastSeenAt: updatedAt,
        status: session.status,
        threadId: session.threadId,
        updatedAt,
    };
};

/** A live worker run as a status row on the worker's own thread. */
export const workerRunToStatus = (run: WorkerRunView): CachedStatus => {
    const updatedAt = run.startedAt ?? run.createdAt;

    return {
        id: `worker:${run.runId}`,
        kind: "worker",
        label: run.name,
        lastSeenAt: updatedAt,
        status: run.status,
        threadId: run.workerId,
        updatedAt,
    };
};
