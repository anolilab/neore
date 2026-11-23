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
        const { body } = await serve(modern("server/discover"));
        const { capabilities } = body["result"];

        expect(capabilities.extensions).toStrictEqual({ [EVENT_EXTENSION_ID]: {} });
        expect(capabilities).not.toHaveProperty("events");
        expect(body["result"].resultType).toBe("complete");
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

    it("answers push (events/stream) with -32601 even when negotiated", async () => {
        const { body } = await serve(
            modern("events/stream", { _meta: OFFER, name: "run.completed" }, "run.completed"),
            pollingWith(async () => pollBody),
        );

        expect(body["error"].code).toBe(-32_601);
    });

    it("answers webhook methods with -32601 when the endpoint wires no webhook dependency", async () => {
        const { body } = await serve(
            modern("events/subscribe", { _meta: OFFER, name: "run.completed" }, "run.completed"),
            pollingWith(async () => pollBody),
        );

        expect(body["error"].code).toBe(-32_601);
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

    it("refuses a request whose Mcp-Name header is not the event name, as a header mismatch", async () => {
        const poll = pollingWith(async () => pollBody);
        const { body, status } = await serve(modern("events/poll", { _meta: OFFER, name: "run.completed" }, "run.failed"), poll);

        expect(status).toBe(400);
        expect(body["error"].code).toBe(-32_020);
        expect(poll.poll).not.toHaveBeenCalled();
    });
});
