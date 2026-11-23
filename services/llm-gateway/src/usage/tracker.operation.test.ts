/**
 * `UsageTracker.record` stores the entry's `operation` in `usage_log.operation` (migration 0017), and NULL for a
 * writer that passes none. The provider cache readings tell chat rows apart by it.
 */
import { describe, expect, it } from "vitest";

import { d1FromSqlite, migratedDatabase } from "../__tests__/helpers/sqlite-d1.js";
import type { AppEnv } from "../env.js";
import type { UsageLogEntry } from "./tracker.js";
import { UsageTracker } from "./tracker.js";

const entry = (requestId: string, operation?: UsageLogEntry["operation"]): UsageLogEntry => {
    return {
        cachedTokens: 0,
        completionTokens: 0,
        costMicrodollars: 0,
        isStreaming: false,
        latencyMs: 10,
        modelApiId: "model-1",
        modelId: "model-1",
        ...(operation !== undefined && { operation }),
        promptTokens: 100,
        provider: "openai",
        reasoningTokens: 0,
        requestId,
        source: "internal",
        userId: "user-1",
    };
};

describe("UsageTracker.record", () => {
    it("stores the operation, and NULL when the writer passes none", async () => {
        const db = migratedDatabase();
        const tracker = new UsageTracker({ USAGE_DB: d1FromSqlite(db) } as unknown as AppEnv);

        await tracker.record(entry("chat-1", "chat"));
        await tracker.record(entry("embed-1", "embeddings"));
        await tracker.record(entry("music-1"));

        expect(db.prepare("SELECT request_id, operation FROM usage_log ORDER BY request_id").all()).toEqual([
            { operation: "chat", request_id: "chat-1" },
            { operation: "embeddings", request_id: "embed-1" },
            { operation: null, request_id: "music-1" },
        ]);
    });
});
