/**
 * The dispatcher's side of the Events extension: discovery, negotiation gating (`-32601` without it), the complete result, the
 * poll's argument checks and the error codes the router's errors become. The poll itself is faked here; `events.test.ts` runs
 * the real one.
 */
import { describe, expect, it, vi } from "vitest";

import { PublicApiError } from "./errors";
import { bytesToBase64 } from "../lib/crypto";
import { EVENT_EXTENSION_ID } from "./events-catalog";
import { EventsWebhookError } from "./events-webhook";
import type { McpDependencies, PollRequest, PollResponse } from "./mcp";
import { serveMcp } from "./mcp";

const MODERN = "2026-07-28";
const OFFER = { "io.modelcontextprotocol/clientCapabilities": { extensions: { [EVENT_EXTENSION_ID]: {} } } };

const pollBody: PollResponse = { cursor: "cursor-2", events: [], hasMore: false, nextPollMs: 5000, truncated: false };

/** A modern (2026-07-28) POST: the version and the method travel in the body and in headers, as the transport requires. */
const modern = (method: string, params: Record<string, unknown> = {}, name?: string): { body: string; headers: Headers } => {
    const body = JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method,
        params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, ...(params["_meta"] as object) } },
    });
    const headers = new Headers({ "Mcp-Method": method, "MCP-Protocol-Version": MODERN });

    if (name !== undefined) {
        headers.set("Mcp-Name", name);
    }

    return { body, headers };
};

const dependenciesWith = (request: { body: string; headers: Headers }, events: McpDependencies["events"]): McpDependencies => {
    return {
        callTool: vi.fn(),
        canUse: () => true,
        chargeProtocolCall: async () => undefined,
        events,
        request: new Request("https://neore.test/api/v1/mcp", { body: request.body, headers: request.headers, method: "POST" }),
        tools: [],
    };
};

const serve = async (request: { body: string; headers: Headers }, events?: McpDependencies["events"]) => {
    const response = await serveMcp(request.body, dependenciesWith(request, events));

    return { body: (await response.json()) as Record<string, any>, status: response.status };
};

const pollingWith = (poll: (request: PollRequest) => Promise<PollResponse>) => {
    return { poll: vi.fn(poll) };
};

describe("discovery", () => {
    it("advertises the extension as a capability with empty settings, and no top-level events capability", async () => {
        const { body } = await serve(
            modern("server/discover"),
            pollingWith(async () => pollBody),
        );
        const { capabilities } = body["result"];

        expect(capabilities.extensions).toStrictEqual({ [EVENT_EXTENSION_ID]: {} });
        expect(capabilities).not.toHaveProperty("events");
        expect(body["result"].resultType).toBe("complete");
    });

    it("does not advertise the extension where no Events poll is configured, since its methods are refused there", async () => {
        const { body } = await serve(modern("server/discover"));

        expect(body["result"].capabilities).not.toHaveProperty("extensions");
    });
});

describe("negotiation", () => {
    it("lists the catalog with resultType complete when the caller offered the extension", async () => {
        const { body } = await serve(
            modern("events/list", { _meta: OFFER }),
            pollingWith(async () => pollBody),
        );

        expect(body["result"].resultType).toBe("complete");
        expect(body["result"].events.map((event: { name: string }) => event.name)).toStrictEqual(["run.completed", "run.failed", "approval.requested"]);
    });

    it("answers -32601 to every events/* method from a modern caller that did not offer the extension", async () => {
        const poll = pollingWith(async () => pollBody);
        const list = await serve(modern("events/list"), poll);
        const pollCall = await serve(modern("events/poll", { name: "run.completed" }, "run.completed"), poll);

        expect(list.body["error"].code).toBe(-32_601);
        expect(list.status).toBe(404);
        expect(pollCall.body["error"].code).toBe(-32_601);
        expect(poll.poll).not.toHaveBeenCalled();
    });

    it("answers -32601 from a legacy caller, which has no way to negotiate", async () => {
        const legacy = {
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "events/list" }),
            headers: new Headers(),
        };
        const { body, status } = await serve(
            legacy,
            pollingWith(async () => pollBody),
        );

        expect(body["error"].code).toBe(-32_601);
        expect(status).toBe(200);
    });

    it("answers webhook methods with -32601 when the endpoint wires no webhook dependency", async () => {
        const { body } = await serve(
            modern("events/subscribe", { _meta: OFFER, name: "run.completed" }, "run.completed"),
            pollingWith(async () => pollBody),
        );

        expect(body["error"].code).toBe(-32_601);
    });

    it("answers push (events/stream) with -32601 even when negotiated", async () => {
        const { body } = await serve(
            modern("events/stream", { _meta: OFFER, name: "run.completed" }, "run.completed"),
            pollingWith(async () => pollBody),
        );

        expect(body["error"].code).toBe(-32_601);
    });
});

describe("the read allowance a poll draws on", () => {
    it("is not drawn by the protocol layer for a valid poll: the router charges it once the key's scope passes", async () => {
        const charge = vi.fn(async () => undefined);
        const request = modern("events/poll", { _meta: OFFER, cursor: null, name: "run.completed" }, "run.completed");

        await serveMcp(request.body, {
            ...dependenciesWith(
                request,
                pollingWith(async () => pollBody),
            ),
            chargeProtocolCall: charge,
        });

        expect(charge).not.toHaveBeenCalled();
    });

    it("is drawn for a malformed poll, which never reaches the router", async () => {
        const charge = vi.fn(async () => undefined);
        const request = modern("events/poll", { _meta: OFFER, cursor: null }, "run.completed");

        await serveMcp(request.body, {
            ...dependenciesWith(
                request,
                pollingWith(async () => pollBody),
            ),
            chargeProtocolCall: charge,
        });

        expect(charge).toHaveBeenCalledTimes(1);
    });
});

describe("an unsupported poll's read allowance", () => {
    it("is drawn: a request that did not offer the extension is refused as an unknown method, and still uses the allowance", async () => {
        const charge = vi.fn(async () => undefined);
        // No `_meta` offer: the extension was not negotiated, so the poll is refused before the router.
        const request = modern("events/poll", { cursor: null, name: "run.completed" }, "run.completed");

        const response = await serveMcp(request.body, {
            ...dependenciesWith(
                request,
                pollingWith(async () => pollBody),
            ),
            chargeProtocolCall: charge,
        });

        expect(charge).toHaveBeenCalledTimes(1);
        expect(await response.json()).toMatchObject({ error: { code: expect.any(Number) } });
    });
});

describe("an Events list's read allowance", () => {
    it("is drawn once when the list is answered", async () => {
        const charge = vi.fn(async () => undefined);
        const request = modern("events/list", { _meta: OFFER });

        await serveMcp(request.body, {
            ...dependenciesWith(
                request,
                pollingWith(async () => pollBody),
            ),
            chargeProtocolCall: charge,
        });

        expect(charge).toHaveBeenCalledTimes(1);
    });

    it("is drawn once when the list is refused as unsupported", async () => {
        const charge = vi.fn(async () => undefined);
        const request = modern("events/list", {});

        await serveMcp(request.body, {
            ...dependenciesWith(
                request,
                pollingWith(async () => pollBody),
            ),
            chargeProtocolCall: charge,
        });

        expect(charge).toHaveBeenCalledTimes(1);
    });
});

describe("an Events notification's read allowance", () => {
    it("is drawn: a notification gets no answer, but it is still a call", async () => {
        const charge = vi.fn(async () => undefined);
        const request = modern("events/poll", { _meta: OFFER, cursor: null, name: "run.completed" }, "run.completed");
        // The same message without its id: a notification, which the dispatcher answers with 202 and no body.
        const notification = JSON.parse(request.body) as Record<string, unknown>;

        delete notification["id"];
        const body = JSON.stringify(notification);

        const response = await serveMcp(body, {
            ...dependenciesWith(
                request,
                pollingWith(async () => pollBody),
            ),
            chargeProtocolCall: charge,
        });

        expect(response.status).toBe(202);
        expect(charge).toHaveBeenCalledTimes(1);
    });

    it("gets no body even when the allowance is spent, since a notification is never answered", async () => {
        const request = modern("events/poll", { _meta: OFFER, cursor: null, name: "run.completed" }, "run.completed");
        const notification = JSON.parse(request.body) as Record<string, unknown>;

        delete notification["id"];

        const response = await serveMcp(JSON.stringify(notification), {
            ...dependenciesWith(
                request,
                pollingWith(async () => pollBody),
            ),
            chargeProtocolCall: async () => {
                throw new PublicApiError("rate_limited", "Too many requests.", { details: { retryAfterSeconds: 30 } });
            },
        });

        expect(response.status).toBe(202);
        expect(await response.text()).toBe("");
    });
});

describe("events/subscribe and events/unsubscribe", () => {
    const SECRET = `whsec_${bytesToBase64(new Uint8Array(24).fill(7))}`;
    const subscribeParams = {
        _meta: OFFER,
        delivery: { mode: "webhook", secret: SECRET, url: "https://hooks.example.com/neore" },
        name: "run.completed",
    };
    const granted = { cursor: "cursor-2", id: "sub_0123456789abcdef", refreshBefore: "2026-11-24T00:00:00.000Z", truncated: false };

    it("answers the granted subscription with resultType complete", async () => {
        const subscribe = vi.fn(async () => granted);
        const { body } = await serve(modern("events/subscribe", subscribeParams, "run.completed"), { poll: vi.fn(), subscribe });

        expect(subscribe).toHaveBeenCalledWith(
            expect.objectContaining({ cursor: null, host: "hooks.example.com", name: "run.completed", url: "https://hooks.example.com/neore" }),
        );
        expect(body["result"]).toStrictEqual({ ...granted, resultType: "complete" });
    });

    it("refuses a secret that is not whsec_ base64 with InvalidParams, before the subscription is made", async () => {
        const subscribe = vi.fn(async () => granted);
        const params = { ...subscribeParams, delivery: { ...subscribeParams.delivery, secret: "not-a-secret" } };
        const { body } = await serve(modern("events/subscribe", params, "run.completed"), { poll: vi.fn(), subscribe });

        expect(body["error"].code).toBe(-32_602);
        expect(subscribe).not.toHaveBeenCalled();
    });

    it("answers an unknown event with NotFound, and a non-https callback with InvalidParams", async () => {
        const subscribe = vi.fn(async () => granted);
        const unknown = await serve(modern("events/subscribe", { ...subscribeParams, name: "nope" }, "nope"), { poll: vi.fn(), subscribe });
        const plain = await serve(
            // eslint-disable-next-line unicorn/prefer-https -- a plain-http callback is the case under test
            modern("events/subscribe", { ...subscribeParams, delivery: { ...subscribeParams.delivery, url: "http://hooks.example.com/x" } }, "run.completed"),
            { poll: vi.fn(), subscribe },
        );

        expect(unknown.body["error"]).toMatchObject({ code: -32_023, data: { kind: "event" } });
        expect(plain.body["error"].code).toBe(-32_602);
        expect(subscribe).not.toHaveBeenCalled();
    });

    it("carries a refusal's code and typed data into the JSON-RPC error", async () => {
        const subscribe = vi.fn(async () => {
            throw new EventsWebhookError(-32_024, "The callback host is not on this account's approved list.", { reason: "host_not_approved" });
        });
        const { body } = await serve(modern("events/subscribe", subscribeParams, "run.completed"), { poll: vi.fn(), subscribe });

        expect(body["error"]).toStrictEqual({
            code: -32_024,
            data: { reason: "host_not_approved" },
            message: "The callback host is not on this account's approved list.",
        });
    });

    it("answers unsubscribe with an empty complete result, and NotFound when no subscription matches", async () => {
        const unsubscribe = vi.fn(async () => undefined);
        const params = { _meta: OFFER, delivery: { url: "https://hooks.example.com/neore" }, name: "run.completed" };
        const ok = await serve(modern("events/unsubscribe", params, "run.completed"), { poll: vi.fn(), unsubscribe });

        expect(ok.body["result"]).toStrictEqual({ resultType: "complete" });

        const missing = await serve(modern("events/unsubscribe", params, "run.completed"), {
            poll: vi.fn(),
            unsubscribe: vi.fn(async () => {
                throw new EventsWebhookError(-32_023, "No subscription matches this key.", { kind: "subscription" });
            }),
        });

        expect(missing.body["error"]).toMatchObject({ code: -32_023, data: { kind: "subscription" } });
    });
});

describe("events/poll", () => {
    it("starts from now with a null cursor and returns the complete result", async () => {
        const poll = pollingWith(async () => pollBody);
        const { body } = await serve(modern("events/poll", { _meta: OFFER, cursor: null, name: "run.completed" }, "run.completed"), poll);

        expect(poll.poll).toHaveBeenCalledWith({ cursor: null, maxEvents: 50, name: "run.completed" });
        expect(body["result"]).toStrictEqual({ ...pollBody, resultType: "complete" });
    });

    it("sends each event's timestamp as an ISO 8601 string, not epoch milliseconds", async () => {
        const event = { data: { threadId: "t1" }, eventId: "run:s1", name: "run.completed", timestamp: Date.UTC(2026, 1, 19, 15, 30) };
        const poll = pollingWith(async () => {
            return { ...pollBody, events: [event] };
        });

        const { body } = await serve(modern("events/poll", { _meta: OFFER, cursor: null, name: "run.completed" }, "run.completed"), poll);

        expect(body["result"]["events"]).toStrictEqual([{ ...event, timestamp: "2026-02-19T15:30:00.000Z" }]);
    });

    it("passes the cursor, the bounds and the threadId filter through, with the spec's defaults", async () => {
        const poll = pollingWith(async () => pollBody);

        await serve(
            modern(
                "events/poll",
                { _meta: OFFER, arguments: { threadId: "t1" }, cursor: "abc.def", maxAgeMs: 300_000, maxEvents: 10, name: "approval.requested" },
                "approval.requested",
            ),
            poll,
        );

        expect(poll.poll).toHaveBeenCalledWith({ cursor: "abc.def", maxAgeMs: 300_000, maxEvents: 10, name: "approval.requested", threadId: "t1" });
    });

    it("answers NotFound for an unknown event, and InvalidParams for arguments the schema does not declare", async () => {
        const poll = pollingWith(async () => pollBody);
        const unknown = await serve(modern("events/poll", { _meta: OFFER, name: "run.started" }, "run.started"), poll);
        const badArgs = await serve(modern("events/poll", { _meta: OFFER, arguments: { severity: "P1" }, name: "run.completed" }, "run.completed"), poll);
        const badMax = await serve(modern("events/poll", { _meta: OFFER, maxEvents: 500, name: "run.completed" }, "run.completed"), poll);

        expect(unknown.body["error"]).toMatchObject({ code: -32_023, data: { kind: "event" } });
        expect(badArgs.body["error"].code).toBe(-32_602);
        expect(badMax.body["error"].code).toBe(-32_602);
        expect(poll.poll).not.toHaveBeenCalled();
    });

    it("answers InvalidParams for a cursor the router refuses, and Forbidden for a key without threads:read", async () => {
        const refusedCursor = pollingWith(async () => {
            throw new PublicApiError("invalid_request", "`cursor` is not one this key was given.");
        });
        const noScope = pollingWith(async () => {
            throw new PublicApiError("insufficient_scope", "This API key lacks the required scope: threads:read.");
        });

        const badCursor = await serve(modern("events/poll", { _meta: OFFER, cursor: "forged", name: "run.completed" }, "run.completed"), refusedCursor);
        const forbidden = await serve(modern("events/poll", { _meta: OFFER, cursor: null, name: "run.completed" }, "run.completed"), noScope);

        expect(badCursor.body["error"]).toMatchObject({ code: -32_602, message: "`cursor` is not one this key was given." });
        expect(forbidden.body["error"]).toMatchObject({ code: -32_024, data: { reason: "insufficient_scope", scope: "threads:read" } });
        expect(forbidden.body["result"]).toBeUndefined();
    });

    it("answers Forbidden, not a server error, for a suspended account's poll", async () => {
        const suspended = pollingWith(async () => {
            throw new PublicApiError("forbidden", "Your account has been suspended");
        });

        const { body } = await serve(modern("events/poll", { _meta: OFFER, cursor: null, name: "run.completed" }, "run.completed"), suspended);

        expect(body["error"]).toMatchObject({ code: -32_024, data: { reason: "forbidden" }, message: "Your account has been suspended" });
        expect(body["result"]).toBeUndefined();
    });

    it("refuses a request whose Mcp-Name header is not the event name, as a header mismatch", async () => {
        const poll = pollingWith(async () => pollBody);
        const { body, status } = await serve(modern("events/poll", { _meta: OFFER, name: "run.completed" }, "run.failed"), poll);

        expect(status).toBe(400);
        expect(body["error"].code).toBe(-32_020);
        expect(poll.poll).not.toHaveBeenCalled();
    });
});

describe("a read allowance spent on an Events call", () => {
    it("answers the call with its own request id as a rate-limit error, not a REST body", async () => {
        const limited = async (): Promise<void> => {
            throw new PublicApiError("rate_limited", "Too many requests for this API key.", { retryAfterSeconds: 2 });
        };

        for (const request of [modern("events/list", { _meta: OFFER }), modern("events/poll", { name: "run.completed" }, "run.completed")]) {
            const response = await serveMcp(request.body, {
                ...dependenciesWith(
                    request,
                    pollingWith(async () => pollBody),
                ),
                chargeProtocolCall: limited,
            });
            const body = (await response.json()) as Record<string, any>;

            expect(response.status).toBe(429);
            expect(body["id"]).toBe(1);
            expect(body["error"]).toMatchObject({ code: -32_025, data: { reason: "rate_limited", retryAfterSeconds: 2 } });
        }
    });
});

describe("an Events call that fails inside the router", () => {
    it("answers with a JSON-RPC error carrying the request's id, not a REST body", async () => {
        const failing = pollingWith(async () => {
            throw new PublicApiError("internal_error", "An unexpected error occurred.");
        });
        const { body, status } = await serve(modern("events/poll", { _meta: OFFER, name: "run.completed" }, "run.completed"), failing);

        expect(status).toBe(500);
        expect(body["id"]).toBe(1);
        expect(body["error"]).toMatchObject({ code: -32_603, data: { reason: "internal_error" }, message: "An unexpected error occurred." });
    });
});
