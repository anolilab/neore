/**
 * Outbound POSTs to a user-configured https URL, with the host name's addresses checked before connect.
 *
 * A Worker's `fetch` does not say which address a host name connected to, so a name that resolves to a private address
 * cannot be refused there. This module resolves the name itself (DNS over HTTPS) and refuses the request if any answer is
 * not a public address. It then connects by host name and starts TLS with no options, the documented call shape: the
 * deployed runtime rejects the certificate when the connect target is an IP and the TLS name is given separately.
 * The runtime resolves the name again when it connects, so the check is an early refusal, not a pin: an answer that changes
 * between the two lookups is not caught.
 *
 * Only https on port 443 is allowed, with no credentials. Redirects are not followed: the status comes back as it is.
 * `postCheckedHttps` reads the status and no body; `requestCheckedHttps` also returns the body, up to `MAX_REPLY_BYTES`.
 * The socket API and the DNS fetch are injected, so the rules are tested without a network.
 *
 * A host on one of Cloudflare's published ranges is refused as `unsupported_target`: Workers cannot open TCP connections to
 * those addresses, so the connect would fail anyway.
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
const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})(?: |$)/;
const CR = 0x0d;
const LF = 0x0a;

/** The most bytes of a reply `requestCheckedHttps` keeps. A longer reply is cut there: the body is then only a prefix. */
export const MAX_REPLY_BYTES = 64 * 1024;

/** The default deadline for the whole exchange: lookup, connect, request and status line. */
export const EGRESS_TIMEOUT_MS = 10_000;

export type EgressErrorCode = "bad_header" | "bad_response" | "bad_url" | "blocked_address" | "dns_failed" | "timeout" | "unsupported_target";

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

    if (first === 0x3f_ff && second < 0x10_00) {
        return false;
    }

    return !(first === 0x20_01 && [0, 0x00_02, 0x0d_b8].includes(second));
};

export const isPublicAddress = (address: string): boolean => (address.includes(":") ? isPublicIPv6(address) : isPublicIPv4(address));

/**
 * Cloudflare's published ranges, from https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6, fetched
 * 2026-11-21. Workers cannot open TCP connections to these. Refresh the list when Cloudflare changes it.
 */
/* eslint-disable sonarjs/no-hardcoded-ip -- a published range list: data to match against, not addresses this code connects to */
const CLOUDFLARE_CIDRS = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
];
/* eslint-enable sonarjs/no-hardcoded-ip */

const IPV6_GROUP = /^[\da-f]{1,4}$/;

const ipv4ToBigInt = (address: string): bigint | undefined => {
    const octets = address.split(".");

    if (octets.length !== 4 || octets.some((octet) => !DECIMAL_OCTET.test(octet) || Number(octet) > 255)) {
        return undefined;
    }

    let value = 0n;

    for (const octet of octets) {
        value = (value << 8n) | BigInt(Number(octet));
    }

    return value;
};

/** The 128-bit value of an IPv6 address, with `::` expanded. Undefined for text that is not an IPv6 address. */
const ipv6ToBigInt = (address: string): bigint | undefined => {
    const halves = address.toLowerCase().split("::");

    if (halves.length > 2) {
        return undefined;
    }

    const head = halves[0] === "" ? [] : (halves[0] as string).split(":");
    const tail = halves.length === 2 && halves[1] !== "" ? (halves[1] as string).split(":") : [];
    const explicit = head.length + tail.length;

    if (halves.length === 1 ? explicit !== 8 : explicit > 7) {
        return undefined;
    }

    const groups = [...head];

    for (let index = explicit; index < 8; index += 1) {
        groups.push("0");
    }

    groups.push(...tail);

    let value = 0n;

    for (const group of groups) {
        if (!IPV6_GROUP.test(group)) {
            return undefined;
        }

        value = (value << 16n) | BigInt(Number.parseInt(group, 16));
    }

    return value;
};

interface CidrRange {
    family: 4 | 6;
    network: bigint;
    shift: bigint;
}

const parseCidr = (cidr: string): CidrRange => {
    const [text = "", prefix = ""] = cidr.split("/", 2);
    const family = text.includes(":") ? 6 : 4;
    const network = family === 6 ? ipv6ToBigInt(text) : ipv4ToBigInt(text);

    if (network === undefined) {
        throw new Error(`Invalid Cloudflare range: ${cidr}`);
    }

    return { family, network, shift: BigInt((family === 6 ? 128 : 32) - Number(prefix)) };
};

const CLOUDFLARE_RANGES = CLOUDFLARE_CIDRS.map((cidr) => parseCidr(cidr));

/** True for an address inside one of Cloudflare's published ranges. Text it cannot read is not one of them. */
export const isCloudflareAddress = (address: string): boolean => {
    const family = address.includes(":") ? 6 : 4;
    const value = family === 6 ? ipv6ToBigInt(address) : ipv4ToBigInt(address);

    if (value === undefined) {
        return false;
    }

    return CLOUDFLARE_RANGES.some((range) => range.family === family && value >> range.shift === range.network >> range.shift);
};

/** The socket a connection runs on. The shape of `connect()` from `cloudflare:sockets`, which the caller passes in. */
export interface EgressSocket {
    close: () => Promise<void>;
    readable: ReadableStream<Uint8Array>;
    startTls: () => EgressSocket;
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

export interface EgressBodyResponse extends EgressResponse {
    body: string;
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

        if (isCloudflareAddress(hostname)) {
            throw new EgressError("unsupported_target", "The URL points at Cloudflare, which Workers cannot connect to.");
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

    if (addresses.some((address) => isCloudflareAddress(address))) {
        throw new EgressError("unsupported_target", "The host name is served through Cloudflare, which Workers cannot connect to.");
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

const findHeadEnd = (bytes: Uint8Array): number => {
    for (let index = 0; index + 3 < bytes.length; index += 1) {
        if (bytes[index] === CR && bytes[index + 1] === LF && bytes[index + 2] === CR && bytes[index + 3] === LF) {
            return index;
        }
    }

    return -1;
};

const indexOfCrlf = (bytes: Uint8Array, from: number): number => {
    for (let index = from; index + 1 < bytes.length; index += 1) {
        if (bytes[index] === CR && bytes[index + 1] === LF) {
            return index;
        }
    }

    return -1;
};

const concatBytes = (parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;

    for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
    }

    return joined;
};

/** Reads until the server closes the connection (every request says `Connection: close`), or until `MAX_REPLY_BYTES` have come. */
const readRaw = async (socket: EgressSocket): Promise<Uint8Array> => {
    const reader = socket.readable.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;

    try {
        while (total < MAX_REPLY_BYTES) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            parts.push(value);
            total += value.byteLength;
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }

    const joined = concatBytes(parts);

    return joined.byteLength > MAX_REPLY_BYTES ? joined.subarray(0, MAX_REPLY_BYTES) : joined;
};

/**
 * The payload of a chunked body, as far as it is whole. A chunk cut short by the reply limit is dropped, so the result is a
 * prefix of the body and never a corrupt one.
 */
const decodeChunked = (bytes: Uint8Array): Uint8Array => {
    const parts: Uint8Array[] = [];
    let position = 0;

    for (;;) {
        const lineEnd = indexOfCrlf(bytes, position);

        if (lineEnd === -1) {
            break;
        }

        const size = Number.parseInt(new TextDecoder().decode(bytes.subarray(position, lineEnd)).split(";", 1)[0] ?? "", 16);

        if (size <= 0 || !Number.isSafeInteger(size)) {
            break;
        }

        const start = lineEnd + 2;
        const end = start + size;

        if (end > bytes.byteLength) {
            break;
        }

        parts.push(bytes.subarray(start, end));
        position = end + 2;
    }

    return concatBytes(parts);
};

const CHUNKED_CODING = /chunked/iu;
const DIGITS_ONLY = /^\d+$/u;

/** The header lines after the status line, names lower-cased. A line without a colon is not a header and is skipped. */
const headersOf = (lines: string[]): Map<string, string> => {
    const headers = new Map<string, string>();

    for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");

        if (colon > 0) {
            headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
    }

    return headers;
};

/** The body bytes of a final answer: decoded when chunked, cut to `Content-Length` when it has one, otherwise as they came. */
const payloadOf = (rest: Uint8Array, headers: Map<string, string>): Uint8Array => {
    if (CHUNKED_CODING.test(headers.get("transfer-encoding") ?? "")) {
        return decodeChunked(rest);
    }

    const length = headers.get("content-length");

    return length !== undefined && DIGITS_ONLY.test(length) ? rest.subarray(0, Math.min(Number(length), rest.byteLength)) : rest;
};

/**
 * The status and the body of the final answer. Interim 1xx heads are read past. The body is decoded when the answer is chunked,
 * cut to its `Content-Length` when it has one, and otherwise taken as it came, up to the reply limit.
 */
const readReply = async (socket: EgressSocket): Promise<EgressBodyResponse> => {
    let bytes = await readRaw(socket);

    for (;;) {
        const end = findHeadEnd(bytes);

        if (end === -1) {
            throw new EgressError("bad_response", "The server did not send a complete response head.");
        }

        if (end + 4 > MAX_HEAD_BYTES) {
            throw new EgressError("bad_response", "The response head is too large.");
        }

        const lines = new TextDecoder().decode(bytes.subarray(0, end)).split("\r\n");
        const match = STATUS_LINE.exec(lines[0] ?? "");

        if (match === null) {
            throw new EgressError("bad_response", "The server did not answer with HTTP.");
        }

        const status = Number(match[1]);
        const rest = bytes.subarray(end + 4);

        if (status < 200) {
            bytes = rest;

            continue;
        }

        return { body: new TextDecoder().decode(payloadOf(rest, headersOf(lines))), status };
    }
};

/**
 * POSTs `request.body` to `request.url` after the address check, and reads the answer with `read`. Shared by the two
 * public entry points below, so the address check, the deadline and the cleanup are written once.
 */
const checkedPost = async <T>(request: EgressRequest, dependencies: EgressDependencies, read: (socket: EgressSocket) => Promise<T>): Promise<T> => {
    const target = parseTarget(request.url);

    assertHeaders(request.headers);

    const timeoutMs = request.timeoutMs ?? EGRESS_TIMEOUT_MS;
    const controller = new AbortController();
    const opened: EgressSocket[] = [];
    const closeAll = async (): Promise<void> => {
        await Promise.all(opened.map(async (socket) => await socket.close().catch(() => undefined)));
    };

    const attempt = async (): Promise<T> => {
        await resolveChecked(target.hostname, dependencies, controller.signal);

        // The deadline can pass while a lookup is in flight. Cleanup has already run by then, so open nothing.
        if (controller.signal.aborted) {
            throw new EgressError("timeout", "The request timed out.");
        }

        const plain = dependencies.connect({ hostname: target.hostname, port: HTTPS_PORT }, { allowHalfOpen: false, secureTransport: "starttls" });

        opened.push(plain);

        const socket = plain.startTls();

        opened.push(socket);
        await writeRequest(socket, target, request);

        return await read(socket);
    };

    // A socket failure from connect, TLS, write or read is not part of the caller's contract: it comes back as bad_response.
    const exchange = async (): Promise<T> => {
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

/**
 * POSTs `request.body` to `request.url` after the address check, and returns the status. A 3xx is returned as it is, and
 * no body is read. Any refusal, failure or timeout throws an `EgressError` with a code and no URL or body in the message.
 */
export const postCheckedHttps = async (request: EgressRequest, dependencies: EgressDependencies): Promise<EgressResponse> =>
    await checkedPost(request, dependencies, async (socket) => {
        return { status: await readStatus(socket) };
    });

/**
 * The same POST, and the answer's status with its body: the body is read up to `MAX_REPLY_BYTES`, and a longer one is cut there.
 * The reply is read to the server's close, so a server that holds the connection open runs into the deadline. Errors are as
 * `postCheckedHttps`.
 */
export const requestCheckedHttps = async (request: EgressRequest, dependencies: EgressDependencies): Promise<EgressBodyResponse> =>
    await checkedPost(request, dependencies, readReply);
