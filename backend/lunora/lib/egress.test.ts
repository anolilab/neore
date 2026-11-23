/**
 * The checked outbound POST (`egress.ts`). The DNS fetch and the socket are fakes, so no test reaches the network. The
 * live path (a real connect and a real certificate check) is not covered here and must be checked on a dev run.
 */
/* eslint-disable sonarjs/no-hardcoded-ip -- the addresses under test are literals: private, reserved and public ones */
import { describe, expect, it, vi } from "vitest";

import type { EgressConnect, EgressDependencies, EgressSocket } from "./egress";
import { addressTimeoutMs, EgressError, isCloudflareAddress, isPublicIPv4, isPublicIPv6, postCheckedHttps } from "./egress";

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
        opened: Promise.resolve(),
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
        opened: Promise.resolve(),
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

/**
 * A `connect` that behaves per address: `unreachable` fails the connection before anything is written, `tls-fails` connects
 * but fails the TLS handshake, `reset` takes the request and then drops the connection, `body-fails` takes the head and
 * fails on the body, and a string is the response that address answers with. Every socket opened is kept in `sockets`.
 */
const perAddressConnect = (behaviour: Record<string, string>) => {
    const tried: string[] = [];
    const tls: { address: string; hostname: string }[] = [];
    const sockets: { address: string; close: ReturnType<typeof vi.fn>; kind: "plain" | "tls" }[] = [];
    const writes: Record<string, number> = {};
    const fail = (message: string): Promise<never> => {
        const promise = Promise.reject(new Error(message));

        promise.catch(() => undefined);

        return promise;
    };
    const connect = vi.fn(((address) => {
        tried.push(address.hostname);

        const mode = behaviour[address.hostname] ?? "unreachable";
        const socketFor = (kind: "plain" | "tls"): EgressSocket => {
            const close = vi.fn(async () => {});

            sockets.push({ address: address.hostname, close, kind });

            let opened: Promise<unknown> = Promise.resolve();

            if (mode === "unreachable") {
                opened = fail("connection refused");
            } else if (kind === "tls" && mode === "tls-fails") {
                opened = fail("handshake failed");
            }

            return {
                close,
                opened,
                readable:
                    mode === "reset"
                        ? new ReadableStream<Uint8Array>({
                              start(controller) {
                                  controller.error(new Error("connection reset"));
                              },
                          })
                        : textStream(mode),
                startTls: vi.fn(({ expectedServerHostname }) => {
                    tls.push({ address: address.hostname, hostname: expectedServerHostname });

                    return socketFor("tls");
                }),
                writable: new WritableStream<Uint8Array>({
                    write() {
                        writes[address.hostname] = (writes[address.hostname] ?? 0) + 1;

                        if (mode === "body-fails" && writes[address.hostname]! > 1) {
                            throw new Error("connection reset while writing");
                        }
                    },
                }),
            };
        };

        return socketFor("plain");
    }) as EgressConnect);

    return { connect, sockets, tls, tried, writes };
};

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

describe("isCloudflareAddress", () => {
    it.each(["104.16.0.1", "172.64.0.1", "173.245.48.1", "2606:4700:4700::1111", "2606:4700::1"])("flags %s", (address) => {
        expect(isCloudflareAddress(address)).toBe(true);
    });

    it.each(["93.184.216.34", "8.8.8.8", "104.15.255.255", "2a00:1450::1"])("does not flag %s", (address) => {
        expect(isCloudflareAddress(address)).toBe(false);
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

    it("refuses a host that has one Cloudflare answer, before connecting", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");

        await expect(
            postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34", "104.16.0.1"] }), connection)),
        ).rejects.toMatchObject({ code: "unsupported_target" });
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it("refuses a host with an IPv6 answer inside a Cloudflare range", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");

        await expect(
            postCheckedHttps({ body: "", headers: {}, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"], AAAA: ["2606:4700::1"] }), connection)),
        ).rejects.toMatchObject({ code: "unsupported_target" });
        expect(connection.connect).not.toHaveBeenCalled();
    });

    it("refuses a Cloudflare IP literal without a lookup", async () => {
        const connection = fakeConnect("HTTP/1.1 204 No Content\r\n\r\n");
        const fetch = dnsFetch({ A: ["8.8.8.8"] });

        await expect(postCheckedHttps({ body: "", headers: {}, url: "https://104.16.0.1/hook" }, dependencies(fetch, connection))).rejects.toMatchObject({
            code: "unsupported_target",
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

    it("moves on to the next checked address when one cannot be reached, keeping the host name for the certificate", async () => {
        const { connect, tls, tried } = perAddressConnect({ "2a00:1450::1": "HTTP/1.1 204 No Content\r\n\r\n" });

        const result = await postCheckedHttps(
            { body: "", headers: {}, url: HOOK },
            { connect, fetch: dnsFetch({ A: ["93.184.216.34"], AAAA: ["2a00:1450::1"] }) },
        );

        expect(result).toEqual({ status: 204 });
        expect(tried).toStrictEqual(["93.184.216.34", "2a00:1450::1"]);
        expect(tls.every(({ hostname }) => hostname === "hooks.example.com")).toBe(true);
    });

    it("fails as a connection failure when no checked address can be reached", async () => {
        const { connect, tried } = perAddressConnect({});

        await expect(
            postCheckedHttps({ body: "", headers: {}, url: HOOK }, { connect, fetch: dnsFetch({ A: ["93.184.216.34", "8.8.8.8"] }) }),
        ).rejects.toMatchObject({ code: "bad_response" });
        expect(tried).toStrictEqual(["93.184.216.34", "8.8.8.8"]);
    });

    it("tries no other address once the request was written, so a receiver never gets it twice", async () => {
        const { connect, tried } = perAddressConnect({ "8.8.8.8": "HTTP/1.1 204 No Content\r\n\r\n", "93.184.216.34": "reset" });

        await expect(
            postCheckedHttps({ body: "", headers: {}, url: HOOK }, { connect, fetch: dnsFetch({ A: ["93.184.216.34", "8.8.8.8"] }) }),
        ).rejects.toMatchObject({ code: "bad_response" });
        expect(tried).toStrictEqual(["93.184.216.34"]);
    });

    it("tries no other address when the head was written and the body write fails", async () => {
        const { connect, tried, writes } = perAddressConnect({ "8.8.8.8": "HTTP/1.1 204 No Content\r\n\r\n", "93.184.216.34": "body-fails" });

        await expect(
            postCheckedHttps({ body: "{}", headers: {}, url: HOOK }, { connect, fetch: dnsFetch({ A: ["93.184.216.34", "8.8.8.8"] }) }),
        ).rejects.toMatchObject({ code: "bad_response" });
        expect(writes["93.184.216.34"]).toBe(2);
        expect(tried).toStrictEqual(["93.184.216.34"]);
    });

    it("closes both sockets of an address whose TLS setup fails before trying the next one", async () => {
        const { connect, sockets, tried } = perAddressConnect({ "8.8.8.8": "HTTP/1.1 204 No Content\r\n\r\n", "93.184.216.34": "tls-fails" });

        const result = await postCheckedHttps({ body: "", headers: {}, url: HOOK }, { connect, fetch: dnsFetch({ A: ["93.184.216.34", "8.8.8.8"] }) });

        expect(result).toEqual({ status: 204 });
        expect(tried).toStrictEqual(["93.184.216.34", "8.8.8.8"]);

        const failed = sockets.filter(({ address }) => address === "93.184.216.34");

        expect(failed.map(({ kind }) => kind)).toStrictEqual(["plain", "tls"]);
        expect(failed.every(({ close }) => close.mock.calls.length > 0)).toBe(true);
        // Both closes started before the next address was connected.
        const nextConnectOrder = connect.mock.invocationCallOrder[1]!;

        expect(failed.every(({ close }) => close.mock.invocationCallOrder[0]! < nextConnectOrder)).toBe(true);
    });

    it("closes the plain socket when starting TLS throws", async () => {
        const reachable = perAddressConnect({ "8.8.8.8": "HTTP/1.1 204 No Content\r\n\r\n" });
        const plainClose = vi.fn(async () => {});
        const connect = vi.fn(((address, options) => {
            if (address.hostname === "93.184.216.34") {
                return {
                    close: plainClose,
                    opened: Promise.resolve(),
                    readable: silentStream(),
                    startTls: () => {
                        throw new Error("TLS could not start");
                    },
                    writable: new WritableStream<Uint8Array>(),
                };
            }

            return reachable.connect(address, options);
        }) as EgressConnect);

        const result = await postCheckedHttps({ body: "", headers: {}, url: HOOK }, { connect, fetch: dnsFetch({ A: ["93.184.216.34", "8.8.8.8"] }) });

        expect(result).toEqual({ status: 204 });
        expect(reachable.tried).toStrictEqual(["8.8.8.8"]);
        // Closed before the next address was connected (and again by the final cleanup, which is harmless).
        expect(plainClose.mock.invocationCallOrder[0]!).toBeLessThan(reachable.connect.mock.invocationCallOrder[0]!);
    });

    it("opens nothing for a host with a refused address among reachable ones", async () => {
        const { connect, tried } = perAddressConnect({ "8.8.8.8": "HTTP/1.1 204 No Content\r\n\r\n" });

        await expect(
            postCheckedHttps({ body: "", headers: {}, url: HOOK }, { connect, fetch: dnsFetch({ A: ["93.184.216.34", "10.0.0.5", "8.8.8.8"] }) }),
        ).rejects.toMatchObject({ code: "blocked_address" });
        expect(tried).toStrictEqual([]);
    });

    it("moves on to the next address when the first one never answers, within the deadline", async () => {
        const { connect, sockets, tried } = perAddressConnect({ "8.8.8.8": "HTTP/1.1 204 No Content\r\n\r\n" });
        // The first address drops every packet: its connection never opens and never fails.
        const silentFirst = vi.fn(((address, options) => {
            const socket = connect(address, options);

            return address.hostname === "93.184.216.34" ? { ...socket, opened: new Promise<never>(() => {}) } : socket;
        }) as EgressConnect);
        const startedAt = Date.now();

        const result = await postCheckedHttps(
            { body: "", headers: {}, timeoutMs: 300, url: HOOK },
            { connect: silentFirst, fetch: dnsFetch({ A: ["93.184.216.34", "8.8.8.8"] }) },
        );

        expect(result).toEqual({ status: 204 });
        expect(Date.now() - startedAt).toBeLessThan(300);
        expect(tried).toStrictEqual(["93.184.216.34", "8.8.8.8"]);
        // The silent address's socket was closed before the next address was connected.
        const silent = sockets.find(({ address }) => address === "93.184.216.34")!;

        expect(silent.close.mock.invocationCallOrder[0]!).toBeLessThan(connect.mock.invocationCallOrder[1]!);
    });

    it("gives the next address a turn when a TLS setup never finishes", async () => {
        const { connect, tried } = perAddressConnect({ "8.8.8.8": "HTTP/1.1 204 No Content\r\n\r\n" });
        const hangingTls = vi.fn(((address, options) => {
            const socket = connect(address, options);

            if (address.hostname !== "93.184.216.34") {
                return socket;
            }

            const tlsSocket = { ...socket, opened: new Promise<never>(() => {}) };

            return { ...socket, opened: Promise.resolve(), startTls: () => tlsSocket };
        }) as EgressConnect);

        const result = await postCheckedHttps(
            { body: "", headers: {}, timeoutMs: 300, url: HOOK },
            { connect: hangingTls, fetch: dnsFetch({ A: ["93.184.216.34", "8.8.8.8"] }) },
        );

        expect(result).toEqual({ status: 204 });
        expect(tried).toStrictEqual(["93.184.216.34", "8.8.8.8"]);
    });

    it.each([
        ["two", ["93.184.216.34", "8.8.8.8"]],
        ["four", ["93.184.216.34", "8.8.8.8", "9.9.9.9", "1.1.1.1"]],
    ])("times out when all %s addresses are silent, and writes nothing", async (_count, addresses) => {
        const { connect, tried, writes } = perAddressConnect({});
        const silent = vi.fn(((address, options) => {
            return { ...connect(address, options), opened: new Promise<never>(() => {}) };
        }) as EgressConnect);
        const startedAt = Date.now();

        await expect(
            postCheckedHttps({ body: "", headers: {}, timeoutMs: 60, url: HOOK }, { connect: silent, fetch: dnsFetch({ A: addresses }) }),
        ).rejects.toMatchObject({ code: "timeout" });
        // One deadline for all addresses, not one per address.
        expect(Date.now() - startedAt).toBeLessThan(200);
        expect(tried.length).toBeLessThanOrEqual(addresses.length);
        expect(Object.keys(writes)).toStrictEqual([]);
    });

    it("never gives one address more than the time left before the deadline", () => {
        expect(addressTimeoutMs(10_000, 10_000)).toBe(3334);
        expect(addressTimeoutMs(10_000, 1200)).toBe(1200);
        expect(addressTimeoutMs(10_000, 0)).toBe(0);
        expect(addressTimeoutMs(10_000, -5)).toBe(0);
    });

    it("returns the timeout even when a graceful close never finishes", async () => {
        const connection = fakeConnect("", silentStream);

        connection.close.mockImplementation(() => new Promise<void>(() => {}));

        await expect(
            postCheckedHttps({ body: "", headers: {}, timeoutMs: 20, url: HOOK }, dependencies(dnsFetch({ A: ["93.184.216.34"] }), connection)),
        ).rejects.toMatchObject({ code: "timeout" });
    });
});
