/**
 * The callback host's address check, with the DNS-over-HTTPS answers faked: a public host is allowed, and every private, loopback,
 * CGNAT, link-local or reserved answer refuses it, IPv4 and IPv6, even when another answer is public.
 */
import { describe, expect, it } from "vitest";

/* eslint-disable sonarjs/no-hardcoded-ip -- test data: the addresses the check must allow or refuse, none of them dialled */
import { checkCallbackHost } from "./events-webhook-address";

/** A DoH fetch that answers A and AAAA lookups from two lists. A missing list answers NXDOMAIN. */
const dohWith = (a: string[], aaaa: string[] = []) =>
    (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        const type = url.searchParams.get("type");
        const answers = type === "A" ? a : aaaa;
        const body =
            answers.length === 0
                ? { Status: 3 }
                : {
                      Answer: answers.map((data) => {
                          return { data, type: type === "A" ? 1 : 28 };
                      }),
                      Status: 0,
                  };

        return Response.json(body);
    }) as typeof fetch;

describe("checkCallbackHost", () => {
    it("allows a host whose every address is public", async () => {
        expect(await checkCallbackHost("hooks.example.com", dohWith(["93.184.216.34"], ["2606:2800:220:1::1"]))).toBe("public");
    });

    it("refuses a host that also answers with one private address", async () => {
        expect(await checkCallbackHost("hooks.example.com", dohWith(["93.184.216.34", "10.0.0.7"]))).toBe("private");
    });

    it("refuses the private, loopback, CGNAT, link-local and reserved ranges", async () => {
        for (const address of ["127.0.0.1", "192.168.1.1", "172.16.0.9", "100.64.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1"]) {
            expect(await checkCallbackHost("hooks.example.com", dohWith([address]))).toBe("private");
        }
    });

    it("refuses IPv6 loopback, unique-local, link-local and mapped addresses", async () => {
        for (const address of ["::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
            expect(await checkCallbackHost("hooks.example.com", dohWith([], [address]))).toBe("private");
        }
    });

    it("reports a host with no address, a failed lookup or a lookup that throws as unresolved", async () => {
        expect(await checkCallbackHost("nowhere.example.com", dohWith([]))).toBe("unresolved");
        expect(await checkCallbackHost("hooks.example.com", (async () => new Response("", { status: 500 })) as typeof fetch)).toBe("unresolved");
        expect(
            await checkCallbackHost("hooks.example.com", (async () => {
                throw new TypeError("network down");
            }) as typeof fetch),
        ).toBe("unresolved");
    });
});
