/**
 * The move marker names an account whose pins are being moved or erased. It is written before the pins are touched and removed once
 * the move is finished, so it never outlives the move. A pin write renews the account's lease before its move check, and a move waits
 * while a lease is in flight.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../schema";
import { PIN_WRITE_LEASE_MS, admitPinWrite, beginAccountMove, endAccountMove, isAccountMoving, pinWritesInFlight } from "./account-moves";

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

describe("the pin-write lease", () => {
    it("is in flight from the moment a pin write admits itself until its lease runs out", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await admitPinWrite(context, "user-writer", 1000));

            expect(await harness.run(async (context: any) => await pinWritesInFlight(context, "user-writer", 1000))).toBe(true);
            expect(await harness.run(async (context: any) => await pinWritesInFlight(context, "user-writer", 1000 + PIN_WRITE_LEASE_MS))).toBe(false);
        } finally {
            harness.close();
        }
    });

    it("keeps one row per account, renewed by each later write", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await admitPinWrite(context, "user-writer", 1000));
            await harness.run(async (context: any) => await admitPinWrite(context, "user-writer", 50_000));

            const rows = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: "user-writer" } }));

            expect(rows.page).toHaveLength(1);
            expect(rows.page[0].expiresAt).toBe(50_000 + PIN_WRITE_LEASE_MS);
        } finally {
            harness.close();
        }
    });

    it("is removed with the marker when the move ends", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await admitPinWrite(context, "user-guest", 1000));
            await harness.run(async (context: any) => await endAccountMove(context, "user-guest"));

            const rows = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: "user-guest" } }));

            expect(rows.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });
});
