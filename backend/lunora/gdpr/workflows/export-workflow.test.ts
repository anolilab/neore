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
    dedupId?: string;
    ref: string;
}

let calls: Call[];
let generate: () => unknown;
let stepNames: string[];
const refOf = (reference: unknown): string => (reference as { __lunoraRef: string }).__lunoraRef;

const execute = async (): Promise<void> => {
    const context = {
        params: PARAMS,
        run: async (reference: unknown, args: Record<string, unknown>, options?: { dedupId?: string }) => {
            const ref = refOf(reference);

            calls.push({ args, dedupId: options?.dedupId, ref });

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
});

describe("data export workflow: coding-agent history", () => {
    it("leaves the coding-agent history to the export step, so no step result or call argument carries it", async () => {
        await execute();

        expect(ran("acp_gdpr:collectAcpSessionsForExport")).toHaveLength(0);
        expect(stepNames.filter((name) => name.startsWith("collect-acp-sessions"))).toEqual([]);
        expect(ran("gdpr_steps:generateExportFile")[0]?.args).not.toHaveProperty("acpSessions");
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

describe("data export workflow: watched repositories", () => {
    it("collects them under an id of its own, so a replay cannot answer it with another call's cached result", async () => {
        await execute();

        const [collect, ...rest] = ran("source_control_gdpr:collectWatchedRepositoriesForExport");

        expect(rest).toEqual([]);
        expect(collect?.dedupId).toContain(PARAMS.requestId);
    });
});
