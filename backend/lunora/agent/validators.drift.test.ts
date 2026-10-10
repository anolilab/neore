/**
 * These validators are hand-maintained copies of table shapes, and they are used
 * as `.output()` on real procedures — six of them in `agent/threads.ts` alone.
 *
 * `.output()` is enforced at runtime and REJECTS undeclared keys, so a column
 * present in `schema.ts` and absent here fails every response carrying it
 * ("expected only the declared keys") — on exactly the rows that set it, which
 * is why it hides until one does (`chat/sharing.output.test.ts`).
 *
 * That had already happened: `threads.parentThreadIds` and
 * `threads.lastCompressionStartedAt` were in the schema and not in
 * `vThreadDocFields`, so the six procedures above were dropping them. The client
 * reads `parentThreadIds` to build the branch tree
 * (`features/chat/core/hooks/use-thread-manager.ts`) and only kept working
 * because it happens to read the thread list from `chat_functions.getThreads`,
 * which declares no `.output()` at all.
 *
 * Nothing catches that by inspection — it is two files apart and the symptom is
 * an absent field, not an error. So it is caught here instead: every column of
 * the table must appear in the validator. The validator may hold MORE than the
 * table (these carry agent-layer fields that are not columns), which is why the
 * assertion is one-directional.
 */

import { describe, expect, it } from "vitest";

import { schema } from "../schema";

import { vMessageDocFields, vThreadDocFields } from "./validators";

const columnsOf = (table: keyof typeof schema.tables): string[] => Object.keys(schema.tables[table].shape);

describe.each([
    ["vThreadDocFields", vThreadDocFields, "threads"],
    ["vMessageDocFields", vMessageDocFields, "messages"],
] as const)("%s covers its table", (_name, fields, table) => {
    it("declares every column the schema declares", () => {
        const declared = new Set(Object.keys(fields));
        const missing = columnsOf(table).filter((column) => !declared.has(column));

        expect(missing, `${table} column(s) absent from the validator — an .output() using it would strip them silently`).toStrictEqual([]);
    });
});
