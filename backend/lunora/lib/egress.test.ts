/**
 * The checked outbound POST (`egress.ts`). The DNS fetch and the socket are fakes, so no test reaches the network. The
 * live path (a real connect and a real certificate check) is not covered here and must be checked on a dev run.
 */
/* eslint-disable sonarjs/no-hardcoded-ip -- the addresses under test are literals: private, reserved and public ones */
import { describe, expect, it, vi } from "vitest";

import type { EgressConnect, EgressDependencies, EgressSocket } from "./egress";
import { EgressError, isPublicIPv4, isPublicIPv6, postCheckedHttps } from "./egress";

const textStream = (text: string) =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });

const silentStream = () => new ReadableStream<Uint8Array>({ start() {} });

/** A DNS-over-HTTPS fetch that answers from a fixed table, for A (type 1) and AAAA (type 28). */
const dnsFetch = (answers: { A?: string[]; AAAA?: string[] }) =>
    vi.fn(async (input: string) => {
        const type = new URL(input).searchParams.get("type");
        const addresses = type === "A" ? (answers.A ?? []) : (answers.AAAA ?? []);

        return Response.json({
            Answer: addresses.map((data) => {
                return { data, type: type === "A" ? 1 : 28 };
            }),
            Status: 0,
        });
    });

interface FakeConnection {
    close: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    startTls: ReturnType<typeof vi.fn>;
    written: string[];
}

/** A `connect` that answers every request with `response`, and records what it was asked and what was written. */
const fakeConnect = (response: string, readable: () => ReadableStream<Uint8Array> = () => textStream(response)): FakeConnection => {
    const written: string[] = [];
    const close = vi.fn(async () => {});
    const tls: EgressSocket = {
        close,
        readable: readable(),
        startTls: vi.fn(() => tls),
        writable: new WritableStream<Uint8Array>({
            write(chunk) {
                written.push(new TextDecoder().decode(chunk));
            },
        }),
    };
    const plain: EgressSocket = {
        close: vi.fn(async () => {}),
        readable: silentStream(),
        startTls: vi.fn(() => tls),
        writable: new WritableStream<Uint8Array>(),
    };
    const connect = vi.fn((() => plain) as EgressConnect);

    return { close, connect, startTls: plain.startTls as ReturnType<typeof vi.fn>, written };
};

const dependencies = (fetch: EgressDependencies["fetch"], connection: FakeConnection): EgressDependencies => {
    return {
        connect: connection.connect as unknown as EgressConnect,
        fetch,
    };
};

const HOOK = "https://hooks.example.com/run?x=1";

describe("isPublicIPv4", () => {
    it.each([
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.1",
        "192.0.0.8",
        "192.0.0.170",
        "192.0.2.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.51.100.7",
        "203.0.113.9",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
    ])("refuses %s", (address) => {
        expect(isPublicIPv4(address)).toBe(false);
    });

    it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255", "198.20.0.1"])("accepts %s", (address) => {
        expect(isPublicIPv4(address)).toBe(true);
    });

    it("refuses text that is not a dotted quad", () => {
        expect(isPublicIPv4("2130706433")).toBe(false);
        expect(isPublicIPv4("8.8.8")).toBe(false);
        expect(isPublicIPv4("8.8.8.256")).toBe(false);
    });
});

describe("isPublicIPv6", () => {
    it.each([
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "fe80::1",
        "fc00::1",
        "fd12::1",
        "ff02::1",
        "2002:c000:204::1",
        "2001::1",
        "2001:db8::1",
        "64:ff9b::1",
        "2001:2::1",
        "3fff::1",
        "3fff:fff::1",
    ])("refuses %s", (address) => {
        expect(isPublicIPv6(address)).toBe(false);
    });

    it.each(["2606:4700:4700::1111", "2a00:1450::1", "3fff:1000::1"])("accepts %s", (address) => {
        expect(isPublicIPv6(address)).toBe(true);
    });
});

describe("postCheckedHttps", () => {
    it("connects to the checked address and keeps the host name for the certificate", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");
        const fetch = dnsFetch({ A: ["93.184.216.34"] });

        const result = await postCheckedHttps(
            { body: '{"a":1}', headers: { "content-type": "application/json", "x-neore-event": "webhook.test" }, url: HOOK },
            dependencies(fetch, connection),
        );

        expect(result).toEqual({ status: 204 });
        expect(connection.connect).toHaveBeenCalledWith({ hostname: "93.184.216.34", port: 443 }, { allowHalfOpen: false, secureTransport: "starttls" });
        expect(connection.startTls).toHaveBeenCalledWith({ expectedServerHostname: "hooks.example.com" });

        const sent = connection.written.join("");

        expect(sent.startsWith("POST /run?x=1 HTTP/1.1\r\nHost: hooks.example.com\r\nConnection: close\r\nContent-Length: 7\r\n")).toBe(true);
        expect(sent).toContain("content-type: application/json\r\n");
        expect(sent.endsWith('\r\n\r\n{"a":1}')).toBe(true);
    });

    it("refuses when any answer is private, even beside a public one, and connects to nothing", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");

        await expect(
            postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34", "10.0.0.5"] }), connection)),
        ).rejects.toMatchObject({
            code: "blocked_address",
        });
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it("refuses an IPv6 answer that is loopback or mapped to a private address", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");

        await expect(postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ AAAA: ["::1"] }), connection))).rejects.toMatchObject({
            code: "blocked_address",
        });
        await expect(
            postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ AAAA: ["::ffff:10.0.0.5"] }), connection)),
        ).rejects.toMatchObject({
            code: "blocked_address",
        });
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it("refuses a private IP literal without a lookup", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");
        const fetch = dnsFetch({ A: ["8.8.8.8"] });

        await expect(postCheckedHttps({ body: "", headers: {}, url: "https://10.0.0.1/hook" }, dependencies(fetch, connection))).rejects.toMatchObject({
            code: "blocked_address",
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it("refuses a name with no address", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");

        await expect(postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({}), connection))).rejects.toMatchObject({
            code: "dns_failed",
        });
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it.each([
        // eslint-disable-next-line unicorn/prefer-https -- refusing plain http is what this row tests
        "http://hooks.example.com/run",
        "https://user@hooks.example.com/run",
        "https://hooks.example.com:8443/run",
        "not a url",
    ])("refuses %s before any lookup", async (url) => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");
        const fetch = dnsFetch({ A: ["93.184.216.34"] });

        await expect(postCheckedHttps({ body: "", headers: {}, url }, dependencies(fetch, connection))).rejects.toBeInstanceOf(EgressError);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("refuses a header that would split the request", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");

        await expect(
            postCheckedHttps(
                { body: "", headers: { "x-a": "1\r\nHost: evil.example" }, url: HOOK },
                dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection),
            ),
        ).rejects.toMatchObject({ code: "bad_header" });
        await expect(
            postCheckedHttps({ body: "", headers: { Host: "evil.example" }, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection)),
        ).rejects.toMatchObject({
            code: "bad_header",
        });
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it("returns a redirect as its status and does not follow it", async () => {
        const connection = fakeConnect("HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/\r\n\r\n");

        const result = await postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection));

        expect(result).toEqual({ status: 302 });
        expect(connection.connect).toHaveBeenCalledTimes(1);
    });

    it("refuses an answer that is not HTTP", async () => {
        const connection = fakeConnect("SSH-2.0-OpenSSH\r\n\r\n");

        await expect(
            postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection)),
        ).rejects.toMatchObject({
            code: "bad_response",
        });
    });

    it("gives up at the deadline, and closes what it opened", async () => {
        const connection = fakeConnect("", silentStream);

        await expect(
            postCheckedHttps({ body: "", headers: {}, timeoutMs: 20, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection)),
        ).rejects.toMatchObject({ code: "timeout" });
        expect(connection.close).toHaveBeenCalled();
    });

    it("opens nothing when the lookup finishes after the deadline", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");
        const answer = dnsFetch({ A: ["93.184.216.34"] });
        const lateFetch = vi.fn(async (input: string) => {
            await new Promise((resolve) => {
                setTimeout(resolve, 30);
            });

            return await answer(input);
        });

        await expect(postCheckedHttps({ body: "", headers: {}, timeoutMs: 5, url: HOOK }, dependencies(lateFetch, connection))).rejects.toMatchObject({
            code: "timeout",
        });
        await new Promise((resolve) => {
            setTimeout(resolve, 60);
        });
        expect(connection.connect).not.toHaveBeenCalled();
        expect(connection.written).toEqual([]);
    });

    it("aborts a lookup that is still pending when its sibling fails", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");
        let pendingSignal: AbortSignal | undefined;
        const fetch = vi.fn(async (input: string, init?: RequestInit) => {
            if (new URL(input).searchParams.get("type") === "A") {
                throw new TypeError("network down");
            }

            pendingSignal = init?.signal ?? undefined;

            return await new Promise<Response>(() => {});
        });

        await expect(postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(fetch, connection))).rejects.toMatchObject({
            code: "dns_failed",
        });
        expect(pendingSignal?.aborted).toBe(true);
    });

    it("maps a rejected DNS request to dns_failed", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");
        const fetch = vi.fn(async () => {
            throw new TypeError("network down");
        });

        await expect(postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(fetch, connection))).rejects.toMatchObject({
            code: "dns_failed",
        });
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it("maps a DNS answer that is not JSON to dns_failed", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");
        const fetch = vi.fn(async () => new Response("<html>", { status: 200 }));

        await expect(postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(fetch, connection))).rejects.toMatchObject({
            code: "dns_failed",
        });
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it("returns the final status after an interim response", async () => {
        const connection = fakeConnect("HTTP/1.1 103 Early Hints\r\nLink: </style.css>\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n");

        const result = await postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection));

        expect(result).toEqual({ status: 204 });
    });

    it("reads a short head even when the same chunk carries a body over the head limit", async () => {
        const connection = fakeConnect(`HTTP/1.1 201 Created\r\n\r\n${"x".repeat(20 * 1024)}`);

        const result = await postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection));

        expect(result).toEqual({ status: 201 });
    });

    it("returns the timeout even when a graceful close never finishes", async () => {
        const connection = fakeConnect("", silentStream);

        connection.close.mockImplementation(() => new Promise<void>(() => {}));

        await expect(
            postCheckedHttps({ body: "", headers: {}, timeoutMs: 20, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection)),
        ).rejects.toMatchObject({ code: "timeout" });
    });
});
