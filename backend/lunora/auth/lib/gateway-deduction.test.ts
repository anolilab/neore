/**
 * `applyGatewayDeduction`: a gateway usage report is charged once per
 * `requestId`, however often the gateway retries it.
 *
 * Driven against an in-memory fake of the two db surfaces it uses, not
 * `lunoraTest`: `memberCredits` is a `.global()` table, and the harness has no
 * global (D1) writer — inserting into it throws "requires a globalDb writer".
 */
import { beforeEach, describe, expect, it } from "vitest";

import { applyGatewayDeduction, type GatewayDeductionArgs } from "./gateway-deduction";

type Row = Record<string, unknown> & { _id: string };

const ORG = "org-1";
const USER = "user-1";

let credits: Row;
let deductions: Row[];

/** The `requestId` an index builder asks for — `q.eq("requestId", value)`. */
const readEqValue = (build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown): unknown => {
    let wanted: unknown;
    const q = {
        eq: (_field: string, value: unknown) => {
            wanted = value;

            return q;
        },
    };

    build(q);

    return wanted;
};

const findDeduction = async (requestId: unknown) => deductions.find((row) => row.requestId === requestId) ?? null;

const insert = async (table: string, doc: Record<string, unknown>) => {
    if (table !== "gatewayUsageDeductions") {
        throw new Error(`unexpected insert into ${table}`);
    }

    const row = { _id: `d${deductions.length}`, ...doc };

    deductions.push(row);

    return row._id;
};

const patch = async (id: string, changes: Record<string, unknown>) => {
    if (id !== credits._id) {
        throw new Error(`unexpected patch of ${id}`);
    }

    Object.assign(credits, changes);
};

const findCredits = async ({ where }: { where: { organizationId: string; userId: string } }) =>
    where.organizationId === credits.organizationId && where.userId === credits.userId ? credits : null;

const query = (table: string) => {
    if (table !== "gatewayUsageDeductions") {
        throw new Error(`unexpected query of ${table}`);
    }

    return {
        withIndex: (_index: string, build: Parameters<typeof readEqValue>[0]) => {
            const requestId = readEqValue(build);

            return { first: async () => await findDeduction(requestId) };
        },
    };
};

const fakeContext = () =>
    ({ db: { insert, memberCredits: { findFirst: findCredits }, patch, query } }) as unknown as Parameters<typeof applyGatewayDeduction>[0];

const report = (overrides: Partial<GatewayDeductionArgs> = {}): GatewayDeductionArgs => {
    return { costMicrodollars: 25_000, modelId: "m", orgId: ORG, requestId: "req-1", userId: USER, ...overrides };
};

const apply = async (args: GatewayDeductionArgs) => await applyGatewayDeduction(fakeContext(), args);

beforeEach(() => {
    credits = { _id: "c1", memberId: "member-1", organizationId: ORG, usedCredits: 0, userId: USER };
    deductions = [];
});

describe(applyGatewayDeduction, () => {
    it("charges a platform call in full and records the row", async () => {
        expect(await apply(report())).toBe("deducted");
        expect(credits.usedCredits).toBe(25);
        expect(deductions).toHaveLength(1);
        expect(deductions[0]).toMatchObject({ billingMode: "platform", costMicrodollars: 25_000, creditsDeducted: 25, requestId: "req-1" });
    });

    it("ignores a retried report with the same requestId", async () => {
        expect(await apply(report())).toBe("deducted");
        expect(await apply(report())).toBe("duplicate");
        expect(credits.usedCredits).toBe(25);
        expect(deductions).toHaveLength(1);
    });

    it("charges distinct requestIds separately", async () => {
        await apply(report({ requestId: "req-1" }));
        await apply(report({ requestId: "req-2" }));

        expect(credits.usedCredits).toBe(50);
    });

    it("charges only the fee for byok and keeps the full cost on the row", async () => {
        expect(await apply(report({ billingMode: "byok", byokFeeRate: 0.1 }))).toBe("deducted");
        expect(credits.usedCredits).toBe(3);
        expect(deductions[0]).toMatchObject({ billingMode: "byok", costMicrodollars: 25_000, creditsDeducted: 3 });
    });

    it("charges nothing for custom endpoints", async () => {
        expect(await apply(report({ billingMode: "custom" }))).toBe("no-charge");
        expect(credits.usedCredits).toBe(0);
        expect(deductions).toHaveLength(0);
    });

    it("skips a user with no credit record in the org", async () => {
        expect(await apply(report({ orgId: "other-org" }))).toBe("no-credit-record");
        expect(deductions).toHaveLength(0);
    });
});
