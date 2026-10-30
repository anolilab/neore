/**
 * The data export workflow's failure path.
 *
 * Same recording fake as `deletion-workflow.test.ts`: `step.do` runs inline and
 * `run` records each internal call. A throw in `generateExportFile` must end the
 * request as `failed` with a user-facing message (so the user can re-request and
 * `requestDataExport` stops seeing it as `processing`), tell the user, and not
 * rethrow, which would make the runtime retry the whole handler.
 */
import { LunoraError } from "lunorash/server";
import { beforeEach, describe, expect, it } from "vitest";

import { dataExportWorkflowConfig, exportFailureMessage } from "./export-workflow";

const PARAMS = { requestId: "request-1", userEmail: "user@example.com", userId: "user-1" };

interface Call {
    args: Record<string, unknown>;
    ref: string;
}

let calls: Call[];
let generate: () => unknown;
let stepNames: string[];
/** What the coding-agent collector answers, a page per call; empty = the stub's `[]`. */
let acpPages: unknown[];

const refOf = (reference: unknown): string => (reference as { __lunoraRef: string }).__lunoraRef;

const execute = async (): Promise<void> => {
    const context = {
        params: PARAMS,
        run: async (reference: unknown, args: Record<string, unknown>) => {
            const ref = refOf(reference);

            calls.push({ args, ref });

            if (ref === "acp_gdpr:collectAcpSessionsForExport" && acpPages.length > 0) {
                return acpPages.shift();
            }

            return ref === "gdpr_steps:generateExportFile" ? generate() : [];
        },
        step: {
            do: async (name: string, callback: () => Promise<unknown>) => {
                stepNames.push(name);

                return await callback();
            },
        },
    };

    await dataExportWorkflowConfig.handler(context as never);
};

const progressWith = (status: string): Call[] => calls.filter((call) => call.ref === "gdpr_functions:updateRequestProgress" && call.args["status"] === status);
const ran = (ref: string): Call[] => calls.filter((call) => call.ref === ref);

beforeEach(() => {
    calls = [];
    generate = () => "storage-1";
    stepNames = [];
    acpPages = [];
});

describe("data export workflow: coding-agent pages", () => {
    it("asks again with the cursor until there is none, and exports every page", async () => {
        acpPages = [
            { events: [], next: { phase: "events" }, sessions: [{ threadId: "t1" }] },
            { events: [{ seq: 1 }], next: { page: "p", phase: "events", seq: 1 }, sessions: [] },
            { events: [{ seq: 2 }], sessions: [] },
        ];

        await execute();

        const collects = ran("acp_gdpr:collectAcpSessionsForExport");

        expect(collects.map((call) => call.args["cursor"])).toEqual([undefined, { phase: "events" }, { page: "p", phase: "events", seq: 1 }]);
        // The first keeps the name an export already in flight resumes at.
        expect(stepNames.filter((name) => name.startsWith("collect-acp-sessions"))).toEqual([
            "collect-acp-sessions",
            "collect-acp-sessions-1",
            "collect-acp-sessions-2",
        ]);
        expect(ran("gdpr_steps:generateExportFile")[0]?.args["acpSessions"]).toEqual({ events: [{ seq: 1 }, { seq: 2 }], sessions: [{ threadId: "t1" }] });
    });

    it("ends after one step on a stored result from before paging (sessions only, no cursor)", async () => {
        acpPages = [{ sessions: [{ threadId: "old" }] }];

        await execute();

        expect(ran("acp_gdpr:collectAcpSessionsForExport")).toHaveLength(1);
        expect(ran("gdpr_steps:generateExportFile")[0]?.args["acpSessions"]).toEqual({ events: [], sessions: [{ threadId: "old" }] });
    });

    it("does not loop on a result that is not a page", async () => {
        await execute();

        expect(ran("acp_gdpr:collectAcpSessionsForExport")).toHaveLength(1);
    });
});

describe("data export workflow: failure", () => {
    it("marks the request failed with a generic message and notifies the user when generation throws", async () => {
        generate = () => {
            throw new Error("R2 exploded: secret internals");
        };

        await expect(execute()).resolves.toBeUndefined();

        const failed = progressWith("failed");

        expect(failed).toHaveLength(1);
        expect(failed[0]?.args).toMatchObject({ errorMessage: "Failed to generate export file", requestId: PARAMS.requestId });
        expect(progressWith("completed")).toHaveLength(0);

        const notices = ran("notifications_functions:createNotification");

        expect(notices).toHaveLength(1);
        expect(notices[0]?.args).toMatchObject({ outcome: "failure", type: "data_export", userId: PARAMS.userId });
        expect(ran("gdpr_steps:sendExportReadyEmail")).toHaveLength(0);
    });

    it("names the size limit when the payload is too large", async () => {
        generate = () => {
            throw new LunoraError("PAYLOAD_TOO_LARGE", "too big");
        };

        await execute();

        expect(progressWith("failed")[0]?.args["errorMessage"]).toBe(exportFailureMessage(new LunoraError("PAYLOAD_TOO_LARGE", "x")));
        expect(String(progressWith("failed")[0]?.args["errorMessage"])).toContain("32 MB");
    });

    it("fails the request when generation returns no storage id", async () => {
        generate = () => undefined;

        await execute();

        expect(progressWith("failed")).toHaveLength(1);
        expect(progressWith("completed")).toHaveLength(0);
    });

    it("completes, notifies success and sends the ready e-mail when generation succeeds", async () => {
        await execute();

        expect(progressWith("failed")).toHaveLength(0);
        expect(progressWith("completed")).toHaveLength(1);
        expect(progressWith("completed")[0]?.args).toMatchObject({ storageId: "storage-1" });
        expect(ran("notifications_functions:createNotification")[0]?.args).toMatchObject({ outcome: "success" });
        expect(ran("gdpr_steps:sendExportReadyEmail")).toHaveLength(1);
    });
});
