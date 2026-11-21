/**
 * The channel lock of a saved-login sign-in: what request interception never sees (a worker, a shared worker, a
 * service worker's sockets, a new window, WebRTC) is refused in the tab from before the login page loads until the
 * password is cleared.
 */
import type { CDPSession, Page, Route } from "@cloudflare/playwright";

/**
 * Runs first in every document of the tab while the lock holds, the blank and `srcdoc` frames a script makes included.
 * Workers, WebRTC, WebTransport and `WebSocketStream` reach the network past what request interception sees, so they
 * throw (the tab's own target also holds any worker it starts, should a realm escape this). So do the requests a page
 * hands the browser to send when it unloads, which interception misses too: `fetchLater`, a `keepalive` fetch (however
 * its options are given), and a
 * beacon (`sendBeacon` returns `false`, as for one the browser would not queue). The page loses its ways to talk to a
 * service worker (`navigator.serviceWorker`, `BroadcastChannel`), whose sockets nothing here sees either: gone rather
 * than throwing, so a site that checks for them goes on without. `window.open` (and `document.open` with three
 * arguments, the same call) returns `null`: a new window's first blank document is a fresh realm the opener could
 * script before the lock reaches it.
 */
const PAGE_LOCK = `(() => {
    const refuse = (name) => function () { throw new DOMException(name + " is off while a saved login signs in", "SecurityError"); };
    const fix = (target, name, value) => Object.defineProperty(target, name, { configurable: false, value, writable: false });
    for (const name of ["RTCPeerConnection", "SharedWorker", "WebSocketStream", "WebTransport", "Worker", "fetchLater", "webkitRTCPeerConnection"]) {
        if (name in globalThis) fix(globalThis, name, refuse(name));
    }
    // The request is built once, by the browser's own Request, and only that is sent: options read twice could differ.
    const { fetch, Request: NativeRequest } = globalThis;
    const { apply } = Reflect;
    const isKeptAlive = Object.getOwnPropertyDescriptor(NativeRequest.prototype, "keepalive").get;
    fix(globalThis, "fetch", function (input, init) {
        try {
            const request = new NativeRequest(input, init);
            return apply(isKeptAlive, request, []) ? refuse("A keepalive fetch")() : apply(fetch, globalThis, [request]);
        } catch (error) {
            return Promise.reject(error);
        }
    });
    fix(Navigator.prototype, "sendBeacon", () => false);
    delete Navigator.prototype.serviceWorker;
    delete globalThis.BroadcastChannel;
    fix(globalThis, "open", () => null);
    const { open } = Document.prototype;
    fix(Document.prototype, "open", function (...args) { return args.length > 2 ? null : open.apply(this, args); });
})();`;

/** What a target the lock stopped was, for a message. */
const KINDS = new Map([
    ["page", "a new window"],
    ["shared_worker", "a shared worker"],
    ["worker", "a worker"],
]);

/**
 * The targets of a tab's context the browser session closes: windows and shared workers. Not a service worker: closing
 * one only stops it, its target stays, and a command for it (Playwright sends one on every `route()`) waits until it
 * runs again.
 */
const CLOSED_TYPES = new Set(["page", "shared_worker"]);

interface TargetInfo {
    browserContextId?: string;
    targetId: string;
    type: string;
}

interface Attached {
    sessionId: string;
    targetInfo: TargetInfo;
    waitingForDebugger: boolean;
}

/** Sends a command into one target, through the sessions between: fire and forget, in order. */
type Post = (method: string, params?: Record<string, boolean | string>) => void;

export interface ChannelLock {
    /** Told of each target stopped from here on; `null` to stop telling. */
    onRefused: (listener: ((what: string) => void) | null) => void;
    /** The first target stopped since the lock was set, for an error message. */
    refused: () => string | null;
    /** Lifts the lock: every session it holds is detached, which drops its script and settings with it. */
    release: () => Promise<void>;

    /**
     * Decides each request of the context from here on; `null` lets them all through. The route is set before the page
     * loads: one added to a loaded document never sees the prefetches it asks for.
     */
    route: (handler: ((route: Route) => Promise<void>) | null) => void;
}

/**
 * Locks the tab's channels that request interception does not see, until `release()`:
 *
 * - On the tab's own target and every cross-site frame under it (attached paused, then let run): the `PAGE_LOCK` script
 *   in each new document, and the tab's requests bypass its service worker.
 * - Every worker the tab's own target starts (a script URL, `blob:` or `data:`, from any of its frames) is held before it
 *   runs a line, and stays held until the lock lifts, by when the document that started it is gone. So is anything else
 *   it starts (a prerendered page). Only a flat session holds a target, and only a non-flat one can talk to a child, so
 *   the tab has one of each: the flat one holds, the non-flat one locks the cross-site frames.
 * - Across the browser, every new window and shared worker of the tab's context is closed before it runs a line, and so
 *   are the ones already open (other tabs of the context included: a same-origin tab hears the page's storage events).
 *
 * Throws, and holds nothing, when any part cannot be set up: the password is then never typed.
 */
export const lockChannels = async (page: Page): Promise<ChannelLock> => {
    let first: string | null = null;
    let listener: ((what: string) => void) | null = null;
    let decide: ((route: Route) => Promise<void>) | null = null;
    let isRouted = false;
    let id = 0;
    const sessions: CDPSession[] = [];

    const refuse = (kind: string): void => {
        const what = KINDS.get(kind) ?? `a ${kind.replaceAll("_", " ")}`;

        first ??= what;
        listener?.(what);
    };

    const onRoute = async (route: Route): Promise<void> => (decide ? decide(route) : route.fallback());

    const release = async (): Promise<void> => {
        listener = null;
        decide = null;

        const held = [...sessions];

        sessions.length = 0;
        await Promise.all([
            ...held.map(async (session) => session.detach().catch(() => undefined)),
            isRouted
                ? page
                      .context()
                      .unroute("**/*", onRoute)
                      .catch(() => undefined)
                : undefined,
        ]);
        isRouted = false;
    };

    const postTo =
        (session: CDPSession): Post =>
        (method, params = {}) => {
            session.send(method as "Runtime.evaluate", params as never).catch(() => undefined);
        };

    const into =
        (parent: Post, sessionId: string): Post =>
        (method, params = {}) => {
            id += 1;
            parent("Target.sendMessageToTarget", { message: JSON.stringify({ id, method, params }), sessionId });
        };

    const lockDocuments = (post: Post): void => {
        post("Page.enable");
        post("Page.addScriptToEvaluateOnNewDocument", { runImmediately: true, source: PAGE_LOCK });
        post("Target.setAutoAttach", { autoAttach: true, flatten: false, waitForDebuggerOnStart: true });
    };

    /**
     * A target a document of the tab started, seen by the non-flat session: a cross-site frame is locked and let run.
     * Anything else is the flat session's to hold on the tab itself; started in a cross-site frame, past its script,
     * it is reported.
     */
    const onChild = (parent: Post, { sessionId, targetInfo, waitingForDebugger }: Attached, isNested: boolean): void => {
        const post = into(parent, sessionId);

        if (targetInfo.type === "iframe") {
            lockDocuments(post);
            post("Runtime.runIfWaitingForDebugger");
        } else if (isNested && waitingForDebugger) {
            refuse(targetInfo.type);
        }
    };

    /** A message from a child session: its own children are attached and talked to through it. */
    const onMessage = (parent: Post, { message, sessionId }: { message: string; sessionId: string }): void => {
        let parsed: { method?: string; params?: unknown };

        try {
            parsed = JSON.parse(message) as typeof parsed;
        } catch {
            return;
        }

        if (parsed.method === "Target.attachedToTarget") {
            onChild(into(parent, sessionId), parsed.params as Attached, true);
        } else if (parsed.method === "Target.receivedMessageFromTarget") {
            onMessage(into(parent, sessionId), parsed.params as { message: string; sessionId: string });
        }
    };

    try {
        const browser = page.context().browser();

        if (!browser) {
            throw new Error("The browser of this page cannot be locked for a saved login");
        }

        await page.context().route("**/*", onRoute);
        isRouted = true;

        const frames = await page.context().newCDPSession(page);

        sessions.push(frames);

        const framesPost = postTo(frames);

        frames.on("Target.attachedToTarget", (event) => onChild(framesPost, event as Attached, false));
        frames.on("Target.receivedMessageFromTarget", (event) => onMessage(framesPost, event));
        await frames.send("Target.setAutoAttach", { autoAttach: true, flatten: false, waitForDebuggerOnStart: true });

        const tab = await page.context().newCDPSession(page);

        sessions.push(tab);

        const { targetInfo: own } = (await tab.send("Target.getTargetInfo")) as { targetInfo: TargetInfo };

        tab.on("Target.attachedToTarget", ({ targetInfo, waitingForDebugger }) => {
            if (waitingForDebugger) {
                refuse(targetInfo.type);
            }
        });
        await tab.send("Page.enable");
        await tab.send("Page.addScriptToEvaluateOnNewDocument", { runImmediately: true, source: PAGE_LOCK });
        await tab.send("Network.enable");
        await tab.send("Network.setBypassServiceWorker", { bypass: true });
        // Cross-site frames are the non-flat session's: one this session paused, it could not let run again.
        await tab.send("Target.setAutoAttach", {
            autoAttach: true,
            filter: [{ exclude: true, type: "iframe" }, {}],
            flatten: true,
            waitForDebuggerOnStart: true,
        });

        const top = await browser.newBrowserCDPSession();

        sessions.push(top);

        const topPost = postTo(top);

        top.on("Target.attachedToTarget", (event) => {
            const { sessionId, targetInfo, waitingForDebugger } = event as Attached;

            if (targetInfo.browserContextId === own.browserContextId && targetInfo.targetId !== own.targetId && CLOSED_TYPES.has(targetInfo.type)) {
                if (waitingForDebugger) {
                    refuse(targetInfo.type);
                }

                topPost("Target.closeTarget", { targetId: targetInfo.targetId });

                return;
            }

            // Not this tab's to stop: letting go of it lets it run.
            topPost("Target.detachFromTarget", { sessionId });
        });
        // The browser's own session takes flat sessions only; it never talks to one, it closes the target or detaches.
        await top.send("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: true });
    } catch (error) {
        await release();

        throw error;
    }

    return {
        onRefused: (next) => {
            listener = next;
        },
        refused: () => first,
        release,
        route: (handler) => {
            decide = handler;
        },
    };
};
