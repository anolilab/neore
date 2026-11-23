import { DatabaseSync } from "node:sqlite";

import { runDataMigration } from "lunorash/do";
import { describe, expect, it } from "vitest";

import { documentTextPart } from "./chat/lib/attached-text";
import { backfillMessageTypedText } from "./migrations";

type Row = Record<string, unknown>;

const up = backfillMessageTypedText.up as unknown as (document: Row) => Row | undefined;

const userRow = (id: string, content: unknown, extra: Row = {}): Row => {
    const text = typeof content === "string" ? content : "sent text";

    return { _creationTime: Number(id.slice(1)), _id: id, message: { content, role: "user" }, role: "user", text, threadId: "t1", userId: "u1", ...extra };
};

/** A shard's SQLite handle in the shape the runner writes its run state through (`exec` with `toArray`/`one`). */
const shardSql = () => {
    const database = new DatabaseSync(":memory:");

    return {
        exec: (sql: string, ...params: unknown[]) => {
            const statement = database.prepare(sql);
            const rows = statement.columns().length > 0 ? (statement.all(...(params as never[])) as Row[]) : (statement.run(...(params as never[])), []);

            return { one: () => rows[0] as Row, [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows };
        },
    };
};

/** The shard's `messages`, paged by creation time with an opaque cursor, as the runner reads and rewrites them. */
const shardMessages = (rows: Row[]) => {
    const table = new Map(rows.map((row) => [String(row._id), structuredClone(row)]));
    const ordered = () => [...table.values()].toSorted((a, b) => Number(a._creationTime) - Number(b._creationTime));
    const reads: number[] = [];

    return {
        reads,
        rows: table,
        writer: {
            count: async () => table.size,
            findFirst: async () => ordered()[0] ?? null,
            findMany: async (_table: string, args: { cursor?: null | string; limit: number }) => {
                const start = args.cursor ? Number(args.cursor) : 0;
                const page = ordered().slice(start, start + args.limit);

                reads.push(page.length);

                const next = start + page.length;

                return { continueCursor: String(next), isDone: next >= table.size, page };
            },
            get: async (_table: string, id: string) => table.get(id) ?? null,
            replace: async (_table: string, id: string, document: Row) => {
                table.set(id, structuredClone(document));
            },
        },
    };
};

describe("backfillMessageTypedText", () => {
    it("fills what was typed on an older user message from its stored parts, and keeps its text as sent", () => {
        expect.assertions(2);

        const row = userRow("m1", [documentTextPart("plan.pdf", "quarterly numbers"), { text: "why did the deploy fail", type: "text" }], {
            text: "why did the deploy fail\n\n[Attached Document]\nquarterly numbers",
        });

        const migrated = up(row);

        expect(migrated).toStrictEqual({ ...row, typedText: "why did the deploy fail" });
        expect(migrated?.text).toBe(row.text);
    });

    it("leaves a message with no typed words unset: an attachment only, or a quote only", () => {
        expect.assertions(2);

        expect(up(userRow("m2", [documentTextPart("cv.pdf", "Senior nurse at the city hospital")]))).toBeUndefined();
        expect(up(userRow("m3", "> The assistant said this\n>\n> and more"))).toBeUndefined();
    });

    it("leaves a reply, a row kept out of search, and a row that already has the column untouched", () => {
        expect.assertions(3);

        expect(up({ _id: "a1", message: { content: "an answer", role: "assistant" }, role: "assistant", text: "an answer" })).toBeUndefined();
        expect(up({ ...userRow("m4", "hidden words"), text: undefined })).toBeUndefined();
        expect(up({ ...userRow("m5", "new words"), typedText: "new words" })).toBeUndefined();
    });

    it("copies the deletion mark through, so the search keeps dropping a deleted row when it reads", () => {
        expect.assertions(1);

        const row = userRow("m6", "deleted later", { deletedAt: 5 });

        expect(up(row)).toStrictEqual({ ...row, typedText: "deleted later" });
    });

    it("pages through a shard 32 rows at a time and resumes where a capped run stopped", async () => {
        expect.assertions(6);

        const rows = Array.from({ length: 70 }, (_, index) =>
            userRow(`m${String(index + 1)}`, index % 10 === 0 ? "> only a quote" : `prompt ${String(index)}`),
        );
        const shard = shardMessages(rows);
        const sql = shardSql();
        const run = async () =>
            await runDataMigration({ maxBatches: 1, migration: backfillMessageTypedText as never, sql: sql as never, writer: shard.writer as never });

        const first = await run();

        expect(first).toMatchObject({ processed: 32, status: "in_progress" });

        await run();
        const last = await run();

        expect(last).toMatchObject({ changed: 63, processed: 70, status: "completed" });
        expect(shard.reads).toStrictEqual([32, 32, 6]);

        const stored = [...shard.rows.values()];

        expect(stored.filter((row) => row.typedText !== undefined)).toHaveLength(63);
        expect(stored.filter((row) => row.text === "> only a quote").every((row) => row.typedText === undefined)).toBe(true);
        expect(stored.every((row, index) => row.text === rows[index]?.text)).toBe(true);
    });
});
