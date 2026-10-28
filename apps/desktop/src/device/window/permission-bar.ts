/**
 * How the window groups waiting coding-agent requests, and when "Approve all" may be offered. Pure, so the rule
 * is tested without a page.
 *
 * Approve all is a batch of single answers, never a rule: it names the requests the bar showed when it was
 * drawn, the core answers exactly those, and a request that arrived afterwards is not among them.
 */
import type { PermissionView } from "../../acp/types";

export interface BarGroup {
    agentLabel: string;
    folder: string;
    requests: PermissionView[];
    sessionId: string;
}

/** One group per session, in the order the sessions first appear. */
export const groupBySession = (requests: PermissionView[]): BarGroup[] => {
    const groups: BarGroup[] = [];

    for (const request of requests) {
        let group = groups.find((candidate) => candidate.sessionId === request.sessionId);

        if (group === undefined) {
            group = { agentLabel: request.agentLabel, folder: request.folder, requests: [], sessionId: request.sessionId };
            groups.push(group);
        }

        group.requests.push(request);
    }

    return groups;
};

/**
 * The ids "Approve all" would send, or `undefined` when it must not be offered: fewer than two requests, or any
 * of them without an allow-once option or without its full details to read.
 */
export const approveAllIds = (group: BarGroup): number[] | undefined => {
    if (group.requests.length < 2 || group.requests.some((request) => !request.batchable)) {
        return undefined;
    }

    return group.requests.map((request) => request.id);
};

/** Changes whenever the set of waiting requests does; the window holds its buttons still while it settles. */
export const barSignature = (requests: PermissionView[]): string => requests.map((request) => request.id).join(",");
