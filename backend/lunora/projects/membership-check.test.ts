/**
 * The membership check a view shares across many projects: one read per organization, whatever the answer.
 */
import { describe, expect, it, vi } from "vitest";

import { membershipCheck } from "./functions";

describe("membershipCheck", () => {
    it("reads each organization's membership once, however many projects ask", async () => {
        const findFirst = vi.fn(async ({ where }: { where: { organizationId: string } }) => (where.organizationId === "org_in" ? { _id: "m1" } : null));
        const isMember = membershipCheck({ db: { member: { findFirst } } } as never, "user-a");

        const answers = await Promise.all([isMember("org_in"), isMember("org_in"), isMember("org_out"), isMember("org_in"), isMember("org_out")]);

        expect(answers).toStrictEqual([true, true, false, true, false]);
        expect(findFirst).toHaveBeenCalledTimes(2);
    });
});
