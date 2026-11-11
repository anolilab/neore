import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OFFLINE_SHELL_PATH } from "../src/lib/offline-shell";

const ELECTRON_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Neore/1.0.0 Chrome/140.0.0.0 Electron/45.0.0 Safari/537.36";
const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const ENTRY = "assets/index-Ab12Cd34.js";
const CATALOG = "/assets/messages-Ab12Cd34.js";
const SHELL = { catalog: CATALOG, entry: ENTRY, revision: "rev2", url: "/offline-shell" };
const ORIGIN = "https://app.example";
const SHELL_HTML = `<html><script nonce="n1">self.__boot = 1;</script><script type="module" src="/${ENTRY}"></script></html>`;

interface FakeEvent {
    request?: { destination: string; method: string; mode: string; url: string };
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
        location: { origin: ORIGIN },
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

/** A shell as the worker keeps it: stamped with when it was kept. */
const keptShell = (body: string, { keptAt = Date.now() } = {}) => html(body, { "X-Neore-Shell-Kept-At": String(keptAt) });

const activate = async (listeners: Map<string, Listener>) => {
    const waited: Promise<unknown>[] = [];

    listeners.get("activate")?.({ waitUntil: (promise) => waited.push(promise) });
    await Promise.all(waited);
};

const install = async (listeners: Map<string, Listener>) => {
    const waited: Promise<unknown>[] = [];

    listeners.get("install")?.({ waitUntil: (promise) => waited.push(promise) });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
};

const navigate = (listeners: Map<string, Listener>, { destination = "document", method = "GET", mode = "navigate", url = `${ORIGIN}/chat/abc` } = {}) => {
    let answer: Promise<Response> | undefined;
    const stopImmediatePropagation = vi.fn();
    const waited: Promise<unknown>[] = [];

    listeners.get("fetch")?.({
        request: { destination, method, mode, url },
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
    afterEach(() => {
        vi.restoreAllMocks();
    });

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

        const keptHtml = await kept?.text();

        expect(keptHtml).toBe(SHELL_HTML);
        // The nonce in the header is the one the HTML was rendered with: they travel together.
        const headerNonce = /'nonce-([^']+)'/u.exec(kept?.headers.get("Content-Security-Policy") ?? "")?.[1];
        const htmlNonces = [...(keptHtml ?? "").matchAll(/\snonce="([^"]+)"/gu)].map((match) => match[1]);

        expect(headerNonce).toBe("n1");
        expect(htmlNonces).toStrictEqual([headerNonce]);
        expect(kept?.headers.get("X-Neore-Shell-Kept-At")).toMatch(/^\d+$/u);
    });

    // The installing worker can still fail, and a stale worker's late refresh must not delete a newer worker's shell.
    it("never deletes another cache when it keeps the shell, on install or after a navigation", async () => {
        const others = {
            "bundle-assets": {},
            "neore-offline-shell-rev1": { "/offline-shell": keptShell("old") },
            "neore-offline-shell-rev3": { "/offline-shell": keptShell("new") },
        };
        const installed = fakeCaches(others);
        const navigated = fakeCaches(others);
        const fetch = vi.fn(async (input: string | { url: string }) => (typeof input === "string" ? html(SHELL_HTML) : new Response("page", { status: 200 })));

        await install(load({ caches: installed, fetch }));
        await navigate(load({ caches: navigated, fetch })).settled;

        for (const caches of [installed, navigated]) {
            expect(caches.delete).not.toHaveBeenCalled();
            expect(await caches.stores.get("neore-offline-shell-rev2")?.get("/offline-shell")?.text()).toBe(SHELL_HTML);
            expect([...caches.stores.keys()].toSorted()).toStrictEqual([
                "bundle-assets",
                "neore-offline-shell-rev1",
                "neore-offline-shell-rev2",
                "neore-offline-shell-rev3",
            ]);
        }
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
    ])("never fails the install on %s and keeps no shell", async (_label, fetch) => {
        const caches = fakeCaches();

        await install(load({ caches, fetch: vi.fn(fetch) }));

        expect(caches.stores.get("neore-offline-shell-rev2")?.has("/offline-shell")).not.toBe(true);
    });

    it("gives up on a shell fetch that never answers after 10 seconds, so the install is not held open", async () => {
        const caches = fakeCaches();
        const timeout = new AbortController();
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
        // Like the real fetch: pending until its signal aborts.
        const fetch = vi.fn(
            async (_url: string, init: { signal: AbortSignal }) =>
                await new Promise<Response>((_resolve, reject) => {
                    if (init.signal.aborted) {
                        reject(init.signal.reason);
                    }

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

    it("does not fetch a recently kept shell again after a navigation, nor while offline", async () => {
        const kept = fakeCaches({
            "neore-offline-shell-rev2": { "/offline-shell": keptShell("shell"), [CATALOG]: new Response("catalog") },
        });
        const online = vi.fn(async () => new Response("page", { status: 200 }));

        await navigate(load({ caches: kept, fetch: online })).settled;
        expect(online).toHaveBeenCalledOnce();

        const failing = offline();
        const { answer, settled } = navigate(load({ caches: fakeCaches(), fetch: failing }));

        await expect(answer).rejects.toThrow("Failed to fetch");
        await settled;
        expect(failing).toHaveBeenCalledOnce();
    });

    it("revalidates a shell kept over 30 minutes ago after a navigation, so a server-only deploy reaches it", async () => {
        const stale = keptShell("old shell", { keptAt: Date.now() - 31 * 60 * 1000 });
        const caches = fakeCaches({ "neore-offline-shell-rev2": { "/offline-shell": stale, [CATALOG]: new Response("catalog") } });
        const fetch = vi.fn(async (input: string | { url: string }) => (typeof input === "string" ? html(SHELL_HTML) : new Response("page", { status: 200 })));

        await navigate(load({ caches, fetch })).settled;

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(await caches.stores.get("neore-offline-shell-rev2")?.get("/offline-shell")?.text()).toBe(SHELL_HTML);
    });

    it("keeps the stale shell when the revalidation answers with another build's HTML", async () => {
        const caches = fakeCaches({ "neore-offline-shell-rev2": { "/offline-shell": keptShell("old shell", { keptAt: 0 }) } });
        const fetch = vi.fn(async (input: string | { url: string }) =>
            typeof input === "string" ? html('<script src="/assets/index-Zz99Yy88.js"></script>') : new Response("page", { status: 200 }),
        );

        await navigate(load({ caches, fetch })).settled;

        expect(await caches.stores.get("neore-offline-shell-rev2")?.get("/offline-shell")?.text()).toBe("old shell");
    });

    it("deletes every other revision's shell on activate, and leaves other caches alone", async () => {
        const others = {
            "bundle-assets": {},
            "neore-offline-shell-rev1": { "/offline-shell": keptShell("old") },
            "neore-offline-shell-rev3": { "/offline-shell": keptShell("stale write") },
        };
        const withCurrent = fakeCaches({ ...others, "neore-offline-shell-rev2": { "/offline-shell": keptShell("shell") } });
        // An older shell is no fallback: Workbox drops the old build's precached chunks on this activate.
        const withoutCurrent = fakeCaches(others);

        await activate(load({ caches: withCurrent, fetch: vi.fn() }));
        await activate(load({ caches: withoutCurrent, fetch: vi.fn() }));

        expect([...withCurrent.stores.keys()].toSorted()).toStrictEqual(["bundle-assets", "neore-offline-shell-rev2"]);
        expect([...withoutCurrent.stores.keys()]).toStrictEqual(["bundle-assets"]);
    });

    it("never fails the activation when listing or deleting caches fails, and leaves the undeletable ones for the next one", async () => {
        const unlisted = fakeCaches({ "neore-offline-shell-rev1": { "/offline-shell": keptShell("old") } });

        unlisted.keys = vi.fn(async () => {
            throw new DOMException("broken", "UnknownError");
        });

        await expect(activate(load({ caches: unlisted, fetch: vi.fn() }))).resolves.toBeUndefined();

        const undeletable = fakeCaches({
            "neore-offline-shell-rev1": { "/offline-shell": keptShell("old") },
            "neore-offline-shell-rev3": { "/offline-shell": keptShell("stale write") },
        });
        const remove = undeletable.delete;

        undeletable.delete = vi.fn(async (name: string) => {
            if (name === "neore-offline-shell-rev1") {
                throw new DOMException("broken", "UnknownError");
            }

            return await remove(name);
        });

        await expect(activate(load({ caches: undeletable, fetch: vi.fn() }))).resolves.toBeUndefined();
        expect([...undeletable.stores.keys()]).toStrictEqual(["neore-offline-shell-rev1"]);
    });

    it("answers a desktop navigation from the network while it is up, even with a server error", async () => {
        const caches = fakeCaches({ "neore-offline-shell-rev2": { "/offline-shell": html("shell") } });
        const listeners = load({ caches, fetch: vi.fn(async () => new Response("bad gateway", { status: 502 })) });
        const { answer, stopImmediatePropagation } = navigate(listeners);

        expect(stopImmediatePropagation).toHaveBeenCalledOnce();
        expect((await answer)?.status).toBe(502);
    });

    it("answers a desktop navigation the network failed with the cached shell", async () => {
        const caches = fakeCaches({
            "neore-offline-shell-rev1": { "/offline-shell": keptShell("old") },
            "neore-offline-shell-rev2": { "/offline-shell": html("shell") },
        });
        const listeners = load({ caches, fetch: offline() });

        expect(await (await navigate(listeners).answer)?.text()).toBe("shell");
    });

    it("answers the offline page, never another revision's shell, when this revision's shell is missing", async () => {
        const caches = fakeCaches({
            "neore-offline-shell-rev1": { "/offline-shell": keptShell("old") },
            "workbox-precache-v2": { "/offline.html?__WB_REVISION__=abc": html("offline") },
        });

        expect(await (await navigate(load({ caches, fetch: offline() })).answer)?.text()).toBe("offline");
    });

    it("falls back to the precached offline page, then to the network error, when no shell is kept", async () => {
        const failing = offline();
        const withOfflinePage = fakeCaches({ "workbox-precache-v2": { "/offline.html?__WB_REVISION__=abc": html("offline") } });

        expect(await (await navigate(load({ caches: withOfflinePage, fetch: failing })).answer)?.text()).toBe("offline");
        await expect(navigate(load({ caches: fakeCaches(), fetch: failing })).answer).rejects.toThrow("Failed to fetch");
    });

    it("answers the offline page when reading the kept shell fails, and the network error when that fails too", async () => {
        const failing = offline();
        const broken = fakeCaches({ "workbox-precache-v2": { "/offline.html?__WB_REVISION__=abc": html("offline") } });

        broken.open = vi.fn(async () => {
            throw new DOMException("quota", "QuotaExceededError");
        });

        expect(await (await navigate(load({ caches: broken, fetch: failing })).answer)?.text()).toBe("offline");

        broken.match = vi.fn(async () => {
            throw new DOMException("broken", "UnknownError");
        });

        await expect(navigate(load({ caches: broken, fetch: failing })).answer).rejects.toThrow("Failed to fetch");
    });

    // Workbox's expiration never tracks a `cache.put` into `bundle-assets`: every deploy's catalog would stay there.
    it("keeps the default catalog in the revision's cache on install, and again after a navigation once it is gone", async () => {
        const caches = fakeCaches();
        const fetch = vi.fn(async (input: string | { url: string }) => (input === CATALOG ? new Response("catalog") : html(SHELL_HTML)));

        await install(load({ caches, fetch }));
        expect(fetch).toHaveBeenCalledWith(CATALOG, { signal: expect.any(AbortSignal) });
        expect(await caches.stores.get("neore-offline-shell-rev2")?.get(CATALOG)?.text()).toBe("catalog");
        expect(caches.stores.has("bundle-assets")).toBe(false);

        caches.stores.get("neore-offline-shell-rev2")?.delete(CATALOG);
        await navigate(load({ caches, fetch })).settled;
        expect(caches.stores.get("neore-offline-shell-rev2")?.has(CATALOG)).toBe(true);
    });

    it("does not fetch a kept catalog again, and keeps none without one in the config", async () => {
        const kept = fakeCaches({ "neore-offline-shell-rev2": { [CATALOG]: new Response("catalog") } });
        const fetch = vi.fn(async () => html(SHELL_HTML));
        const none = fakeCaches();

        await install(load({ caches: kept, fetch }));
        await install(load({ __NEORE_OFFLINE_SHELL__: { ...SHELL, catalog: undefined }, caches: none, fetch }));

        expect(fetch).not.toHaveBeenCalledWith(CATALOG, expect.anything());
        expect(none.stores.get("neore-offline-shell-rev2")?.has(CATALOG)).toBe(false);
    });

    it("drops another revision's kept catalog with its shell on activate", async () => {
        const caches = fakeCaches({
            "neore-offline-shell-rev1": { "/assets/messages-Old11111.js": new Response("old catalog"), "/offline-shell": keptShell("old") },
            "neore-offline-shell-rev2": { "/offline-shell": keptShell("shell"), [CATALOG]: new Response("catalog") },
        });

        await activate(load({ caches, fetch: vi.fn() }));

        expect([...caches.stores.keys()]).toStrictEqual(["neore-offline-shell-rev2"]);
        expect(caches.stores.get("neore-offline-shell-rev2")?.has(CATALOG)).toBe(true);
    });

    it("answers a desktop request for the catalog from the kept copy, or the one a window loaded, offline too", async () => {
        const fetch = offline();

        for (const name of ["neore-offline-shell-rev2", "bundle-assets"]) {
            const caches = fakeCaches({ [name]: { [CATALOG]: new Response(name) } });
            const { answer, stopImmediatePropagation } = navigate(load({ caches, fetch }), { destination: "script", mode: "cors", url: ORIGIN + CATALOG });

            expect(stopImmediatePropagation).toHaveBeenCalledOnce();
            expect(await (await answer)?.text()).toBe(name);
        }

        expect(fetch).not.toHaveBeenCalled();
    });

    it("answers a desktop request for a catalog that is not kept from the network", async () => {
        const fetch = vi.fn(async () => new Response("from the network"));
        const broken = fakeCaches();

        broken.match = vi.fn(async () => {
            throw new DOMException("broken", "UnknownError");
        });

        for (const caches of [fakeCaches(), broken]) {
            const { answer } = navigate(load({ caches, fetch }), { destination: "script", mode: "cors", url: ORIGIN + CATALOG });

            expect(await (await answer)?.text()).toBe("from the network");
        }
    });

    it("keeps no catalog the server did not answer with", async () => {
        const caches = fakeCaches();

        await install(load({ caches, fetch: vi.fn(async (input: string) => (input === CATALOG ? new Response("gone", { status: 404 }) : html(SHELL_HTML))) }));

        expect(caches.stores.get("neore-offline-shell-rev2")?.has(CATALOG)).toBe(false);
    });

    it("gives up on a catalog fetch that never answers after 10 seconds, so the install is not held open", async () => {
        const caches = fakeCaches();
        const timeout = new AbortController();
        const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
        // The shell answers; the catalog stays pending until its signal aborts, like the real fetch.
        const fetch = vi.fn(async (input: string, init?: { signal?: AbortSignal }) => {
            if (input !== CATALOG) {
                return html(SHELL_HTML);
            }

            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            });
        });
        let settled = false;
        const installed = install(load({ caches, fetch })).then(() => {
            settled = true;
        });

        await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(CATALOG, { signal: timeout.signal }));
        expect(timeoutSpy).toHaveBeenCalledWith(10_000);
        expect(settled).toBe(false);

        timeout.abort(new DOMException("signal timed out", "TimeoutError"));
        await installed;

        expect(caches.stores.get("neore-offline-shell-rev2")?.has(CATALOG)).toBe(false);
        expect(await caches.stores.get("neore-offline-shell-rev2")?.get("/offline-shell")?.text()).toBe(SHELL_HTML);
    });

    it("leaves browsers, iframe navigations, form POSTs and other requests than the catalog to Workbox", () => {
        const fetch = vi.fn();
        const browser = navigate(load({ caches: fakeCaches(), fetch, navigator: { userAgent: CHROME_UA } }));
        // `/artifact-preview` and the canvas code preview load in iframes.
        const iframe = navigate(load({ caches: fakeCaches(), fetch }), { destination: "iframe" });
        const asset = navigate(load({ caches: fakeCaches(), fetch }), { destination: "script", mode: "cors" });
        // Replaying a form POST from the worker would need its body; a failed one is the browser's error page.
        const post = navigate(load({ caches: fakeCaches(), fetch }), { method: "POST" });
        // Only this build's default catalog is answered here: other locales' chunks, an older catalog, the same path on another origin, or in a browser.
        const otherCatalog = navigate(load({ caches: fakeCaches(), fetch }), {
            destination: "script",
            mode: "cors",
            url: `${ORIGIN}/assets/messages-Zz99Yy88.js`,
        });
        const otherOrigin = navigate(load({ caches: fakeCaches(), fetch }), { destination: "script", mode: "cors", url: `https://cdn.example${CATALOG}` });
        const browserCatalog = navigate(load({ caches: fakeCaches(), fetch, navigator: { userAgent: CHROME_UA } }), {
            destination: "script",
            mode: "cors",
            url: ORIGIN + CATALOG,
        });

        for (const { answer, stopImmediatePropagation } of [browser, iframe, asset, post, otherCatalog, otherOrigin, browserCatalog]) {
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
        writeFileSync(
            join(dir, ".vite", "manifest.json"),
            JSON.stringify({
                "client.tsx": { file: entryFile, isEntry: true },
                "src/locales/en/messages.po": { file: "assets/messages-Ab12Cd34.js", isDynamicEntry: true },
            }),
        );
        writeFileSync(join(dir, "assets", "messages-Ab12Cd34.js"), "export const messages = {};");
        writeFileSync(join(dir, entryFile), "export {};");
        writeFileSync(join(dir, "offline.html"), "<html>offline</html>");
        execFileSync(process.execPath, [resolve(import.meta.dirname, "generate-sw.mjs"), dir], { stdio: "pipe" });

        return readFileSync(join(dir, "sw.js"), "utf8");
    };

    const config = (sw: string) => JSON.parse(/^self\.__NEORE_OFFLINE_SHELL__ = (.+);$/mu.exec(sw)?.[1] ?? "null") as typeof SHELL | null;

    it("writes the config, with this build's entry chunk and default catalog, before the worker imports offline-shell-sw.js", () => {
        const sw = generate(ENTRY);

        // The path the server renders for nobody (`src/lib/root-before-load.ts`) is the one the worker keeps.
        expect(config(sw)).toStrictEqual({ catalog: CATALOG, entry: ENTRY, revision: expect.stringMatching(/^[\da-f]{16}$/u), url: OFFLINE_SHELL_PATH });
        expect(sw.indexOf("self.__NEORE_OFFLINE_SHELL__ = ")).toBe(0);
        expect(sw.indexOf("define(")).toBeGreaterThan(0);
        expect(sw).toMatch(/importScripts\([^)]*"offline-shell-sw\.js"/u);
    });

    it("shifts sw.js.map down one line for the config line put in front of sw.js", () => {
        const sw = generate(ENTRY);
        const dir = dirs.at(-1) as string;
        const map = JSON.parse(readFileSync(join(dir, "sw.js.map"), "utf8")) as { mappings: string };

        expect(sw.split("\n")[0]).toMatch(/^self\.__NEORE_OFFLINE_SHELL__ = /u);
        // `;` separates generated lines: the config line maps to nothing, and Workbox's first line keeps its mappings.
        const [configLine, workboxFirstLine] = map.mappings.split(";");

        expect(configLine).toBe("");
        expect(workboxFirstLine).not.toBe("");
    }, 30_000);

    it("changes the revision with the client manifest", () => {
        const first = config(generate(ENTRY));
        const second = config(generate("assets/index-Ef56Gh78.js"));

        expect(second?.revision).not.toBe(first?.revision);
        expect(second?.entry).toBe("assets/index-Ef56Gh78.js");
    }, 30_000);
});
