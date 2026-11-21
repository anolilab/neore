/**
 * Outbound POSTs to a user-configured https URL, with the address checked at connect time.
 *
 * A Worker's `fetch` does not say which address a host name connected to, so a name that resolves to a private address
 * cannot be refused there. This module resolves the name itself (DNS over HTTPS), refuses the request if any answer is not
 * a public address, and then connects to the checked address. The host name is still used for the TLS certificate check,
 * so the connection is to the checked address and the certificate is for the host the user named.
 *
 * Only https on port 443 is allowed, with no credentials. Redirects are not followed: the status comes back as it is, and
 * the response body is not read. The socket API and the DNS fetch are injected, so the rules are tested without a network.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const HTTPS_PORT = 443;
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;
const DNS_STATUS_OK = 0;
const DNS_STATUS_NXDOMAIN = 3;
const MAX_HEAD_BYTES = 16 * 1024;
const RESERVED_HEADERS = new Set(["connection", "content-length", "host", "transfer-encoding"]);
const HEADER_NAME = /^[!#$%&'*+.^`|~\w-]+$/;
const DECIMAL_OCTET = /^\d{1,3}$/;
const BRACKETED_HOST = /^\[(.*)\]$/;
const CR_OR_LF = /[\r\n]/;
const IP_LITERAL = /^[\d.]+$/;
const HTTP_STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: |\r\n)/;

/** The default deadline for the whole exchange: lookup, connect, request and status line. */
export const EGRESS_TIMEOUT_MS = 10_000;

export type EgressErrorCode = "bad_header" | "bad_response" | "bad_url" | "blocked_address" | "dns_failed" | "timeout";

export class EgressError extends Error {
    readonly code: EgressErrorCode;

    constructor(code: EgressErrorCode, message: string) {
        super(message);
        this.name = "EgressError";
        this.code = code;
    }
}

/** True for an IPv4 address that is public: a dotted quad outside every private, loopback, link-local and reserved range. */
export const isPublicIPv4 = (address: string): boolean => {
    const octets = address.split(".").map((part) => (DECIMAL_OCTET.test(part) ? Number(part) : NaN));

    if (octets.length !== 4 || octets.some((octet) => !(octet >= 0 && octet <= 255))) {
        return false;
    }

    const [a, b, c] = octets as [number, number, number];

    if (a === 0 || a === 10 || a === 127 || a >= 224) {
        return false;
    }

    if (a === 100 && b >= 64 && b <= 127) {
        return false;
    }

    if (a === 169 && b === 254) {
        return false;
    }

    if (a === 172 && b >= 16 && b <= 31) {
        return false;
    }

    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) {
        return false;
    }

    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) {
        return false;
    }

    return !(a === 203 && b === 0 && c === 113);
};

/**
 * True for an IPv6 address in global unicast space (2000::/3), without the ranges that embed or stand for another address:
 * 6to4 (2002::/16), Teredo (2001:0::/32), benchmarking (2001:2::/48, refused with its whole /32) and documentation
 * (2001:db8::/32). Everything else, including mapped and
 * compatible forms, NAT64, link-local, unique-local, multicast and loopback, is refused. Text it cannot read is refused.
 */
export const isPublicIPv6 = (address: string): boolean => {
    const lower = address.toLowerCase();

    if (!lower.includes(":") || lower.includes("%")) {
        return false;
    }

    const groups = lower.split(":");
    const first = groups[0] === "" ? 0 : Number.parseInt(groups[0] as string, 16);
    const second = groups[1] === "" ? 0 : Number.parseInt(groups[1] ?? "", 16);

    if (Number.isNaN(second) || first < 0x20_00 || first > 0x3f_ff) {
        return false;
    }

    if (first === 0x20_02) {
        return false;
    }

    return !(first === 0x20_01 && [0, 0x00_02, 0x0d_b8].includes(second));
};

export const isPublicAddress = (address: string): boolean => (address.includes(":") ? isPublicIPv6(address) : isPublicIPv4(address));

/** The socket a connection runs on. The shape of `connect()` from `cloudflare:sockets`, which the caller passes in. */
export interface EgressSocket {
    close: () => Promise<void>;
    readable: ReadableStream<Uint8Array>;
    startTls: (options: { expectedServerHostname: string }) => EgressSocket;
    writable: WritableStream<Uint8Array>;
}

export type EgressConnect = (address: { hostname: string; port: number }, options: { allowHalfOpen: boolean; secureTransport: "starttls" }) => EgressSocket;

export interface EgressDependencies {
    connect: EgressConnect;
    fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface EgressRequest {
    body: string;
    headers: Record<string, string>;
    timeoutMs?: number;
    url: string;
}

export interface EgressResponse {
    status: number;
}

interface DnsBody {
    Answer?: { data?: unknown; type?: unknown }[];
    Status?: unknown;
}

interface Target {
    authority: string;
    hostname: string;
    path: string;
}

const parseTarget = (raw: string): Target => {
    let parsed: URL;

    try {
        parsed = new URL(raw);
    } catch {
        throw new EgressError("bad_url", "The URL is not valid.");
    }

    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || (parsed.port !== "" && parsed.port !== "443")) {
        throw new EgressError("bad_url", "Only https URLs on port 443, without credentials, can be called.");
    }

    const hostname = parsed.hostname.replace(BRACKETED_HOST, "$1").toLowerCase();

    if (hostname === "") {
        throw new EgressError("bad_url", "The URL has no host.");
    }

    return { authority: parsed.host, hostname, path: `${parsed.pathname}${parsed.search}` };
};

const assertHeaders = (headers: Record<string, string>): void => {
    for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || CR_OR_LF.test(value)) {
            throw new EgressError("bad_header", "A header name or value is not allowed.");
        }
    }
};

const queryAddresses = async (hostname: string, type: number, dependencies: EgressDependencies, signal: AbortSignal): Promise<string[]> => {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type === DNS_TYPE_A ? "A" : "AAAA"}`;
    let body: DnsBody;

    try {
        const response = await dependencies.fetch(url, { headers: { accept: "application/dns-json" }, signal });

        if (!response.ok) {
            throw new EgressError("dns_failed", "The host name could not be looked up.");
        }

        body = (await response.json()) as DnsBody;
    } catch (error) {
        if (error instanceof EgressError) {
            throw error;
        }

        throw new EgressError("dns_failed", "The host name could not be looked up.");
    }

    if (body.Status !== DNS_STATUS_OK && body.Status !== DNS_STATUS_NXDOMAIN) {
        throw new EgressError("dns_failed", "The host name could not be looked up.");
    }

    return (body.Answer ?? []).filter((answer) => answer.type === type && typeof answer.data === "string").map((answer) => answer.data as string);
};

/**
 * Every address the host name resolves to, all checked. One refused address refuses the whole host: a name that also
 * answers with a private address is not one to call. An IP literal is checked as it is, with no lookup.
 */
const resolveChecked = async (hostname: string, dependencies: EgressDependencies, signal: AbortSignal): Promise<string[]> => {
    if (IP_LITERAL.test(hostname) || hostname.includes(":")) {
        if (!isPublicAddress(hostname)) {
            throw new EgressError("blocked_address", "The URL points at a private or reserved address.");
        }

        return [hostname];
    }

    const [v4, v6] = await Promise.all([
        queryAddresses(hostname, DNS_TYPE_A, dependencies, signal),
        queryAddresses(hostname, DNS_TYPE_AAAA, dependencies, signal),
    ]);
    const addresses = [...v4, ...v6];

    if (addresses.length === 0) {
        throw new EgressError("dns_failed", "The host name has no address.");
    }

    if (addresses.some((address) => !isPublicAddress(address))) {
        throw new EgressError("blocked_address", "The host name resolves to a private or reserved address.");
    }

    return addresses;
};

const writeRequest = async (socket: EgressSocket, target: Target, request: EgressRequest): Promise<void> => {
    const encoder = new TextEncoder();
    const payload = encoder.encode(request.body);
    const head = [
        `POST ${target.path} HTTP/1.1`,
        `Host: ${target.authority}`,
        "Connection: close",
        `Content-Length: ${payload.byteLength}`,
        ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
    ].join("\r\n");
    const writer = socket.writable.getWriter();

    try {
        await writer.write(encoder.encode(head));
        await writer.write(payload);
    } finally {
        writer.releaseLock();
    }
};

/**
 * The final status line only. Interim 1xx heads are read past and dropped. The size limit applies to the head alone, and
 * bytes after the head are never kept: a receiver's answer is not ours to keep.
 */
/** The status of the first complete head in `text`, and the text after it. Undefined while that head is incomplete. */
const firstHead = (text: string): { rest: string; status: number } | undefined => {
    const end = text.indexOf("\r\n\r\n");

    if (end === -1) {
        return undefined;
    }

    if (end + 4 > MAX_HEAD_BYTES) {
        throw new EgressError("bad_response", "The response head is too large.");
    }

    const match = HTTP_STATUS_LINE.exec(text);

    if (match === null) {
        throw new EgressError("bad_response", "The server did not answer with HTTP.");
    }

    return { rest: text.slice(end + 4), status: Number(match[1]) };
};

const readStatus = async (socket: EgressSocket): Promise<number> => {
    const reader = socket.readable.getReader();
    const decoder = new TextDecoder();
    let pending = "";

    try {
        for (;;) {
            const head = firstHead(pending);

            if (head !== undefined) {
                if (head.status >= 200) {
                    return head.status;
                }

                pending = head.rest;
                continue;
            }

            if (pending.length > MAX_HEAD_BYTES) {
                throw new EgressError("bad_response", "The response head is too large.");
            }

            const { done, value } = await reader.read();

            if (done) {
                throw new EgressError("bad_response", "The server closed the connection before it answered.");
            }

            pending += decoder.decode(value, { stream: true });
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
};

/**
 * POSTs `request.body` to `request.url` at the first checked address, and returns the status. A 3xx is returned as it is.
 * Any refusal, failure or timeout throws an `EgressError` with a code and no URL or body in the message.
 */
export const postCheckedHttps = async (request: EgressRequest, dependencies: EgressDependencies): Promise<EgressResponse> => {
    const target = parseTarget(request.url);

    assertHeaders(request.headers);

    const timeoutMs = request.timeoutMs ?? EGRESS_TIMEOUT_MS;
    const controller = new AbortController();
    const opened: EgressSocket[] = [];
    const closeAll = async (): Promise<void> => {
        await Promise.all(opened.map(async (socket) => await socket.close().catch(() => undefined)));
    };

    const attempt = async (): Promise<EgressResponse> => {
        const [address] = await resolveChecked(target.hostname, dependencies, controller.signal);

        // The deadline can pass while a lookup is in flight. Cleanup has already run by then, so open nothing.
        if (controller.signal.aborted) {
            throw new EgressError("timeout", "The request timed out.");
        }

        const plain = dependencies.connect({ hostname: address as string, port: HTTPS_PORT }, { allowHalfOpen: false, secureTransport: "starttls" });

        opened.push(plain);

        const socket = plain.startTls({ expectedServerHostname: target.hostname });

        opened.push(socket);
        await writeRequest(socket, target, request);

        return { status: await readStatus(socket) };
    };

    // A socket failure from connect, TLS, write or read is not part of the caller's contract: it comes back as bad_response.
    const exchange = async (): Promise<EgressResponse> => {
        try {
            return await attempt();
        } catch (error) {
            if (error instanceof EgressError) {
                throw error;
            }

            throw new EgressError("bad_response", "The connection failed.");
        }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new EgressError("timeout", "The request timed out."));
        }, timeoutMs);
    });

    try {
        return await Promise.race([exchange(), deadline]);
    } finally {
        clearTimeout(timer);
        // Cancels a lookup still in flight when its sibling failed, so it cannot outlive this call.
        controller.abort();
        // Not awaited: a graceful close can wait on a write that never finishes, and the caller must still get the timeout.
        void closeAll();
    }
};
