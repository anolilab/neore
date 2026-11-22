/**
 * `POST /browser/release` — the hand back a page sends as it closes (`navigator.sendBeacon` on `pagehide`). A beacon
 * carries no session, so the body is the claim's release token (`release-token.ts`), as plain text: a simple request,
 * which needs no preflight. A second line may say `handed_back`: the page closed while the person's own hand back was
 * still out, so the agent is told it was handed back, not left. The reason is not signed and needs no signing: the
 * token's holder may end their lease either way through `handBack` too. The token is checked before anything is read or written; then the lease it names
 * is ended on the shard it names, and only that lease (`releaseControl`). Every answer but a refused token (401) or a
 * sender over its limit (429) is the same 204, so the route tells nobody whose lease it was or whether one was held.
 */
import type { HttpActionCtx } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { inSystemShard } from "../lib/http-shard";
import { checkRateLimit } from "../lib/rate-limiter";
import { verifyReleaseToken } from "./release-token";

/** A token is well under this; a body past it is not one. */
const MAX_BODY_CHARS = 2048;

/** The token, and how the view closed (`left` unless the body says otherwise); `undefined` for any other shape. */
const parseBody = (body: string): { reason: "handed_back" | "left"; token: string } | undefined => {
    const [token, reason = "left", ...rest] = body.split("\n").map((line: string) => line.trim());

    if (token === undefined || token === "" || rest.length > 0 || (reason !== "handed_back" && reason !== "left")) {
        return undefined;
    }

    return { reason, token };
};

const answer = (status: number): Response => new Response(null, { headers: { "cache-control": "no-store" }, status });

/** The body as text, or `undefined` past {@link MAX_BODY_CHARS} bytes: read no further than that, whatever it claims. */
const readBody = async (request: Request): Promise<string | undefined> => {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_CHARS || request.body === null) {
        return undefined;
    }

    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }) as const);

        if (done) {
            break;
        }

        size += value.byteLength;

        if (size > MAX_BODY_CHARS) {
            await reader.cancel().catch(() => undefined);

            return undefined;
        }

        chunks.push(value);
    }

    return new TextDecoder().decode(await new Blob(chunks).arrayBuffer()).trim();
};

export const releaseControlHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    const body = await readBody(request);
    const parsed = body === undefined ? undefined : parseBody(body);
    const release = parsed === undefined ? undefined : await verifyReleaseToken(parsed.token);

    if (parsed === undefined || release === undefined) {
        return answer(401);
    }

    // Only a proven token is charged, so junk never writes to the root shard; an outage of the limiter refuses nobody.
    const limited = await checkRateLimit(context, "browser/releaseIp", {
        failMode: "open",
        key: request.headers.get("cf-connecting-ip") ?? "unknown",
        throws: false,
    });

    if (!limited.ok) {
        return answer(429);
    }

    // The shard comes from the verified token (the thread owner's, where the session row is), never from the request.
    await inSystemShard(context, release.shardKey, async (shardCtx: HttpActionCtx) => {
        await shardCtx.runMutation(internal.browser.live_view.releaseControl, {
            claim: release.claim,
            reason: parsed.reason,
            threadId: release.threadId as Id<"threads">,
        });
    });

    return answer(204);
};
