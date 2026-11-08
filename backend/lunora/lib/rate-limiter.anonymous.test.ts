/* eslint-disable sonarjs/no-hardcoded-ip -- addresses from the documentation ranges (RFC 5737, RFC 3849) and loopback */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { clientBucket, rateLimitGuard } from "./rate-limiter";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** One anonymous call from `ip`, as a public action makes it: its context carries `db` as well as the client address. */
const callFrom = async (ip: string): Promise<boolean> =>
    await harness.run(async (ctx: any) => {
        try {
            await rateLimitGuard({ ...ctx, ip, rateLimitKey: "chat/promptImprovement", user: null });

            return true;
        } catch {
            return false;
        }
    });

describe("an anonymous action's rate limit", () => {
    it("is kept per client address, so one caller using it up does not refuse another", async () => {
        // The public allowance is 3 an hour.
        for (let call = 0; call < 3; call += 1) {
            expect(await callFrom("203.0.113.1")).toBe(true);
        }

        expect(await callFrom("203.0.113.1")).toBe(false);
        expect(await callFrom("203.0.113.2")).toBe(true);
    });

    it("keys an IPv6 address by its /64, so stepping through one connection's addresses buys no fresh allowance", async () => {
        for (let call = 0; call < 3; call += 1) {
            expect(await callFrom(`2001:db8:a:b::${call + 1}`)).toBe(true);
        }

        expect(await callFrom("2001:db8:a:b:ffff::9")).toBe(false);
        expect(await callFrom("2001:db8:a:c::1")).toBe(true);
    });
});

describe(clientBucket, () => {
    it.each([
        ["203.0.113.7", "203.0.113.7"],
        ["::ffff:203.0.113.7", "203.0.113.7"],
        ["2001:0db8:000a:000b:1:2:3:4", "2001:db8:a:b::/64"],
        ["2001:db8::1", "2001:db8:0:0::/64"],
        ["::1", "0:0:0:0::/64"],
    ])("puts %s in %s", (ip, bucket) => {
        expect(clientBucket(ip)).toBe(bucket);
    });
});
