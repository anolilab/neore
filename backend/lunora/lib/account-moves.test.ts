/**
 * The move marker names an account whose pins are being moved or erased. It is written before the pins are touched and removed once
 * the move is finished, so it never outlives the move.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../schema";
import { beginAccountMove, endAccountMove, isAccountMoving } from "./account-moves";

describe("the account move marker", () => {
    it("marks an account while its move runs, and leaves no marker once the move ends", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await beginAccountMove(context, "user-guest", "merging", 1));

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-guest"))).toBe(true);

            await harness.run(async (context: any) => await endAccountMove(context, "user-guest"));

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-guest"))).toBe(false);

            const rows = await harness.run(async (context: any) => await context.db.accountMoves.findMany({ where: { userId: "user-guest" } }));

            expect(rows.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });
});
