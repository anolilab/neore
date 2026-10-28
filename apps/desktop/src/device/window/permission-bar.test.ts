import { describe, expect, it } from "vitest";

import type { PermissionView } from "../../acp/types";
import { approveAllIds, barSignature, groupBySession } from "./permission-bar";

const view = (id: number, sessionId: string, overrides: Partial<PermissionView> = {}): PermissionView => {
    return {
        agentLabel: "Agent",
        batchable: true,
        command: null,
        details: "{}",
        detailsComplete: true,
        folder: "/work",
        id,
        options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
        sessionId,
        target: null,
        tool: "Run",
        toolKind: "execute",
        ...overrides,
    };
};

describe("the approval bar", () => {
    it("groups the requests of one session together", () => {
        const groups = groupBySession([view(1, "a"), view(2, "b"), view(3, "a")]);

        expect(groups.map((group) => [group.sessionId, group.requests.map((request) => request.id)])).toEqual([
            ["a", [1, 3]],
            ["b", [2]],
        ]);
    });

    it("offers Approve all for two or more requests, naming exactly those it shows", () => {
        const [group] = groupBySession([view(1, "a"), view(2, "a")]);

        expect(approveAllIds(group)).toEqual([1, 2]);

        // A request that arrives later is a new bar: the ids already drawn do not include it.
        const [redrawn] = groupBySession([view(1, "a"), view(2, "a"), view(3, "a")]);

        expect(approveAllIds(group)).toEqual([1, 2]);
        expect(approveAllIds(redrawn)).toEqual([1, 2, 3]);

        const before = barSignature([view(1, "a"), view(2, "a")]);
        const after = barSignature([view(1, "a"), view(2, "a"), view(3, "a")]);

        expect(before).not.toBe(after);
    });

    it("does not offer it for a single request", () => {
        const [group] = groupBySession([view(1, "a")]);

        expect(approveAllIds(group)).toBeUndefined();
    });

    it("does not offer it when one request lacks an allow-once option or its full details", () => {
        const [incomplete] = groupBySession([view(1, "a"), view(2, "a", { batchable: false, detailsComplete: false })]);
        const [noAllow] = groupBySession([view(1, "a"), view(2, "a", { batchable: false, options: [] })]);

        expect(approveAllIds(incomplete)).toBeUndefined();
        expect(approveAllIds(noAllow)).toBeUndefined();
    });
});
