/**
 * The move marker names an account whose pins are being moved or erased. It belongs to the operation that wrote it, is removed when that
 * operation ends, and never outlives every move. A pin write checks the marker, renews the account's lease and checks again; a refused
 * write renews nothing, and a move waits while a lease is in flight.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it } from "vitest";

import schema from "../schema";
import {
    PIN_WRITE_LEASE_MS,
    admitPinWrite,
    admitPinWriteUnlessMoving,
    beginAccountMove,
    endAccountMove,
    eraseWaitUntil,
    fencePinsOnShard,
    unfencePinsOnShard,
    isErasing,
    MERGE_MARKER_MAX_AGE_MS,
    isAccountMoving,
    pinWritesInFlightUntil,
} from "./account-moves";

describe("the account move marker", () => {
    it("marks an account while its move runs, and leaves no marker once the move ends", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await beginAccountMove(context, "user-guest", "merging", 1));

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-guest", 1))).toBe(true);

            await harness.run(async (context: any) => await endAccountMove(context, "user-guest", "merging"));

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-guest", 1))).toBe(false);

            const rows = await harness.run(async (context: any) => await context.db.accountMoves.findMany({ where: { userId: "user-guest" } }));

            expect(rows.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });

    it("keeps an erasure's marker when an overlapping merge of the same account ends", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                await beginAccountMove(context, "user-both", "erasing", 1);
                await beginAccountMove(context, "user-both", "merging", 2);
            });
            await harness.run(async (context: any) => await endAccountMove(context, "user-both", "merging"));

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-both", 1))).toBe(true);

            const rows = await harness.run(async (context: any) => await context.db.accountMoves.findMany({ where: { userId: "user-both" } }));

            expect(rows.page.map((row: { kind: string }) => row.kind)).toStrictEqual(["erasing"]);
        } finally {
            harness.close();
        }
    });

    it("does not add a second marker for a retry of the same operation", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                await beginAccountMove(context, "user-guest", "merging", 1);
                await beginAccountMove(context, "user-guest", "merging", 2);
            });

            const rows = await harness.run(async (context: any) => await context.db.accountMoves.findMany({ where: { userId: "user-guest" } }));

            expect(rows.page).toHaveLength(1);
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

            expect(await harness.run(async (context: any) => await pinWritesInFlightUntil(context, "user-writer", 1000))).toBe(1000 + PIN_WRITE_LEASE_MS);
            expect(await harness.run(async (context: any) => await pinWritesInFlightUntil(context, "user-writer", 1000 + PIN_WRITE_LEASE_MS))).toBeNull();
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

    it("is removed with the last marker when the moves end", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                await admitPinWrite(context, "user-guest", 1000);
                await beginAccountMove(context, "user-guest", "erasing", 1);
                await beginAccountMove(context, "user-guest", "merging", 2);
            });
            await harness.run(async (context: any) => await endAccountMove(context, "user-guest", "merging"));

            const kept = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: "user-guest" } }));

            expect(kept.page).toHaveLength(1);

            await harness.run(async (context: any) => await endAccountMove(context, "user-guest", "erasing"));

            const rows = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: "user-guest" } }));

            expect(rows.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });

    it("is not renewed by a write the marker refuses", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await beginAccountMove(context, "user-guest", "merging", 1));

            // Repeated refused attempts: each is refused, and none renews a lease.
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const refused = await harness.run(async (context: any) => await admitPinWriteUnlessMoving(context, "user-guest", 1000 + attempt));

                expect(refused).toBe(true);
            }

            const rows = await harness.run(async (context: any) => await context.db.pinWriteLeases.findMany({ where: { userId: "user-guest" } }));

            expect(rows.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });
});

describe("an erasure against a guest merge", () => {
    it("is seen by the merge, and waits while the merge still moves the account's pins", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await beginAccountMove(context, "user-both", "erasing", 1));

            expect(await harness.run(async (context: any) => await isErasing(context, "user-both"))).toBe(true);
            expect(await harness.run(async (context: any) => await eraseWaitUntil(context, "user-both", 5000))).toBeNull();

            await harness.run(async (context: any) => await beginAccountMove(context, "user-both", "merging", 2));

            expect(await harness.run(async (context: any) => await eraseWaitUntil(context, "user-both", 5000))).toBe(5000 + PIN_WRITE_LEASE_MS);

            await harness.run(async (context: any) => await endAccountMove(context, "user-both", "merging"));

            expect(await harness.run(async (context: any) => await eraseWaitUntil(context, "user-both", 5000))).toBeNull();
        } finally {
            harness.close();
        }
    });
});

describe("a merge marker that outlives its merge", () => {
    it("stops fencing the account and blocking the erasure once it is older than the bound", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await beginAccountMove(context, "user-stale", "merging", 1));

            const later = 1 + MERGE_MARKER_MAX_AGE_MS + 1;

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-stale", later))).toBe(false);
            expect(await harness.run(async (context: any) => await eraseWaitUntil(context, "user-stale", later))).toBeNull();
        } finally {
            harness.close();
        }
    });

    it("is cleared by the erasure of the account, so no marker of it outlives the erasure", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await beginAccountMove(context, "user-stale", "merging", 1));
            await harness.run(async (context: any) => await endAccountMove(context, "user-stale", "erasing"));

            const rows = await harness.run(async (context: any) => await context.db.accountMoves.findMany({ where: { userId: "user-stale" } }));

            expect(rows.page).toHaveLength(0);
        } finally {
            harness.close();
        }
    });
});

describe("an importing marker on the destination of a merge", () => {
    it("does not block the destination's own pin writes, but its erasure waits for the merge", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await beginAccountMove(context, "user-dest", "importing", 1));

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-dest", 1))).toBe(false);
            expect(await harness.run(async (context: any) => await eraseWaitUntil(context, "user-dest", 1))).toBe(1 + PIN_WRITE_LEASE_MS);

            await harness.run(async (context: any) => await endAccountMove(context, "user-dest", "importing"));

            expect(await harness.run(async (context: any) => await eraseWaitUntil(context, "user-dest", 1))).toBeNull();
        } finally {
            harness.close();
        }
    });
});

describe("the owner-shard fence", () => {
    it("refuses an account's pin writes on a fenced shard, and lets them through again once the fence is lifted", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await fencePinsOnShard(context, "user-fenced", 1));

            expect(await harness.run(async (context: any) => await admitPinWriteUnlessMoving(context, "user-fenced", 1))).toBe(true);

            await harness.run(async (context: any) => await unfencePinsOnShard(context, "user-fenced"));

            expect(await harness.run(async (context: any) => await admitPinWriteUnlessMoving(context, "user-fenced", 2))).toBe(false);
        } finally {
            harness.close();
        }
    });
});

describe("a stale marker a late delivery meets", () => {
    it("is renewed by the late delivery, so the account is fenced again", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await beginAccountMove(context, "user-late", "merging", 1));

            const late = 1 + MERGE_MARKER_MAX_AGE_MS + 1;

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-late", late))).toBe(false);

            await harness.run(async (context: any) => await beginAccountMove(context, "user-late", "merging", late));

            expect(await harness.run(async (context: any) => await isAccountMoving(context, "user-late", late))).toBe(true);
        } finally {
            harness.close();
        }
    });
});

describe("ending an importing marker", () => {
    it("keeps the destination's own pin-write lease, which is still in flight", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => await admitPinWrite(context, "user-dest", 1000));
            await harness.run(async (context: any) => await beginAccountMove(context, "user-dest", "importing", 1000));
            await harness.run(async (context: any) => await endAccountMove(context, "user-dest", "importing"));

            expect(await harness.run(async (context: any) => await pinWritesInFlightUntil(context, "user-dest", 1000))).toBe(1000 + PIN_WRITE_LEASE_MS);
        } finally {
            harness.close();
        }
    });
});
