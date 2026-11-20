/**
 * Which cloud browser session a person may watch, and how its live view URL is asked for. Pure, so the rules are
 * tested without the provider.
 */
import type { Doc } from "../_generated/dataModel";
import { FETCH_TIMEOUT_LONG_MS } from "../lib/fetch-timeout";

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

/**
 * How long a person keeps control of the browser with no input the card can see. The card warns
 * {@link CONTROL_WARNING_MS} before, with a button to keep control; then the agent may act again.
 */
export const CONTROL_IDLE_MS = 120_000;

/** The warning before an idle hand back: long enough to read it and press "Keep control" (WCAG 2.2.1 asks for 20 s). */
export const CONTROL_WARNING_MS = 30_000;

/** How late after the hold is written the renderer call may start and still get its whole `FETCH_TIMEOUT_LONG_MS`, as the agent's `navigate` does. */
export const CONTROL_NAVIGATION_START_MS = 10_000;

/** How long before the hold ends the renderer call is cut off at the latest, so the hold ends after it, never before. */
export const CONTROL_NAVIGATION_SETTLE_MS = 5000;

/** The hold a person's navigation writes when it begins at `now`: past the end of its renderer call, wherever that starts. */
export const controlNavigationHold = (now: number): number => now + CONTROL_NAVIGATION_START_MS + FETCH_TIMEOUT_LONG_MS + CONTROL_NAVIGATION_SETTLE_MS;

/**
 * How long the renderer call that starts at `now` may run under the hold that ends at `navigatingUntil`: the whole
 * request, or what is left of the hold less {@link CONTROL_NAVIGATION_SETTLE_MS} when it starts late. `0`: too late to start.
 */
export const controlNavigationBudget = (navigatingUntil: number, now: number): number =>
    Math.max(0, Math.min(FETCH_TIMEOUT_LONG_MS, navigatingUntil - CONTROL_NAVIGATION_SETTLE_MS - now));

type SessionRow = Pick<Doc<"browserSessions">, "control" | "inUseHolds" | "lastActivityAt" | "providerSessionId" | "source" | "status">;

/** Who drives the browser: `person` (the lease is ahead), `returned` (it ended, the agent was not told yet), or `agent`. */
export const controlStateOf = (session: Pick<SessionRow, "control">, now: number): "agent" | "person" | "returned" => {
    if (session.control === undefined) {
        return "agent";
    }

    return session.control.until > now ? "person" : "returned";
};

/**
 * Until when the browser is certainly still there: one idle window after its last action (less the margin), or, while an action is in
 * flight, until the latest deadline of those actions (the provider does not reap a browser a renderer call is connected to). A
 * person's control keeps it too: their live view stays connected to it.
 */
export const browserAliveUntil = (session: Pick<SessionRow, "control" | "inUseHolds" | "lastActivityAt">): number =>
    Math.max(
        session.lastActivityAt + BROWSER_IDLE_REAP_MS - BROWSER_REAP_MARGIN_MS,
        ...(session.inUseHolds ?? []),
        ...(session.control === undefined ? [] : [session.control.until]),
    );

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

/** The request that mints a view of the session's first page: read-only, or `interactive` for the person in control. */
export const liveViewRequest = (accountId: string, apiToken: string, providerSessionId: string, interactive = false): { init: RequestInit; url: string } => {
    return {
        init: {
            body: JSON.stringify({
                expiresInMs: LIVE_VIEW_CONNECT_DEADLINE_MS,
                ...(!interactive && { guardrails: { mode: "readonly" } }),
                mode: "tab",
            }),
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
