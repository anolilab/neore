import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const ELECTRON_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Neore/1.0.0 Chrome/140.0.0.0 Electron/45.0.0 Safari/537.36";
const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const ENTRY = "assets/index-Ab12Cd34.js";
const SHELL = { entry: ENTRY, revision: "rev2", url: "/offline-shell" };
const SHELL_HTML = `<html><script type="module" src="/${ENTRY}"></script></html>`;

interface FakeEvent {
    request?: { destination: string; mode: string; url: string };
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

const navigate = (listeners: Map<string, Listener>, { destination = "document", mode = "navigate" } = {}) => {
    let answer: Promise<Response> | undefined;
    const stopImmediatePropagation = vi.fn();
    const waited: Promise<unknown>[] = [];

    listeners.get("fetch")?.({
        request: { destination, mode, url: "https://app.example/chat/abc" },
        respondWith: (response) => {
            answer = response;
        },
        stopImmediatePropagation,
        waitUntil: (promise) => waited.push(promise),
    });

    return { answer, settled: Promise.all(waited), stopImmediatePropagation };
};

const offline = () =>
    vi.fn(async () => {
        throw new TypeError("Failed to fetch");
    });

describe("offline-shell-sw.js", () => {
    it("does nothing without the config generate-sw.mjs writes into sw.js", () => {
        expect(load({ __NEORE_OFFLINE_SHELL__: undefined }).size).toBe(0);
    });

    it("keeps the shell on install, fetched without credentials, in the revision's cache", async () => {
        const caches = fakeCaches();
        const fetch = vi.fn(async () => html(SHELL_HTML, { "Content-Security-Policy": "script-src 'nonce-n1'" }));

        await install(load({ caches, fetch }));

        expect(fetch).toHaveBeenCalledWith("/offline-shell", {
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: expect.any(AbortSignal),
        });

        const kept = caches.stores.get("neore-offline-shell-rev2")?.get("/offline-shell");

        expect(await kept?.text()).toBe(SHELL_HTML);
        // The nonce in the header is the one the HTML was rendered with: they travel together.
        expect(kept?.headers.get("Content-Security-Policy")).toBe("script-src 'nonce-n1'");
    });

    it.each([
        ["a server error", async () => new Response("down", { headers: { "Content-Type": "text/html" }, status: 503 })],
        ["a non-HTML answer", async () => new Response("{}", { headers: { "Content-Type": "application/json" }, status: 200 })],
        // A gradual deploy can route the request to the other version, whose HTML names other assets.
        ["HTML from another build", async () => html('<html><script type="module" src="/assets/index-Zz99Yy88.js"></script></html>')],
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

    it("gives up on a shell fetch that never answers after 10 seconds, so the install is not held open", async () => {
        const caches = fakeCaches();
        const timeout = new AbortController();
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
        // Like the real fetch: pending until its signal aborts.
        const fetch = vi.fn(
            async (_url: string, init: { signal: AbortSignal }) =>
                await new Promise<Response>((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(init.signal.reason));
                }),
        );
        const installed = install(load({ caches, fetch }));

        expect(timeoutSpy).toHaveBeenCalledWith(10_000);

        timeout.abort(new DOMException("signal timed out", "TimeoutError"));
        await installed;

        expect(caches.stores.get("neore-offline-shell-rev2")?.size ?? 0).toBe(0);
    });

    it("keeps nothing on install in a browser, which never uses the shell", () => {
        const fetch = vi.fn();
        const waited: Promise<unknown>[] = [];

        load({ caches: fakeCaches(), fetch, navigator: { userAgent: CHROME_UA } }).get("install")?.({ waitUntil: (promise) => waited.push(promise) });

        expect(waited).toHaveLength(0);
        expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps the shell after a desktop navigation succeeds when the install could not", async () => {
        const caches = fakeCaches();
        const fetch = vi.fn(async (input: string | { url: string }) => (typeof input === "string" ? html(SHELL_HTML) : new Response("page", { status: 200 })));
        const { answer, settled } = navigate(load({ caches, fetch }));

        expect(await (await answer)?.text()).toBe("page");
        await settled;

        expect(await caches.stores.get("neore-offline-shell-rev2")?.get("/offline-shell")?.text()).toBe(SHELL_HTML);
    });

    it("does not fetch the shell again after a navigation when it is kept, nor while offline", async () => {
        const kept = fakeCaches({ "neore-offline-shell-rev2": { "/offline-shell": html("shell") } });
        const online = vi.fn(async () => new Response("page", { status: 200 }));

        await navigate(load({ caches: kept, fetch: online })).settled;
        expect(online).toHaveBeenCalledOnce();

        const failing = offline();
        const { answer, settled } = navigate(load({ caches: fakeCaches(), fetch: failing }));

        await expect(answer).rejects.toThrow("Failed to fetch");
        await settled;
        expect(failing).toHaveBeenCalledOnce();
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
        const listeners = load({ caches, fetch: offline() });

        expect(await (await navigate(listeners).answer)?.text()).toBe("shell");
    });

    it("falls back to the precached offline page, then to the network error, when no shell is kept", async () => {
        const failing = offline();
        const withOfflinePage = fakeCaches({ "workbox-precache-v2": { "/offline.html?__WB_REVISION__=abc": html("offline") } });

        expect(await (await navigate(load({ caches: withOfflinePage, fetch: failing })).answer)?.text()).toBe("offline");
        await expect(navigate(load({ caches: fakeCaches(), fetch: failing })).answer).rejects.toThrow("Failed to fetch");
    });

    it("leaves browsers, iframe navigations and non-navigation requests to Workbox", () => {
        const fetch = vi.fn();
        const browser = navigate(load({ caches: fakeCaches(), fetch, navigator: { userAgent: CHROME_UA } }));
        // `/artifact-preview` and the canvas code preview load in iframes.
        const iframe = navigate(load({ caches: fakeCaches(), fetch }), { destination: "iframe" });
        const asset = navigate(load({ caches: fakeCaches(), fetch }), { destination: "script", mode: "cors" });

        for (const { answer, stopImmediatePropagation } of [browser, iframe, asset]) {
            expect(answer).toBeUndefined();
            expect(stopImmediatePropagation).not.toHaveBeenCalled();
        }

        expect(fetch).not.toHaveBeenCalled();
    });
});

describe("generate-sw.mjs", () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { force: true, recursive: true });
        }
    });

    /** Runs the generator on a minimal client build whose entry chunk is `entryFile`, and returns sw.js. */
    const generate = (entryFile: string): string => {
        const dir = mkdtempSync(join(tmpdir(), "neore-generate-sw-"));

        dirs.push(dir);
        mkdirSync(join(dir, ".vite"));
        mkdirSync(join(dir, "assets"));
        writeFileSync(join(dir, ".vite", "manifest.json"), JSON.stringify({ "client.tsx": { file: entryFile, isEntry: true } }));
        writeFileSync(join(dir, entryFile), "export {};");
        writeFileSync(join(dir, "offline.html"), "<html>offline</html>");
        execFileSync(process.execPath, [resolve(import.meta.dirname, "generate-sw.mjs"), dir], { stdio: "pipe" });

        return readFileSync(join(dir, "sw.js"), "utf8");
    };

    const config = (sw: string) => JSON.parse(/^self\.__NEORE_OFFLINE_SHELL__ = (.+);$/mu.exec(sw)?.[1] ?? "null") as typeof SHELL | null;

    it("writes the config, with this build's entry chunk, before the worker imports offline-shell-sw.js", () => {
        const sw = generate(ENTRY);

        expect(config(sw)).toStrictEqual({ entry: ENTRY, revision: expect.stringMatching(/^[\da-f]{16}$/u), url: "/offline-shell" });
        expect(sw.indexOf("self.__NEORE_OFFLINE_SHELL__ = ")).toBe(0);
        expect(sw.indexOf("define(")).toBeGreaterThan(0);
        expect(sw).toMatch(/importScripts\([^)]*"offline-shell-sw\.js"/u);
    });

    it("changes the revision with the client manifest", () => {
        const first = config(generate(ENTRY));
        const second = config(generate("assets/index-Ef56Gh78.js"));

        expect(second?.revision).not.toBe(first?.revision);
        expect(second?.entry).toBe("assets/index-Ef56Gh78.js");
    }, 30_000);
});
