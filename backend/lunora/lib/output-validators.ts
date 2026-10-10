/**
 * Output validators derived from `schema.ts`, for procedures that return whole
 * documents.
 *
 * Why derived and not written out: `.output()` is enforced at runtime — the
 * result is parsed through the validator before it is serialised — and `v.object`
 * STRIPS unknown keys rather than rejecting them. So an output validator that
 * omits a column does not fail loudly; it silently deletes that field from every
 * response, and the caller sees a document that is quietly missing data.
 *
 * Hand-maintaining a copy of each table's shape would make that a matter of
 * time: add a column to `schema.ts`, forget the copy here, and the new field is
 * invisible over RPC with nothing failing. Reading `schema.tables[name].shape`
 * means the two cannot drift.
 *
 * The return types are annotated rather than inferred. Without them tsc reports
 * TS7056 ("inferred type ... exceeds the maximum length the compiler will
 * serialize") on every call site, because this is a `composite` project and the
 * spread shapes are large. `Validator<Doc<T>>` names the same type in a form it
 * can emit.
 * Declaring `.output()` is also what stops codegen inferring the return type
 * and leaking its named aliases into `api.ts` without imports.
 */

import type { PaginationResult, Validator } from "lunorash/server";
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import { vPaginationResult } from "../agent/validators";
import { schema } from "../schema";

type TableName = keyof typeof schema.tables & string;

/**
 * A stored document: the table's own columns plus the two fields the runtime
 * stamps on every row.
 */
export const docOf = <T extends TableName>(table: T): Validator<Doc<T>> =>
    // The assertion is about what tsc can prove, not about what this returns.
    // `schema.tables[table].shape` is indexed by a generic `T`, so its type is
    // the union of every table's shape (9000+ members) and tsc cannot narrow
    // that to `Doc<T>` without knowing the concrete `T`. For any single call it
    // IS `Doc<T>`, by construction — the shape is read from the same schema that
    // defines the table.
    v.object({
        _creationTime: v.number(),
        _id: v.id(table),
        ...schema.tables[table].shape,
    }) as unknown as Validator<Doc<T>>;

/**
 * Any paginated result, with the envelope type named rather than inlined.
 *
 * The explicit `Validator<PaginationResult<T>>` is what makes codegen emit
 * `import("lunorash/server").PaginationResult<…>` instead of a bare
 * `PaginationResult` it then fails to import.
 */
export const paginatedOf = <T>(item: Validator<T>): Validator<PaginationResult<T>> => vPaginationResult(item) as unknown as Validator<PaginationResult<T>>;

/**
 * A paginated read of one table's documents.
 *
 * The envelope comes from `vPaginationResult`, which already exists and carries
 * `pageStatus` — a field `PaginationResult` does not declare but several
 * handlers return on their empty-page early return. Declaring a second envelope
 * here without it would have stripped `pageStatus` out of those responses.
 */
export const paginatedDocsOf = <T extends TableName>(table: T): Validator<PaginationResult<Doc<T>>> => paginatedOf(docOf(table));
