/**
 * Which cloud browser session a person may watch, and how its live view URL is asked for. Pure, so the rules are
 * tested without the provider.
 */
import type { Doc } from "../_generated/dataModel";

/**
 * How long the browser-renderer Worker keeps an idle browser before the provider reaps it
 * (`KEEP_ALIVE_MS` in `services/browser-renderer/src/index.ts`). A row whose last action is older is a browser
 * that is gone, whatever its `status` still says: nothing closes the row when the provider reaps it.
 */
export const BROWSER_IDLE_REAP_MS = 60_000;

/**
 * The provider's idle clock starts when the renderer disconnects, a little before the action's row is stamped. A
 * browser this close to its reap is treated as gone already, so it is neither offered nor held by a new action.
 */
export const BROWSER_REAP_MARGIN_MS = 5000;

/** The `providerSessionId` written when the renderer returned no reusable session: there is nothing to watch. */
export const NO_PROVIDER_SESSION = "cf-browser-rendering";

/** The shortest deadline the provider accepts for opening a live view URL; it bounds only the connect, not the view. */
export const LIVE_VIEW_CONNECT_DEADLINE_MS = 60_000;

/** The only origin a live view URL may point at. Anything else from the provider is refused, never framed. */
export const LIVE_VIEW_ORIGIN = "https://live.browser.run";

type SessionRow = Pick<Doc<"browserSessions">, "inUseHolds" | "lastActivityAt" | "providerSessionId" | "source" | "status">;

/**
 * Until when the browser is certainly still there: one idle window after its last action (less the margin), or, while an action is in
 * flight, until the latest deadline of those actions (the provider does not reap a browser a renderer call is connected to).
 */
export const browserAliveUntil = (session: Pick<SessionRow, "inUseHolds" | "lastActivityAt">): number =>
    Math.max(session.lastActivityAt + BROWSER_IDLE_REAP_MS - BROWSER_REAP_MARGIN_MS, ...(session.inUseHolds ?? []));

/** The provider session id a person can watch, or `undefined`: closed, idle past the reap, the extension, or none. */
export const watchableSessionId = (session: SessionRow | null | undefined, now: number): string | undefined => {
    if (!session || session.status !== "active" || session.source === "extension") {
        return undefined;
    }

    if (now > browserAliveUntil(session)) {
        return undefined;
    }

    const id = session.providerSessionId;

    return id === undefined || ["", NO_PROVIDER_SESSION].includes(id) ? undefined : id;
};

/** The request that mints a read-only view of the session's first page. */
export const liveViewRequest = (accountId: string, apiToken: string, providerSessionId: string): { init: RequestInit; url: string } => {
    return {
        init: {
            body: JSON.stringify({ expiresInMs: LIVE_VIEW_CONNECT_DEADLINE_MS, guardrails: { mode: "readonly" }, mode: "tab" }),
            headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
            method: "POST",
        },
        url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/devtools/browser/${encodeURIComponent(providerSessionId)}/live_view`,
    };
};

/**
 * The view URL from the provider's answer (flat, or inside the usual `result` envelope), or `undefined` when it is
 * missing or points anywhere but the live view origin over https.
 */
export const liveViewUrlFrom = (body: unknown): string | undefined => {
    const record = body as { devtoolsFrontendUrl?: unknown; result?: { devtoolsFrontendUrl?: unknown } } | null;
    const raw = record?.devtoolsFrontendUrl ?? record?.result?.devtoolsFrontendUrl;

    if (typeof raw !== "string") {
        return undefined;
    }

    try {
        return new URL(raw).origin === LIVE_VIEW_ORIGIN ? raw : undefined;
    } catch {
        return undefined;
    }
};
