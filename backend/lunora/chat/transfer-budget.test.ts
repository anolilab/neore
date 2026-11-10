/**
 * What one thread load sends the browser: the first page of `getThreadUIMessages`, the
 * query the thread view subscribes to, on a thread shaped like a heavy one. Ten historical
 * turns each run five tool calls, and the measured turn runs twenty. Every tool result is
 * retained in its row, and the test asserts the page carries them.
 *
 * Decoded is the JSON body as the handler returns it; wire is its gzip. Tool output is
 * pseudo-random, so gzip cannot flatten it and the wire figure moves with real regressions.
 * The result is written to `NEORE_TRANSFER_BUDGET_DIR/snapshot.json` only when that variable
 * is set (the `thread-transfer` workflow sets it), and the ceilings below fail the test when
 * exceeded.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getThreadUIMessages, getToolOutput } from "./functions";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const OWNER = "user-owner";
/** The first page the web client requests (`DEFAULT_PAGINATION_OPTS`). */
const CLIENT_PAGE_ITEMS = 20;
const HISTORY_TURNS = 10;
const HISTORY_TOOL_CALLS = 5;
const HISTORY_TOOL_RESULT_BYTES = 180_000;
const MEASURED_TOOL_CALLS = 20;
const MEASURED_TOOL_RESULT_BYTES = 55_000;

// Ceilings: the measured value plus about 25% headroom. Raise one only with a reason in the PR.
const CEILING = {
    snapshotDecodedBytes: 4000,
    snapshotWireBytes: 1000,
};

const scenario = {
    historyToolCallsPerTurn: HISTORY_TOOL_CALLS,
    historyToolResultBytes: HISTORY_TOOL_CALLS * HISTORY_TOOL_RESULT_BYTES,
    historyTurns: HISTORY_TURNS,
    id: "thread-transfer-v1",
    measuredToolCalls: MEASURED_TOOL_CALLS,
    measuredToolResultBytes: MEASURED_TOOL_CALLS * MEASURED_TOOL_RESULT_BYTES,
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789 ";

/** `bytes` characters of pseudo-random text from a fixed-seed generator, so the gzip size is stable run to run. */
const toolResult = (seed: number, bytes: number): string => {
    let state = Math.imul(seed + 1, 2_654_435_761) >>> 0;
    let out = "";

    for (let index = 0; index < bytes; index += 1) {
        state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
        out += ALPHABET[(state >>> 16) % ALPHABET.length];
    }

    return out;
};

const seedTurn = async (context: any, threadId: string, turn: number, calls: number, resultBytes: number, order: { value: number }) => {
    const turnOrder = order.value;

    order.value += 1;
    await context.db.insert("messages", {
        message: { content: `question ${String(turn)}`, role: "user" },
        order: turnOrder,
        status: "success",
        stepOrder: 0,
        text: `question ${String(turn)}`,
        threadId,
        tool: false,
        userId: OWNER,
    });

    for (let call = 0; call < calls; call += 1) {
        const toolCallId = `call-${String(turn)}-${String(call)}`;

        await context.db.insert("messages", {
            message: {
                content: [{ input: { query: `lookup ${String(call)}` }, toolCallId, toolName: "docs_search", type: "tool-call" }],
                role: "assistant",
            },
            order: turnOrder,
            status: "success",
            stepOrder: 1 + call * 2,
            threadId,
            tool: true,
            userId: OWNER,
        });
        await context.db.insert("messages", {
            message: {
                content: [
                    {
                        output: { type: "text", value: toolResult(turn * 1000 + call, resultBytes) },
                        toolCallId,
                        toolName: "docs_search",
                        type: "tool-result",
                    },
                ],
                role: "tool",
            },
            order: turnOrder,
            status: "success",
            stepOrder: 2 + call * 2,
            threadId,
            tool: true,
            userId: OWNER,
        });
    }

    await context.db.insert("messages", {
        message: { content: `answer ${String(turn)}`, role: "assistant" },
        order: turnOrder,
        status: "success",
        stepOrder: 1 + calls * 2,
        text: `answer ${String(turn)}`,
        threadId,
        tool: false,
        usage: { completionTokens: 120, promptTokens: 900, totalTokens: 1020 },
        userId: OWNER,
    });
};

const TOOL_PART_JSON = /"type":"tool-/u;

describe("thread snapshot transfer", () => {
    it("keeps the first thread page within its decoded and wire ceilings", async () => {
        const harness = lunoraTest(schema as never);
        const order = { value: 0 };

        const threadId = await harness.run(async (context: any) => {
            const id = await context.db.insert("threads", {
                model: "m",
                status: "active",
                title: "transfer budget",
                userId: OWNER,
            });

            for (let turn = 0; turn < HISTORY_TURNS; turn += 1) {
                await seedTurn(context, id, turn, HISTORY_TOOL_CALLS, HISTORY_TOOL_RESULT_BYTES, order);
            }

            // The measured turn: its tool results are retained in the thread once it finishes.
            await seedTurn(context, id, HISTORY_TURNS, MEASURED_TOOL_CALLS, MEASURED_TOOL_RESULT_BYTES, order);

            return id;
        });

        const page = (await harness.withIdentity({ userId: OWNER }).query(
            getThreadUIMessages as never,
            {
                paginationOpts: { cursor: null, numItems: CLIENT_PAGE_ITEMS },
                threadId,
            } as never,
        )) as { page: unknown[] };

        const body = Buffer.from(JSON.stringify(page));
        const observed = {
            snapshotDecodedBytes: body.byteLength,
            snapshotWireBytes: gzipSync(body).byteLength,
        };

        if (process.env.NEORE_TRANSFER_BUDGET_DIR) {
            mkdirSync(process.env.NEORE_TRANSFER_BUDGET_DIR, { recursive: true });
            writeFileSync(
                join(process.env.NEORE_TRANSFER_BUDGET_DIR, "snapshot.json"),
                `${JSON.stringify({ ceiling: CEILING, observed, scenario, schemaVersion: 1 }, null, 2)}\n`,
            );
        }

        // A page without tool parts would measure a text-only thread, so the fixture cannot go that way silently.
        expect(page.page.length).toBeGreaterThan(0);
        expect(body.toString()).toMatch(TOOL_PART_JSON);
        expect(observed.snapshotWireBytes).toBeLessThanOrEqual(CEILING.snapshotWireBytes);
        expect(observed.snapshotDecodedBytes).toBeLessThanOrEqual(CEILING.snapshotDecodedBytes);

        // The page leaves its large results out and points at them; each must come back whole through `getToolOutput`.
        const refs = (page.page as { parts: { outputRef?: { messageId: string; threadId: string; toolCallId: string } }[] }[]).flatMap((message) =>
            message.parts.flatMap((part) => (part.outputRef ? [part.outputRef] : [])),
        );

        expect(refs.length).toBeGreaterThan(0);

        for (const ref of refs.slice(0, 3)) {
            const full = (await harness.withIdentity({ userId: OWNER }).query(
                getToolOutput as never,
                {
                    messageId: ref.messageId,
                    threadId: ref.threadId,
                    toolCallId: ref.toolCallId,
                } as never,
            )) as { output: unknown };

            expect(full.output).toHaveLength(MEASURED_TOOL_RESULT_BYTES);
        }
    });

    it("keeps every tool output inline when the caller asks for full outputs (the public API's read)", async () => {
        const harness = lunoraTest(schema as never);
        const order = { value: 0 };

        const threadId = await harness.run(async (context: any) => {
            const id = await context.db.insert("threads", { model: "m", status: "active", title: "full outputs", userId: OWNER });

            await seedTurn(context, id, 0, MEASURED_TOOL_CALLS, MEASURED_TOOL_RESULT_BYTES, order);

            return id;
        });

        const page = (await harness.withIdentity({ userId: OWNER }).query(
            getThreadUIMessages as never,
            {
                fullToolOutputs: true,
                paginationOpts: { cursor: null, numItems: CLIENT_PAGE_ITEMS },
                threadId,
            } as never,
        )) as { page: { parts: { output?: unknown; outputRef?: unknown; type: string }[] }[] };

        const parts = page.page.flatMap((message) => message.parts.filter((part) => part.type.startsWith("tool-")));

        expect(parts.length).toBeGreaterThan(0);
        expect(parts.some((part) => part.outputRef !== undefined)).toBe(false);
        expect(parts.some((part) => typeof part.output === "string" && part.output.length === MEASURED_TOOL_RESULT_BYTES)).toBe(true);
    });
});
