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

import { UsageExportError, usageObjectKey } from "../usage-export-steps";
import { dataExportWorkflowConfig, exportFailureMessage } from "./export-workflow";

const PARAMS = { requestId: "request-1", userEmail: "user@example.com", userId: "user-1" };
/** The usage object of the run `request-1`: its key is derived from the request, so another run's object does not match. */
const RUN_USAGE_KEY = usageObjectKey("request-1:instance-1");

interface Call {
    args: Record<string, unknown>;
    dedupId?: string;
    ref: string;
}

let calls: Call[];
let generate: () => unknown;
let stepNames: string[];
const refOf = (reference: unknown): string => (reference as { __lunoraRef: string }).__lunoraRef;

/** What each call returns: the file step's result, and an empty usage history that settles in one page and one recount. */
/** Per-test replacements for a call's result, or for what the call does instead. */
let stubs: Partial<Record<string, () => unknown>> = {};

const resultOf = (ref: string): unknown => {
    const stub = stubs[ref];

    if (stub) {
        return stub();
    }

    switch (ref) {
        case "gdpr_steps:generateExportFile": {
            return generate();
        }
        case "gdpr_steps:prepareUsageForExport": {
            return "gdpr-exports/usage-test.json";
        }
        case "usage_activity:persistUsageTitles": {
            return { bytes: 0, done: true, next: 0, titles: 0 };
        }
        case "usage_activity:verifyUsageTitles": {
            return { bytes: 0, done: true, next: 0, titles: 0 };
        }
        case "usage_gdpr:clearUsageExportPieces": {
            return { hasMore: false };
        }
        case "usage_gdpr:countUsageRowsPage": {
            return { backfill: "", closed: { cost: 0, replies: 0, rows: 0, tokens: 0 }, cursor: null };
        }
        case "usage_gdpr:persistUsageRowsPage": {
            return {
                backfill: "",
                bytes: 0,
                closed: { cost: 0, replies: 0, rows: 0, tokens: 0 },
                cutoff: "2026-01-01",
                nextCursor: null,
                projectIds: [],
                rowCount: 0,
            };
        }
        default: {
            return [];
        }
    }
};

const execute = async (): Promise<void> => {
    const context = {
        event: { instanceId: "instance-1" },
        params: PARAMS,
        run: async (reference: unknown, args: Record<string, unknown>, options?: { dedupId?: string }) => {
            const ref = refOf(reference);

            calls.push({ args, dedupId: options?.dedupId, ref });

            return resultOf(ref);
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
    stubs = {};
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

describe("data export workflow: replay", () => {
    it("gives every call made inside a step an id, and a replayed step does not run its effect again", async () => {
        const effects: string[] = [];
        const cache = new Map<string, unknown>();
        const unkeyed: string[] = [];

        const ids: string[] = [];
        const replay = async (instanceId = "instance-1"): Promise<void> => {
            let inStep = false;
            const context = {
                event: { instanceId },
                params: PARAMS,
                run: async (reference: unknown, _args: Record<string, unknown>, options?: { dedupId?: string }) => {
                    const ref = refOf(reference);

                    if (options?.dedupId === undefined) {
                        if (inStep) {
                            unkeyed.push(ref);
                        }

                        return [];
                    }

                    ids.push(options.dedupId);

                    if (!cache.has(options.dedupId)) {
                        effects.push(`${ref}#${options.dedupId}`);
                        cache.set(options.dedupId, resultOf(ref));
                    }

                    return cache.get(options.dedupId);
                },
                step: {
                    do: async (_name: string, callback: () => Promise<unknown>) => {
                        inStep = true;

                        try {
                            return await callback();
                        } finally {
                            inStep = false;
                        }
                    },
                },
            };

            await dataExportWorkflowConfig.handler(context as never);
        };

        await replay();

        expect(unkeyed).toEqual([]);
        expect(effects.filter((effect) => effect.includes("sendExportReadyEmail"))).toHaveLength(1);
        // Two steps sharing an id would answer the second from the first's cache: its effect would never run.
        expect(new Set(ids).size).toBe(ids.length);
        expect(effects).toHaveLength(ids.length);

        const first = effects.length;

        await replay();

        expect(effects).toHaveLength(first);

        // A fresh instance for the same request collects again.
        await replay("instance-2");

        expect(effects).toHaveLength(first * 2);
    });
});

describe("data export workflow: usage pieces and progress", () => {
    it("says the usage kept changing, and asks for the export again", () => {
        expect(exportFailureMessage(new UsageExportError("changed"))).toBe("Your usage kept changing while the export was written; request the export again");
    });

    it("never moves the progress back", async () => {
        await execute();

        const values = calls
            .filter((call) => call.ref === "gdpr_functions:updateRequestProgress")
            .map((call) => call.args["progress"])
            .filter((value): value is number => typeof value === "number");

        expect(values.length).toBeGreaterThan(1);
        expect(values).toEqual(values.toSorted((a, b) => a - b));
    });
});

describe("data export workflow: the usage object", () => {
    it("reports an oversized usage as too large, from the usage action's value", async () => {
        stubs["gdpr_steps:prepareUsageForExport"] = () => null;

        await execute();

        expect(progressWith("failed")[0]?.args["errorMessage"]).toBe("Your usage history is too large to export in one file; contact support");
    });

    it("deletes the usage object before it clears the pieces, once the file is stored", async () => {
        await execute();

        const deleted = calls.findIndex((call) => call.ref === "gdpr_steps:deleteUsageJson");
        const cleared = calls.findIndex((call) => call.ref === "usage_gdpr:clearUsageExportPieces");

        expect(deleted).toBeGreaterThan(-1);
        expect(cleared).toBeGreaterThan(deleted);
        // The run's own object: its key is derived from the request, so another run's object does not match.
        expect(calls[deleted]?.args).toEqual({ key: RUN_USAGE_KEY });
    });

    it("keeps the pieces when the usage object cannot be deleted, so the run can be retried", async () => {
        stubs["gdpr_steps:deleteUsageJson"] = () => {
            throw new Error("storage unavailable");
        };

        await expect(execute()).rejects.toThrow("storage unavailable");
        expect(calls.some((call) => call.ref === "usage_gdpr:clearUsageExportPieces")).toBe(false);
    });

    it("deletes the usage object and clears the pieces when the export fails", async () => {
        generate = () => {
            throw new LunoraError("PAYLOAD_TOO_LARGE", "too big");
        };

        await execute();

        const deleted = calls.findIndex((call) => call.ref === "gdpr_steps:deleteUsageJson");
        const cleared = calls.findIndex((call) => call.ref === "usage_gdpr:clearUsageExportPieces");

        expect(deleted).toBeGreaterThan(-1);
        expect(cleared).toBeGreaterThan(deleted);
        expect(String(progressWith("failed")[0]?.args["errorMessage"])).toContain("32 MB");
    });

    it("tells the ready notice before the cleanup, so cleanup never holds the notice back", async () => {
        await execute();

        const notified = calls.findIndex((call) => call.ref === "notifications_functions:createNotification" && call.args["outcome"] === "success");
        const cleared = calls.findIndex((call) => call.ref === "usage_gdpr:clearUsageExportPieces");

        expect(notified).toBeGreaterThan(-1);
        expect(cleared).toBeGreaterThan(notified);
    });

    it("records the stored file before it clears anything, so a failed cleanup never leaves a file without its record", async () => {
        stubs["usage_gdpr:clearUsageExportPieces"] = () => {
            throw new Error("clear failed");
        };

        await expect(execute()).rejects.toThrow("clear failed");

        const recorded = calls.findIndex((call) => call.ref === "gdpr_functions:updateRequestProgress" && call.args["status"] === "completed");
        const cleared = calls.findIndex((call) => call.ref === "usage_gdpr:clearUsageExportPieces");

        expect(recorded).toBeGreaterThan(-1);
        expect(cleared).toBeGreaterThan(recorded);
        expect(calls[recorded]?.args["storageId"]).toBe("storage-1");
    });
});
