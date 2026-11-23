/**
 * The callback host's address check (SEP-3415, "SSRF prevention"): the host name is resolved over DNS-over-HTTPS, and the host is
 * refused when any answer is not a public address. The public-address rule is #815's (`isPublicAddress`, `lib/egress.ts`), so
 * the two features refuse the same ranges: loopback, private, CGNAT, link-local and reserved, IPv4 and IPv6.
 *
 * This is a check, not a pin. The Worker's `fetch` connects to whatever address its own resolver returns, so the answer checked
 * here may not be the one a later request uses. The window is recorded in `events-webhook.ts`. Part 2b runs this check again
 * before each delivery.
 *
 * A lookup that fails, times out or answers with no address is `unresolved`, which the caller reports as a connection failure.
 */
import { isPublicAddress } from "../lib/egress";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;
const DNS_STATUS_OK = 0;
const DNS_STATUS_NXDOMAIN = 3;
const LOOKUP_TIMEOUT_MS = 5000;

export type CallbackHostCheck = "private" | "public" | "unresolved";

interface DnsAnswerBody {
    Answer?: { data?: unknown; type?: unknown }[];
    Status?: unknown;
}

const lookup = async (hostname: string, type: number, fetchFunction: typeof fetch): Promise<string[]> => {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type === DNS_TYPE_A ? "A" : "AAAA"}`;
    const response = await fetchFunction(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });

    if (!response.ok) {
        throw new Error("The lookup failed.");
    }

    const body = (await response.json()) as DnsAnswerBody;

    if (body.Status !== DNS_STATUS_OK && body.Status !== DNS_STATUS_NXDOMAIN) {
        throw new Error("The lookup failed.");
    }

    return (body.Answer ?? []).filter((answer) => answer.type === type && typeof answer.data === "string").map((answer) => answer.data as string);
};

/** Every A and AAAA answer for `hostname`, all of them checked. One private answer makes the host private. */
export const checkCallbackHost = async (hostname: string, fetchFunction: typeof fetch = fetch): Promise<CallbackHostCheck> => {
    let addresses: string[];

    try {
        addresses = [...(await lookup(hostname, DNS_TYPE_A, fetchFunction)), ...(await lookup(hostname, DNS_TYPE_AAAA, fetchFunction))];
    } catch {
        return "unresolved";
    }

    if (addresses.length === 0) {
        return "unresolved";
    }

    return addresses.every((address) => isPublicAddress(address)) ? "public" : "private";
};
