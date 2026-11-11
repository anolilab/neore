import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

const ELECTRON_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Neore/1.0.0 Chrome/140.0.0.0 Electron/45.0.0 Safari/537.36";
const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SHELL = { revision: "rev2", url: "/offline-shell" };

interface FakeEvent {
    request?: { mode: string; url: string };
    respondWith?: (response: Promise<Response>) => void;
    stopImmediatePropagation?: () => void;
    waitUntil?: (promise: Promise<unknown>) => void;
}

type Listener = (event: FakeEvent) => void;

/** A Cache Storage with `match`, `open`, `keys` and `delete`, keyed by name then URL. */
const fakeCaches = (initial: Record<string, Record<string, Response>> = {}) => {
    const stores = new Map(Object.entries(initial).map(([name, entries]) => [name, new Map(Object.entries(entries))]));

    const open = async (name: string) => {
        if (!stores.has(name)) {
            stores.set(name, new Map());
        }

        const store = stores.get(name) as Map<string, Response>;

        return {
            match: async (url: string) => store.get(url),
            put: async (url: string, response: Response) => {
                store.set(url, response);
            },
        };
    };

    return {
        delete: vi.fn(async (name: string) => stores.delete(name)),
        keys: async () => [...stores.keys()],
        match: async (url: string, options?: { ignoreSearch?: boolean }) => {
            for (const store of stores.values()) {
                for (const [key, response] of store) {
                    if (key === url || (options?.ignoreSearch === true && key.split("?")[0] === url)) {
                        return response;
                    }
                }
            }

            return undefined;
        },
        open,
        stores,
    };
};

const load = (scope: Record<string, unknown>): Map<string, Listener> => {
    const listeners = new Map<string, Listener>();
    const self = {
        __NEORE_OFFLINE_SHELL__: SHELL,
        navigator: { userAgent: ELECTRON_UA },
        ...scope,
        addEventListener: (type: string, listener: Listener) => {
            listeners.set(type, listener);
        },
    };

    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func -- evaluating the shipped worker file as-is
    new Function("self", readFileSync(resolve(import.meta.dirname, "../public/offline-shell-sw.js"), "utf8"))(self);

    return listeners;
};

const html = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", ...headers }, status: 200 });

const install = async (listeners: Map<string, Listener>) => {
    const waited: Promise<unknown>[] = [];

    listeners.get("install")?.({ waitUntil: (promise) => waited.push(promise) });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
};

const navigate = (listeners: Map<string, Listener>, mode = "navigate") => {
    let answer: Promise<Response> | undefined;
    const stopImmediatePropagation = vi.fn();

    listeners.get("fetch")?.({
        request: { mode, url: "https://app.example/chat/abc" },
        respondWith: (response) => {
            answer = response;
        },
        stopImmediatePropagation,
    });

    return { answer, stopImmediatePropagation };
};

describe("offline-shell-sw.js", () => {
    it("does nothing without the config generate-sw.mjs writes into sw.js", () => {
        expect(load({ __NEORE_OFFLINE_SHELL__: undefined }).size).toBe(0);
    });

    it("keeps the shell on install, fetched without credentials, in the revision's cache", async () => {
        const caches = fakeCaches();
        const fetch = vi.fn(async () => html("<html>shell</html>", { "Content-Security-Policy": "script-src 'nonce-n1'" }));

        await install(load({ caches, fetch }));

        expect(fetch).toHaveBeenCalledWith("/offline-shell", { cache: "no-store", credentials: "omit", redirect: "error" });

        const kept = caches.stores.get("neore-offline-shell-rev2")?.get("/offline-shell");

        expect(await kept?.text()).toBe("<html>shell</html>");
        // The nonce in the header is the one the HTML was rendered with: they travel together.
        expect(kept?.headers.get("Content-Security-Policy")).toBe("script-src 'nonce-n1'");
    });

    it.each([
        ["a server error", async () => new Response("down", { headers: { "Content-Type": "text/html" }, status: 503 })],
        ["a non-HTML answer", async () => new Response("{}", { headers: { "Content-Type": "application/json" }, status: 200 })],
        [
            "a network failure",
            async () => {
                throw new TypeError("Failed to fetch");
            },
        ],
    ])("never fails the install on %s, and keeps nothing", async (_label, fetch) => {
        const caches = fakeCaches();

        await install(load({ caches, fetch: vi.fn(fetch) }));

        expect(caches.stores.get("neore-offline-shell-rev2")?.size ?? 0).toBe(0);
    });

    it("deletes older shells on activate and leaves other caches alone", async () => {
        const caches = fakeCaches({ "bundle-assets": {}, "neore-offline-shell-rev1": {}, "neore-offline-shell-rev2": {} });
        const waited: Promise<unknown>[] = [];

        load({ caches, fetch: vi.fn() }).get("activate")?.({ waitUntil: (promise) => waited.push(promise) });
        await Promise.all(waited);

        expect([...caches.stores.keys()].toSorted()).toStrictEqual(["bundle-assets", "neore-offline-shell-rev2"]);
    });

    it("answers a desktop navigation from the network while it is up, even with a server error", async () => {
        const caches = fakeCaches({ "neore-offline-shell-rev2": { "/offline-shell": html("shell") } });
        const listeners = load({ caches, fetch: vi.fn(async () => new Response("bad gateway", { status: 502 })) });
        const { answer, stopImmediatePropagation } = navigate(listeners);

        expect(stopImmediatePropagation).toHaveBeenCalledOnce();
        expect((await answer)?.status).toBe(502);
    });

    it("answers a desktop navigation the network failed with the cached shell", async () => {
        const caches = fakeCaches({ "neore-offline-shell-rev2": { "/offline-shell": html("shell") } });
        const listeners = load({
            caches,
            fetch: vi.fn(async () => {
                throw new TypeError("Failed to fetch");
            }),
        });

        expect(await (await navigate(listeners).answer)?.text()).toBe("shell");
    });

    it("falls back to the precached offline page, then to the network error, when no shell is kept", async () => {
        const failing = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        });
        const withOfflinePage = fakeCaches({ "workbox-precache-v2": { "/offline.html?__WB_REVISION__=abc": html("offline") } });

        expect(await (await navigate(load({ caches: withOfflinePage, fetch: failing })).answer)?.text()).toBe("offline");
        await expect(navigate(load({ caches: fakeCaches(), fetch: failing })).answer).rejects.toThrow("Failed to fetch");
    });

    it("leaves browsers and non-navigation requests to Workbox", () => {
        const fetch = vi.fn();
        const browser = navigate(load({ caches: fakeCaches(), fetch, navigator: { userAgent: CHROME_UA } }));
        const asset = navigate(load({ caches: fakeCaches(), fetch }), "cors");

        for (const { answer, stopImmediatePropagation } of [browser, asset]) {
            expect(answer).toBeUndefined();
            expect(stopImmediatePropagation).not.toHaveBeenCalled();
        }

        expect(fetch).not.toHaveBeenCalled();
    });

    it("is imported by the generated service worker after the config that names its revision", () => {
        const script = readFileSync(resolve(import.meta.dirname, "generate-sw.mjs"), "utf8");

        expect(script).toMatch(/importScripts: \[[^\]]*"offline-shell-sw\.js"/u);
        expect(script).toContain("self.__NEORE_OFFLINE_SHELL__ = ");
    });
});
