/**
 * What Lunora does with a caller-supplied `_id`.
 *
 * This is not a test of our code — it pins a property of Lunora that the
 * data migration depends on, so that a future alpha bump which changes
 * it fails here rather than during a cutover.
 *
 * The question: an import of a previous-platform export carries its `_id` across
 * so that the export's foreign keys stay valid without a re-linking pass
 * (`POST /_lunora/admin/import` returns `{inserted: number}`, a count and not
 * the minted ids, so a two-pass remap is impossible).
 *
 * The answer at the ORM layer is **no**: `ctx.db.insert` discards a supplied
 * `_id` unconditionally and mints a UUIDv4. Verified for both a legacy-format
 * id and a well-formed UUID, so it is not a format rejection — the field is
 * simply not honoured.
 *
 * That does NOT settle the import HTTP path, which is a different code path
 * (`streamingImport`, whose line parser explicitly reads an `_id`). It does mean
 * the id-preserving import design cannot be assumed to work, and the one
 * remaining cutover check is specifically: POST one table to
 * `/_lunora/admin/import` on a scratch worker and read a row back.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../schema";

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

describe("caller-supplied _id", () => {
    it.each([
        ["a legacy-format id", "jd7abc123xyz"],
        ["a well-formed UUID", "00000000-1111-2222-3333-444444444444"],
    ])("is discarded by ctx.db.insert — %s", async (_label, supplied) => {
        const harness = lunoraTest(schema as never);

        try {
            const { inserted, rows } = await harness.run(async (context: any) => {
                return {
                    inserted: await context.db.insert("threads", { _id: supplied, title: "T", userId: "u1" }),
                    rows: await context.db.query("threads").collect(),
                };
            });

            expect(inserted).not.toBe(supplied);
            expect(inserted).toMatch(UUID_V4);
            expect(rows).toHaveLength(1);
            expect(rows[0]._id).toBe(inserted);
        } finally {
            harness.close();
        }
    });
});
