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
 * script before the lock reaches it. Speculation rules, whose loads the browser sends itself, are taken out (below); so
 * that every rule set a script adds is one they reach, a parsed document cannot be written to again (`document.open`,
 * `write`, `writeln` throw once it is no longer loading) and a top-level `blob:` page is stopped before it parses.
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
    // A page the tab's own script made (a \`blob:\` address) holds whatever that script put in it: it is not loaded.
    if (window === top && location.protocol === "blob:") window.stop();
    // A parsed document written to again is parsed again, into declarative shadow roots no script reaches (below).
    const { open, write, writeln } = Document.prototype;
    const stateOf = Object.getOwnPropertyDescriptor(Document.prototype, "readyState").get;
    const viewOf = Object.getOwnPropertyDescriptor(Document.prototype, "defaultView").get;
    // The top document only: rules in a frame do nothing, and a script writes a new frame's blank document often.
    const parsing = (target, name) => apply(viewOf, target, []) !== top || apply(stateOf, target, []) === "loading" || refuse(name)();
    fix(Document.prototype, "open", function (...args) { return args.length > 2 ? null : parsing(this, "document.open") && apply(open, this, args); });
    fix(Document.prototype, "write", function () { return parsing(this, "document.write") && apply(write, this, arguments); });
    fix(Document.prototype, "writeln", function () { return parsing(this, "document.writeln") && apply(writeln, this, arguments); });
    // Every \`<script type="speculationrules">\` is taken out before the browser reads it (an observer's callback runs
    // first), in the document and in each shadow root a script makes or reaches. What runs later uses only what is
    // captured here, read by index: the page may have changed every prototype by then.
    const { defineProperty, getOwnPropertyDescriptor } = Object;
    const { observe } = MutationObserver.prototype;
    const { querySelectorAll: inDocument } = Document.prototype;
    const { querySelectorAll: inFragment } = DocumentFragment.prototype;
    const { attachShadow, remove } = Element.prototype;
    const { toLowerCase, trim } = String.prototype;
    const { add: keep, has: isKept } = WeakSet.prototype;
    const typeOf = getOwnPropertyDescriptor(HTMLScriptElement.prototype, "type").get;
    const sizeOf = getOwnPropertyDescriptor(NodeList.prototype, "length").get;
    const { item } = NodeList.prototype;
    const nameOf = getOwnPropertyDescriptor(Element.prototype, "localName").get;
    const [kindOf, targetOf, oldValueOf] = ["type", "target", "oldValue"].map((name) => getOwnPropertyDescriptor(MutationRecord.prototype, name).get);
    // The browser's own test: the type trimmed, matched case-insensitively. A data block such as
    // \`application/speculationrules+json\` is no rule set, and the page keeps it.
    const isRules = (type) => typeof type === "string" && apply(toLowerCase, apply(trim, type, []), []) === "speculationrules";
    // A rule set stays once read, whatever its script's type becomes: a script whose type was rules is taken out too.
    const watching = { attributeFilter: ["type"], attributeOldValue: true, characterData: true, childList: true, subtree: true };
    const root = document;
    const roots = [root];
    const kept = new WeakSet();
    const sweep = (records) => {
        for (let at = 0; at < records.length; at++) {
            const target = apply(targetOf, records[at], []);
            if (apply(kindOf, records[at], []) === "attributes" && apply(nameOf, target, []) === "script" && isRules(apply(oldValueOf, records[at], []))) apply(remove, target, []);
        }
        for (let at = 0; at < roots.length; at++) {
            const scripts = apply(roots[at] === root ? inDocument : inFragment, roots[at], ["script"]);
            for (let index = apply(sizeOf, scripts, []) - 1; index >= 0; index--) {
                const script = apply(item, scripts, [index]);
                if (isRules(apply(typeOf, script, []))) apply(remove, script, []);
            }
        }
    };
    const observer = new MutationObserver(sweep);
    const watch = (shadow) => {
        if (shadow && !apply(isKept, kept, [shadow])) {
            apply(keep, kept, [shadow]);
            defineProperty(roots, roots.length, { configurable: true, enumerable: true, value: shadow, writable: true });
            apply(observe, observer, [shadow, watching]);
        }
        return shadow;
    };
    apply(observe, observer, [root, watching]);
    // A shadow root of an element another window's document holds is that window's lock's to watch: this realm's
    // observer would stop with it (a removed frame) and leave the root to no one.
    const ownerOf = getOwnPropertyDescriptor(Node.prototype, "ownerDocument").get;
    const isElsewhere = (node) => {
        const view = apply(viewOf, apply(ownerOf, node, []), []);
        return view !== null && view !== window;
    };
    fix(Element.prototype, "attachShadow", function () { return isElsewhere(this) ? refuse("A shadow root for another window")() : watch(apply(attachShadow, this, arguments)); });
    for (const target of [Element.prototype, globalThis.ElementInternals?.prototype]) {
        const { get } = target ? getOwnPropertyDescriptor(target, "shadowRoot") : {};
        if (get) defineProperty(target, "shadowRoot", { configurable: false, enumerable: true, get() { const shadow = apply(get, this, []); return shadow && isElsewhere(shadow) ? null : watch(shadow); } });
    }
})();`;

/** What a target the lock stopped was, for a message. */
const KINDS = new Map([
    ["page", "a new window"],
    ["shared_worker", "a shared worker"],
    ["unlocked_frame", "a cross-site frame that could not be locked"],
    ["worker", "a worker"],
]);

/** How long a cross-site frame's lock commands may take to be confirmed: past it, the frame stays paused. */
const FRAME_LOCK_MS = 5000;

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

interface Header {
    name: string;
    value: string;
}

/** A document's response, paused once its headers are in. */
interface Paused {
    requestId: string;
    responseErrorReason?: string;
    responseHeaders?: Header[];
    responseStatusCode?: number;
}

const isSpeculationRules = ({ name }: Header): boolean => name.toLowerCase() === "speculation-rules";

/** Sends a command into one target, through the sessions between: fire and forget, in order. */
type Post = (method: string, params?: Record<string, boolean | string>) => void;

export interface ChannelLock {
    /** Told of each target stopped, and each speculative load the browser starts, from here on; `null` to stop telling. */
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

    /**
     * Whether the tab's document holds speculation rules the page lock could not take out (in a declarative shadow root
     * no script reached): the browser would prefetch what they match itself.
     */
    speculates: () => Promise<boolean>;

    /**
     * Whether a cross-site frame's lock was not confirmed: the frame is left paused, and the page must not be handed on,
     * since letting go of the lock lets the frame run.
     */
    unlocked: () => boolean;
}

/**
 * Locks the tab's channels that request interception does not see, until `release()`:
 *
 * - On the tab's own target and every cross-site frame under it (attached paused, then let run): the `PAGE_LOCK` script
 *   in each new document, and the tab's requests bypass its service worker.
 * - The tab's documents (the only ones whose speculation rules the browser acts on) arrive without a `Speculation-Rules`
 *   header, whose rule sets no script can take out. The rule sets the tab holds are tracked (`speculates()`), and each
 *   prefetch or prerender the browser starts for one is reported to `onRefused`: it is sent past request interception.
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
    let isUnlocked = false;
    /** The commands sent into a child session, by id, waiting for its answer: whether it was carried out. */
    const answers = new Map<number, (isDone: boolean) => void>();
    const sessions: CDPSession[] = [];
    let own: CDPSession | undefined;
    /** The speculation rule sets of the tab's documents, by id: the loader of the document each is in. */
    const ruleSets = new Map<string, string>();

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

    /** Sends into a child session; the command's id, by which `answers` hears how it went. */
    const into =
        (parent: Post, sessionId: string) =>
        (method: string, params: Record<string, boolean | string> = {}): number => {
            id += 1;
            parent("Target.sendMessageToTarget", { message: JSON.stringify({ id, method, params }), sessionId });

            return id;
        };

    /** Whether a cross-site frame took its lock (the lock script for each new document, its own frames held), within `FRAME_LOCK_MS`. */
    const lockDocuments = async (post: ReturnType<typeof into>): Promise<boolean> => {
        const confirmed = [
            post("Page.enable"),
            post("Page.addScriptToEvaluateOnNewDocument", { runImmediately: true, source: PAGE_LOCK }),
            post("Target.setAutoAttach", { autoAttach: true, flatten: false, waitForDebuggerOnStart: true }),
        ].map(
            async (sent) =>
                new Promise<boolean>((resolve) => {
                    const timer = setTimeout(() => {
                        answers.delete(sent);
                        resolve(false);
                    }, FRAME_LOCK_MS);

                    answers.set(sent, (isDone) => {
                        clearTimeout(timer);
                        answers.delete(sent);
                        resolve(isDone);
                    });
                }),
        );

        const answered = await Promise.all(confirmed);

        return answered.every(Boolean);
    };

    /**
     * A target a document of the tab started, seen by the non-flat session: a cross-site frame is locked and let run.
     * Anything else is the flat session's to hold on the tab itself; started in a cross-site frame, past its script,
     * it is reported.
     */
    const onChild = (parent: Post, { sessionId, targetInfo, waitingForDebugger }: Attached, isNested: boolean): void => {
        const post = into(parent, sessionId);

        if (targetInfo.type === "iframe") {
            // Let run only once every lock command is confirmed: one that failed leaves the frame paused, never unlocked.
            lockDocuments(post)
                .then((isLocked) => {
                    if (isLocked) {
                        post("Runtime.runIfWaitingForDebugger");
                    } else {
                        isUnlocked = true;
                        refuse("unlocked_frame");
                    }

                    return isLocked;
                })
                .catch(() => undefined);
        } else if (isNested && waitingForDebugger) {
            refuse(targetInfo.type);
        }
    };

    /** A message from a child session: its own children are attached and talked to through it. */
    const onMessage = (parent: Post, { message, sessionId }: { message: string; sessionId: string }): void => {
        let parsed: { error?: unknown; id?: unknown; method?: string; params?: unknown };

        try {
            parsed = JSON.parse(message) as typeof parsed;
        } catch {
            return;
        }

        if (typeof parsed.id === "number") {
            answers.get(parsed.id)?.(parsed.error === undefined);
        } else if (parsed.method === "Target.attachedToTarget") {
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
        own = tab;

        const { targetInfo: ownTarget } = (await tab.send("Target.getTargetInfo")) as { targetInfo: TargetInfo };

        tab.on("Target.attachedToTarget", ({ targetInfo, waitingForDebugger }) => {
            if (waitingForDebugger) {
                refuse(targetInfo.type);
            }
        });
        await tab.send("Page.enable");
        await tab.send("Page.addScriptToEvaluateOnNewDocument", { runImmediately: true, source: PAGE_LOCK });
        await tab.send("Network.enable");
        await tab.send("Network.setBypassServiceWorker", { bypass: true });
        tab.on("Fetch.requestPaused", (event) => {
            const { requestId, responseErrorReason, responseHeaders = [], responseStatusCode } = event as Paused;

            (responseErrorReason === undefined && responseStatusCode !== undefined && responseHeaders.some((header) => isSpeculationRules(header))
                ? tab.send("Fetch.continueResponse", {
                      requestId,
                      responseCode: responseStatusCode,
                      responseHeaders: responseHeaders.filter((header) => !isSpeculationRules(header)),
                  })
                : tab.send("Fetch.continueRequest", { requestId })
            ).catch(() => undefined);
        });
        await tab.send("Fetch.enable", { patterns: [{ requestStage: "Response", resourceType: "Document" }] });
        tab.on("Preload.ruleSetUpdated", ({ ruleSet }) => ruleSets.set(ruleSet.id, ruleSet.loaderId));
        tab.on("Preload.ruleSetRemoved", ({ id: removed }) => ruleSets.delete(removed));
        tab.on("Preload.prefetchStatusUpdated", () => listener?.("a speculative prefetch"));
        tab.on("Preload.prerenderStatusUpdated", () => listener?.("a speculative prerender"));
        await tab.send("Preload.enable");
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

            if (targetInfo.browserContextId === ownTarget.browserContextId && targetInfo.targetId !== ownTarget.targetId && CLOSED_TYPES.has(targetInfo.type)) {
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
        speculates: async () => {
            if (!own) {
                return true;
            }

            const { frameTree } = (await own.send("Page.getFrameTree")) as { frameTree: { frame: { loaderId: string } } };

            for (const loader of ruleSets.values()) {
                if (loader === frameTree.frame.loaderId) {
                    return true;
                }
            }

            return false;
        },
        unlocked: () => isUnlocked,
    };
};
