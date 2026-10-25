/**
 * The scheduled analytics-erasure retry: 1h / 6h / 24h backoff capped at five attempts, every
 * attempt logged without personal data, only the PostHog erasure re-run, and the request
 * finished the way the workflow's success path finishes it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { POSTHOG_RETRY_DELAYS_MS, POSTHOG_RETRY_MAX_ATTEMPTS } from "./constants";
import { retryPostHogErasure, schedulePostHogRetry } from "./posthog-retry";
import { erasePostHogPerson } from "./steps/posthog-steps";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("./steps/posthog-steps", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./steps/posthog-steps")>()), erasePostHogPerson: vi.fn() };
});

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const USER = "user-1";
const FAILED_MESSAGE = "Your account data was erased, but deleting your analytics profile failed.";

const deleteAuthRecordsSpy = vi.fn();

let harness: ReturnType<typeof lunoraTest>;
let requestId: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);
/** Only retry jobs are ever scheduled here (the mocked reference carries no path to filter on). */
const jobs = () => harness.scheduler.list();
const audit = async () =>
    (await run(async (ctx) => await ctx.db.query("gdprAuditLog").collect())) as { action: string; details: string; performedBy: string; userId: string }[];
/** Sorted: rows read back in id order, not insertion order. */
const details = async (action: string) => {
    const rows = await audit();

    return JSON.parse(rows.find((row) => row.action === action)?.details ?? "null") as unknown;
};
const actions = async () => {
    const rows = await audit();

    return rows.map((row) => row.action).toSorted((a, b) => a.localeCompare(b));
};
const request = async () => (await run(async (ctx) => await ctx.db.get(requestId))) as { errorMessage?: string; status: string; userEmail: string };
const attempt = async (n: number) =>
    await harness.action((async (ctx: any) => await ctx.runAction(retryPostHogErasure, { attempt: n, requestId, userId: USER })) as never);

beforeAll(async () => {
    registerModule(registry, "gdpr_functions", await import("./functions"));
    registerModule(registry, "gdpr_posthog_retry", await import("./posthog-retry"));
    registerModule(registry, "gdpr_steps_residual_deletion_steps", await import("./steps/residual-deletion-steps"));

    const deletionSteps = await import("./steps/deletion-steps");

    // The retry must never reach this: it is the step that deletes the user's sign-in.
    registry.set("gdpr_steps_deletion_steps:deleteAuthRecords", {
        ...deletionSteps.deleteAuthRecords,
        handler: deleteAuthRecordsSpy,
    });
});

beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    vi.mocked(erasePostHogPerson).mockReset();
    deleteAuthRecordsSpy.mockReset();
    harness = lunoraTest(schema as never);
    requestId = await run(
        async (ctx) =>
            await ctx.db.insert("gdprRequests", {
                errorMessage: FAILED_MESSAGE,
                requestedAt: NOW - HOUR,
                requestType: "deletion",
                status: "failed",
                userEmail: "",
                userId: USER,
            }),
    );
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("scheduling the first retry", () => {
    it("queues exactly one retry, attempt 1 at +1h, and logs it", async () => {
        await run(async (ctx) => await ctx.runMutation(schedulePostHogRetry, { requestId, userId: USER }));

        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 1, requestId, userId: USER });
        expect(jobs()[0]?.scheduledFor).toBe(NOW + HOUR);

        expect(await actions()).toStrictEqual(["deletion_retry_scheduled"]);
        expect(await details("deletion_retry_scheduled")).toStrictEqual({ attempt: 1, requestId });
    });
});

describe("a retry attempt", () => {
    it("completes the request, records the outcome like the workflow, and minimises", async () => {
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        const row = await request();

        expect(row.status).toBe("completed");
        expect(row.errorMessage).toBeFalsy();
        expect(await actions()).toStrictEqual(["deletion_completed", "deletion_retry_started", "deletion_retry_succeeded"]);

        expect(await details("deletion_retry_succeeded")).toStrictEqual({ attempt: 1, posthog: "deleted", requestId });
        expect(await details("deletion_completed")).toStrictEqual({ posthog: "deleted", requestId });
        expect(erasePostHogPerson).toHaveBeenCalledWith(USER, expect.anything());
        expect(jobs()).toHaveLength(0);
    });

    it("moves the request to processing while the erasure runs", async () => {
        let seen = "";

        vi.mocked(erasePostHogPerson).mockImplementation(async () => {
            const row = await request();

            seen = row.status;

            return "no_profile";
        });
        await attempt(1);

        expect(seen).toBe("processing");
    });

    it("on failure keeps the request failed with the fixed reason, logs a class not the message, and queues attempt 2 at +6h", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error(`Failed to delete person ${USER}: 503 Service Unavailable`));

        await attempt(1);

        const row = await request();

        expect(row.status).toBe("failed");
        expect(row.errorMessage).toBe(FAILED_MESSAGE);
        expect(await actions()).toStrictEqual(["deletion_retry_failed", "deletion_retry_scheduled", "deletion_retry_started"]);

        expect(await details("deletion_retry_failed")).toStrictEqual({ attempt: 1, errorClass: "Error", requestId });
        expect(JSON.stringify(await audit())).not.toContain("503");
        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.args).toStrictEqual({ attempt: 2, requestId, userId: USER });
        expect(jobs()[0]?.scheduledFor).toBe(NOW + 6 * HOUR);
    });

    it("follows 1h, 6h, 24h, 24h, 24h and gives up after the fifth attempt, scheduling nothing", async () => {
        vi.mocked(erasePostHogPerson).mockRejectedValue(new Error("down"));

        const delays: number[] = [];

        for (let n = 1; n <= POSTHOG_RETRY_MAX_ATTEMPTS; n += 1) {
            await attempt(n);

            if (n < POSTHOG_RETRY_MAX_ATTEMPTS) {
                delays.push((jobs().at(-1)?.scheduledFor ?? 0) - NOW);
            }
        }

        expect(POSTHOG_RETRY_MAX_ATTEMPTS).toBe(5);
        expect(POSTHOG_RETRY_DELAYS_MS).toStrictEqual([HOUR, 6 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
        expect(delays).toStrictEqual([6 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
        expect(jobs()).toHaveLength(4);

        const names = await actions();

        expect(names).toContain("deletion_retry_exhausted");
        expect(names.filter((name) => name === "deletion_retry_scheduled")).toHaveLength(4);
        const last = await request();

        expect(last.status).toBe("failed");
    });

    it("leaves a request that is no longer failed alone", async () => {
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "completed" }));
        vi.mocked(erasePostHogPerson).mockResolvedValue("deleted");

        await attempt(1);

        expect(erasePostHogPerson).not.toHaveBeenCalled();
        expect(await audit()).toHaveLength(0);
    });

    it("never runs delete-auth-records", async () => {
        vi.mocked(erasePostHogPerson).mockResolvedValueOnce("deleted").mockRejectedValueOnce(new Error("down"));

        await attempt(1);
        await run(async (ctx) => await ctx.db.patch(requestId, { status: "failed" }));
        await attempt(2);

        expect(deleteAuthRecordsSpy).not.toHaveBeenCalled();
    });
});
