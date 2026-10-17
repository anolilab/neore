import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MockD1PreparedStatement } from "../__tests__/helpers/mock-env.js";
import { createMockEnv, MockD1Database } from "../__tests__/helpers/mock-env.js";
import type { AppEnv } from "../env.js";
import type { UsageReport } from "./reporter.js";

const { report, reporterOptions } = vi.hoisted(() => {
    return { report: vi.fn(), reporterOptions: vi.fn() };
});

vi.mock("./reporter.js", () => {
    return {
        UsageReporter: function UsageReporter(_env: unknown, options: unknown) {
            reporterOptions(options);

            return { report };
        },
    };
});

const { deferUsageReport, PENDING_USAGE_BASE_DELAY_MS, PENDING_USAGE_MAX_ATTEMPTS, sweepPendingUsage } = await import("./pending.js");

/** Records every statement that is `run()`, with its bound values. */
class RecordingD1 extends MockD1Database {
    public runs: { parameters: unknown[]; sql: string }[] = [];

    override prepare(sql: string): MockD1PreparedStatement {
        const statement = super.prepare(sql);
        let parameters: unknown[] = [];
        const { bind } = statement;

        statement.bind = (...values: unknown[]) => {
            parameters = values;
            bind(...values);

            return statement;
        };
        statement.run = async () => {
            this.runs.push({ parameters, sql });

            return { meta: {}, success: true };
        };

        return statement;
    }
}

const usage: UsageReport = { completionTokens: 0, costMicrodollars: 60_000, modelId: "fal/luma-ray-2", promptTokens: 0, requestId: "req-1", userId: "user-1" };

const NOW = 1_000_000;

const setup = (attempts = 0) => {
    const database = new RecordingD1().seed("usage_pending", [{ attempts, payload: JSON.stringify(usage), request_id: "req-1" }]);
    const env = { ...createMockEnv(), USAGE_DB: database as unknown as D1Database } as unknown as AppEnv;

    return { database, env };
};

beforeEach(() => {
    report.mockReset();
    reporterOptions.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deferUsageReport", () => {
    it("stores the report once per request id, due now", async () => {
        const database = new RecordingD1();

        await deferUsageReport(database as unknown as D1Database, usage, NOW);

        expect(database.runs).toStrictEqual([
            { parameters: ["req-1", JSON.stringify(usage), NOW], sql: expect.stringContaining("INSERT OR IGNORE INTO usage_pending") },
        ]);
    });
});

describe("sweepPendingUsage", () => {
    it("deletes a charge the backend accepts, sending it once per sweep", async () => {
        report.mockResolvedValue(true);

        const { database, env } = setup();

        await sweepPendingUsage(env, NOW);

        expect(report).toHaveBeenCalledWith(usage);
        expect(reporterOptions).toHaveBeenCalledWith({ maxAttempts: 1 });
        expect(database.runs).toStrictEqual([{ parameters: ["req-1"], sql: expect.stringContaining("DELETE FROM usage_pending") }]);
    });

    it("backs a refused charge off exponentially", async () => {
        report.mockResolvedValue(false);

        const { database, env } = setup(2);

        await sweepPendingUsage(env, NOW);

        expect(database.runs).toStrictEqual([
            { parameters: [3, NOW + PENDING_USAGE_BASE_DELAY_MS * 4, "req-1"], sql: expect.stringContaining("UPDATE usage_pending SET attempts") },
        ]);
    });

    it("drops a charge after the last attempt", async () => {
        report.mockResolvedValue(false);

        const { database, env } = setup(PENDING_USAGE_MAX_ATTEMPTS - 1);

        await sweepPendingUsage(env, NOW);

        expect(database.runs).toStrictEqual([{ parameters: ["req-1"], sql: expect.stringContaining("DELETE FROM usage_pending") }]);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Dropping usage report req-1"));
    });
});
