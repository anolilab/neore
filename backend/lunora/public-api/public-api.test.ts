/// <reference lib="esnext.array" />
import { describe, expect, it, vi } from "vitest";

import { createStreamToken, verifyStreamToken } from "../chat/streaming/persistent/stream-token";
import { errorBody, errorResponse, fromProcedureError, PublicApiError } from "./errors";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotency";
import { decideIdempotency, parseIdempotencyKey, requestFingerprint, withIdempotency } from "./idempotency";
import { extractApiKey, isPublicApiPath, readApiKeyIdentity, resolveApiKeyIdentity } from "./identity";
import { decodeNativeCursor, encodeNativeCursor, MAX_PAGE_SIZE, paginateArray, parseLimit } from "./pagination";
import { DEFAULT_API_SCOPES, hasScope, parseScopes, scopesFromStrings, scopesToStrings } from "./scopes";
import type { StreamChunk, StreamSource } from "./stream";
import { blockingPollDelay, collectStream, pollStream, STREAM_MAX_READS } from "./stream";

describe("scopes", () => {
    it("parses JSON text and drops unknown resources and actions", () => {
        expect(parseScopes('{"threads":["read","delete"],"bogus":["read"],"chat":["write"]}')).toEqual({ chat: ["write"], threads: ["read"] });
        expect(parseScopes("not json")).toEqual({});
        expect(parseScopes(null)).toEqual({});
        expect(parseScopes(["threads"])).toEqual({});
    });

    it("write does not imply read", () => {
        const scopes = parseScopes({ threads: ["write"] });

        expect(hasScope(scopes, "threads", "write")).toBe(true);
        expect(hasScope(scopes, "threads", "read")).toBe(false);
    });

    it("defaults to read-only everywhere", () => {
        expect(Object.values(DEFAULT_API_SCOPES).flat()).not.toContain("write");
        expect(hasScope(DEFAULT_API_SCOPES, "memories", "read")).toBe(true);
    });

    it("round-trips scope strings and rejects typos", () => {
        const scopes = scopesFromStrings(["chat:write", "threads:read", "chat:write"]);

        expect(scopes).toEqual({ chat: ["write"], threads: ["read"] });
        expect(scopesToStrings(scopes!)).toEqual(["chat:write", "threads:read"]);
        expect(scopesFromStrings(["thread:read"])).toBeNull();
        expect(scopesFromStrings(["threads:admin"])).toBeNull();
        expect(scopesFromStrings(["threads:read:x"])).toBeNull();
    });
});

describe("errors", () => {
    it("maps procedure codes and keeps 4xx messages", () => {
        const mapped = fromProcedureError(Object.assign(new Error("You can have at most 50 tasks"), { code: "BAD_REQUEST" }));

        expect(mapped.code).toBe("invalid_request");
        expect(mapped.status).toBe(400);
        expect(mapped.message).toBe("You can have at most 50 tasks");
        expect(fromProcedureError(Object.assign(new Error("x"), { code: "TOO_MANY_REQUESTS" })).status).toBe(429);
    });

    it("hides unknown failures behind internal_error", () => {
        const mapped = fromProcedureError(new Error("SQLITE_ERROR: no such column secret"));

        expect(mapped.code).toBe("internal_error");
        expect(mapped.message).not.toContain("SQLITE");
    });

    it("renders the shared shape with request id and Retry-After", async () => {
        const response = errorResponse(new PublicApiError("rate_limited", "slow down", { retryAfterSeconds: 1.2 }), "req-1");

        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("2");
        expect(response.headers.get("X-Request-Id")).toBe("req-1");
        expect(await response.json()).toEqual(errorBody(new PublicApiError("rate_limited", "slow down", { retryAfterSeconds: 1.2 }), "req-1"));
    });
});

describe("pagination", () => {
    it("clamps and validates limit", () => {
        expect(parseLimit(undefined)).toBe(20);
        expect(parseLimit("500")).toBe(MAX_PAGE_SIZE);
        expect(() => parseLimit("0")).toThrow(PublicApiError);
        expect(() => parseLimit("abc")).toThrow(PublicApiError);
    });

    it("wraps native cursors opaquely", () => {
        const cursor = encodeNativeCursor("abc/+=", false)!;

        expect(cursor).not.toContain("abc");
        expect(decodeNativeCursor(cursor)).toBe("abc/+=");
        expect(encodeNativeCursor("abc", true)).toBeNull();
        expect(decodeNativeCursor(undefined)).toBeNull();
    });

    it("pages arrays and refuses foreign or forged cursors", () => {
        const items = Array.from({ length: 5 }, (_, index) => index);
        const first = paginateArray(items, undefined, 2);
        const second = paginateArray(items, first.nextCursor!, 2);
        const last = paginateArray(items, second.nextCursor!, 2);

        expect([first.data, second.data, last.data]).toEqual([[0, 1], [2, 3], [4]]);
        expect(last.nextCursor).toBeNull();
        expect(() => paginateArray(items, encodeNativeCursor("x", false)!, 2)).toThrow("different list");
        expect(() => decodeNativeCursor("%%%")).toThrow(PublicApiError);
    });
});

describe("identity", () => {
    const request = (headers: Record<string, string>) => new Request("https://api.example/api/v1/me", { headers });

    it("matches only the v1 prefix", () => {
        expect(isPublicApiPath("/api/v1")).toBe(true);
        expect(isPublicApiPath("/api/v1/threads")).toBe(true);
        expect(isPublicApiPath("/api/v10")).toBe(false);
        expect(isPublicApiPath("/_lunora/rpc")).toBe(false);
    });

    it("reads Bearer first, then X-API-Key", () => {
        expect(extractApiKey(new Headers({ Authorization: "Bearer nk_a", "X-API-Key": "nk_b" }))).toBe("nk_a");
        expect(extractApiKey(new Headers({ "X-API-Key": "nk_b" }))).toBe("nk_b");
        expect(extractApiKey(new Headers({ Authorization: "Basic abc" }))).toBeNull();
    });

    it("resolves a valid key to its owner with parsed scopes", async () => {
        const verify = vi.fn(async () => {
            return { key: { enabled: true, id: "key1", permissions: { chat: ["write"] }, referenceId: "user1" }, valid: true };
        });
        const identity = await resolveApiKeyIdentity(request({ Authorization: "Bearer nk_x" }), verify);

        expect(verify).toHaveBeenCalledWith("nk_x");
        expect(identity).toEqual({ apiKeyId: "key1", apiKeyScopes: { chat: ["write"] }, authMethod: "api_key", userId: "user1" });
        // What the runtime hands back: `userId` split out onto `ctx.auth.userId`.
        const { userId, ...claims } = identity!;

        expect(readApiKeyIdentity(claims, userId)).toEqual(identity);
        expect(readApiKeyIdentity(claims, undefined)).toBeNull();
    });

    it("fails closed on invalid, disabled, missing or erroring verification", async () => {
        expect(await resolveApiKeyIdentity(request({}), vi.fn())).toBeNull();
        expect(
            await resolveApiKeyIdentity(request({ Authorization: "Bearer x" }), async () => {
                return { key: null, valid: false };
            }),
        ).toBeNull();
        expect(
            await resolveApiKeyIdentity(request({ Authorization: "Bearer x" }), async () => {
                return { key: { enabled: false, id: "k", referenceId: "u" }, valid: true };
            }),
        ).toBeNull();
        expect(
            await resolveApiKeyIdentity(request({ Authorization: "Bearer x" }), async () => {
                throw new Error("D1 down");
            }),
        ).toBeNull();
    });

    it("does not accept a session identity as an API-key identity", () => {
        expect(readApiKeyIdentity({ sessionId: "s" }, "u")).toBeNull();
    });
});

describe("idempotency", () => {
    const memoryStore = (): IdempotencyStore & { rows: Map<string, IdempotencyRecord> } => {
        const rows = new Map<string, IdempotencyRecord>();

        return {
            get: async (key) => rows.get(key),
            put: async (key, value) => {
                rows.set(key, value);
            },
            remove: async (key) => {
                rows.delete(key);
            },
            rows,
        };
    };
    const options = { apiKeyId: "k1", body: '{"a":1}', idempotencyKey: "retry-1", method: "POST", pathAndQuery: "/api/v1/tasks" };

    it("validates the header", () => {
        expect(parseIdempotencyKey(null)).toBeUndefined();
        expect(parseIdempotencyKey("abc-123")).toBe("abc-123");
        expect(() => parseIdempotencyKey("")).toThrow(PublicApiError);
        expect(() => parseIdempotencyKey("has space")).toThrow(PublicApiError);
    });

    it("decides by fingerprint and state", async () => {
        const fingerprint = await requestFingerprint("POST", "/x", "{}");

        expect(decideIdempotency(undefined, fingerprint).kind).toBe("proceed");
        expect(decideIdempotency({ fingerprint: "other", state: "done", status: 200 }, fingerprint).kind).toBe("conflict");
        expect(decideIdempotency({ fingerprint, state: "pending" }, fingerprint).kind).toBe("in_progress");
        expect(decideIdempotency({ body: "{}", contentType: "application/json", fingerprint, state: "done", status: 201 }, fingerprint).kind).toBe("replay");
    });

    it("runs once and replays the stored response", async () => {
        const store = memoryStore();
        const handler = vi.fn(async () => Response.json({ id: "t1" }, { status: 201 }));

        const first = await withIdempotency(store, options, handler);
        const second = await withIdempotency(store, options, handler);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.headers.get("Idempotent-Replayed")).toBe("true");
        expect(await second.json()).toEqual({ id: "t1" });
    });

    it("refuses a reused key with a different body", async () => {
        const store = memoryStore();

        await withIdempotency(store, options, async () => Response.json({ ok: true }));

        await expect(withIdempotency(store, { ...options, body: '{"a":2}' }, async () => Response.json({ ok: true }))).rejects.toMatchObject({
            code: "idempotency_conflict",
        });
    });

    it("does not store failures, so a retry runs again", async () => {
        const store = memoryStore();

        await withIdempotency(store, options, async () => Response.json({ error: "x" }, { status: 503 }));
        await expect(
            withIdempotency(store, options, async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        expect(store.rows.size).toBe(0);
    });
});

describe("stream relay", () => {
    const source = (statuses: string[], batches: StreamChunk[][]): StreamSource => {
        let call = 0;

        return {
            read: async () => {
                call += 1;

                return { chunks: batches[Math.min(call - 1, batches.length - 1)] ?? [], status: statuses[Math.min(call - 1, statuses.length - 1)]! };
            },
        };
    };

    /** A stream writing one chunk per read, done with the last; reads are counted. */
    const growing = (total: number) => {
        let written = 0;
        const reads = vi.fn(async (afterIndex: number) => {
            written = Math.min(total, written + 1);

            return {
                chunks: Array.from({ length: written - afterIndex }, (_, index) => {
                    return { text: `w${String(afterIndex + index)} ` };
                }),
                status: written === total ? "done" : "streaming",
            };
        });

        return { reads, source: { read: reads } satisfies StreamSource };
    };

    it("yields text in order and ends with done", async () => {
        const events = await Array.fromAsync(
            pollStream(source(["streaming", "done"], [[{ text: "Hel" }], [{ reasoning: "hm", text: "lo" }]]), { sleep: async () => {} }),
        );

        expect(events).toEqual([
            { text: "Hel", type: "text" },
            { text: "hm", type: "reasoning" },
            { text: "lo", type: "text" },
            { status: "done", type: "done" },
        ]);
    });

    it("reports a failed generation as an error event", async () => {
        const collected = await collectStream(source(["error"], [[{ text: "partial" }]]), { sleep: async () => {} });

        expect(collected).toEqual({ reasoning: "", status: "generation_failed", text: "partial" });
    });

    it("hands a long stream over with resume events, each request within the read budget, every chunk once", async () => {
        const TOTAL = 100;
        const { reads, source: stream } = growing(TOTAL);
        let text = "";
        let lastChunkIndex: number | undefined;
        const readsPerRequest: number[] = [];

        for (let request = 0; request < 10; request += 1) {
            const before = reads.mock.calls.length;
            const events = await Array.fromAsync(pollStream(stream, { afterIndex: lastChunkIndex, resumable: true, sleep: async () => {} }));

            readsPerRequest.push(reads.mock.calls.length - before);
            text += events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

            const last = events.at(-1)!;

            if (last.type !== "resume") {
                expect(last).toEqual({ status: "done", type: "done" });
                break;
            }

            lastChunkIndex = last.lastChunkIndex;
        }

        expect(text).toBe(Array.from({ length: TOTAL }, (_, index) => `w${String(index)} `).join(""));
        expect(readsPerRequest.length).toBeGreaterThan(1);
        expect(Math.max(...readsPerRequest)).toBeLessThanOrEqual(STREAM_MAX_READS);
        // Room for the router's own subrequests under the Free plan's 50.
        expect(STREAM_MAX_READS).toBeLessThanOrEqual(30);
    });

    it("ends a stream that did not opt in with a relay_budget error, not a resume", async () => {
        const { reads, source: stream } = growing(100);
        const events = await Array.fromAsync(pollStream(stream, { sleep: async () => {} }));

        expect(reads).toHaveBeenCalledTimes(STREAM_MAX_READS);
        expect(events.at(-1)).toMatchObject({ error: { code: "relay_budget" }, type: "error" });
    });

    it("stretches a blocking read's polls so the budget spans its five minutes", () => {
        const spanned = Array.from({ length: STREAM_MAX_READS - 1 }, (_, index) => blockingPollDelay(index + 1)).reduce((sum, ms) => sum + ms, 0);

        // `BLOCKING_CHAT_MAX_MS` in routes.ts.
        expect(spanned).toBeGreaterThanOrEqual(5 * 60 * 1000);
        expect(blockingPollDelay(1)).toBeLessThan(500);
    });

    it("stops at the deadline", async () => {
        let clock = 0;
        const collected = await collectStream(source(["streaming"], [[]]), {
            maxDurationMs: 1000,
            now: () => clock,
            sleep: async (ms) => {
                clock += ms;
            },
        });

        expect(collected.status).toBe("relay_timeout");
    });
});

describe("stream tokens", () => {
    it("verifies its own tokens and rejects tampering, other secrets and expiry", async () => {
        const token = await createStreamToken("s1", "u1", "t1", "secret");

        expect(await verifyStreamToken(token, "secret")).toEqual({ streamId: "s1", threadId: "t1", userId: "u1" });
        expect(await verifyStreamToken(token.replace("u1", "u2"), "secret")).toBeNull();
        expect(await verifyStreamToken(token, "other")).toBeNull();
        expect(await verifyStreamToken(token, "secret", Date.now() + 31 * 60 * 1000)).toBeNull();
        expect(await verifyStreamToken("a:b", "secret")).toBeNull();
    });
});
