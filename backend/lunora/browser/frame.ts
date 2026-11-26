/**
 * A still frame of the thread's cloud browser, for a client that cannot frame the provider's live view (the phone). The
 * same reader decision as the live view (`getReaderBrowser`), the same refusal while another person drives the
 * browser, and nothing the agent pays for: the renderer only reconnects to the browser the row names (`reconnectOnly`),
 * so a browser the provider reaped is `ended`, never replaced. The read stamps no activity and takes no hold on the row,
 * so it never holds the agent off and never moves the row's idle clock: once the row reads the browser as reaped, no
 * further frame is taken. The renderer shares the session with an agent action in flight (`session-lock.ts`: several
 * connections may share one session; only a sign-in holds it alone, which answers `busy`).
 */
import { browserAction, type BrowserActionResponse, createBrowserRendererClient } from "@neore/service-sdk/browser-renderer";
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { authAction, rateLimit } from "../lib/crpc";
import { throwThreadNotFound } from "../lib/error-helpers";
import { FETCH_TIMEOUT_MS } from "../lib/fetch-timeout";
import { isServiceBound, serviceFetch } from "../lib/services";

/**
 * The largest frame returned, in base64 characters (about 512 KiB of JPEG). A viewport JPEG is far smaller; a page that
 * is not stays well inside the RPC body's cap instead of failing with an error no one can read.
 */
export const MAX_FRAME_BASE64 = 700_000;

/**
 * `ok`: a JPEG of the browser's viewport (`viewport`, in CSS pixels, when the renderer knew it) at `takenAt`, the
 * server's clock. `controlled`: another person drives the browser and may be typing a password, so no one else sees
 * it meanwhile. `ended`: no browser is running that the caller may watch, or the provider no longer has it. `busy`: a
 * saved sign-in is being filled in on it. `unavailable`: the deploy has no renderer, or the renderer failed.
 */
export const readBrowserFrame = authAction
    .input({ threadId: v.id("threads") })
    .use(rateLimit("browser/frame"))
    .output(
        v.union(
            v.object({
                image: v.string(),
                status: v.literal("ok"),
                takenAt: v.number(),
                viewport: v.optional(v.object({ height: v.number(), width: v.number() })),
            }),
            v.object({ status: v.union(v.literal("busy"), v.literal("controlled"), v.literal("ended"), v.literal("unavailable")) }),
        ),
    )
    .action(async ({ args: { threadId }, ctx }) => {
        const { userId } = ctx.user;
        const browser = await ctx.runQuery(internal.browser.live_view.getReaderBrowser, { threadId, userId });

        if (browser.kind === "denied") {
            return throwThreadNotFound();
        }

        if (browser.kind === "none") {
            return { status: "ended" as const };
        }

        if (browser.controlledByOther) {
            return { status: "controlled" as const };
        }

        if (!isServiceBound(ctx, "browserRenderer")) {
            return { status: "unavailable" as const };
        }

        const client = createBrowserRendererClient({ fetch: serviceFetch(ctx, "browserRenderer") });
        const { data, response } = await browserAction({
            body: { action: "screenshot", fullPage: false, reconnectOnly: true, sessionId: browser.providerSessionId },
            client,
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }).catch(() => {
            return { data: undefined, response: undefined };
        });

        if (response?.status === 404 || response?.status === 410) {
            ctx.log.event("browser.frame_read", { ok: false, reason: "ended" });

            return { status: "ended" as const };
        }

        if (response?.status === 409) {
            return { status: "busy" as const };
        }

        const result = data as BrowserActionResponse | undefined;

        if (result?.success !== true || typeof result.screenshot !== "string" || result.screenshot === "") {
            ctx.log.event("browser.frame_read", { ok: false, status: response?.status ?? 0 });

            return { status: "unavailable" as const };
        }

        if (result.screenshot.length > MAX_FRAME_BASE64) {
            ctx.log.event("browser.frame_read", { ok: false, reason: "too_large" });

            return { status: "unavailable" as const };
        }

        // The shot takes time: a grant removed or a chat locked meanwhile gets no frame, and neither does a browser
        // someone else took control of (what they type may be on it) or one an agent action replaced.
        const after = await ctx.runQuery(internal.browser.live_view.getReaderBrowser, { at: Date.now(), threadId, userId });

        if (after.kind === "denied") {
            return throwThreadNotFound();
        }

        if (after.kind === "none" || after.providerSessionId !== browser.providerSessionId) {
            return { status: "ended" as const };
        }

        if (after.controlledByOther) {
            return { status: "controlled" as const };
        }

        return {
            image: result.screenshot,
            status: "ok" as const,
            takenAt: Date.now(),
            ...(result.viewport !== undefined && { viewport: { height: result.viewport.height, width: result.viewport.width } }),
        };
    });
