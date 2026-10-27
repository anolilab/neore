import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ElectronApplication, Page } from "@playwright/test";
import { _electron as electron, expect, test } from "@playwright/test";

/** What the page-side tests read from `(globalThis as PageGlobal).neoreNative` (the site preload's bridge). */
interface NeoreNativeForTests {
    capabilities?: string[];
    device?: { openSettings: () => Promise<void> };
    takePendingCompose: () => Promise<string | undefined>;
    takePendingSignIn: () => Promise<{ code: string; codeVerifier: string; redirectUri: string } | undefined>;
}

/** The page-side globals the preloads expose; read inside `evaluate`, so typed by cast. */
type PageGlobal = { neoreDevice?: unknown; neoreNative?: NeoreNativeForTests };

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
// The site origin is baked in at build time, so the fixture server must be up first.
// Overridable so two runs in one checkout do not collide (`NEORE_E2E_PORT=4500 pnpm test:e2e`).
const SITE_PORT = Number(process.env.NEORE_E2E_PORT ?? 4399);
const FOREIGN_PORT = SITE_PORT + 1;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FOREIGN = `http://127.0.0.1:${FOREIGN_PORT}`;
const COMPOSER_FILE = /^file:\/\/.*\/quick-composer\/index\.html$/u;

const htmlPage = (title: string) => `<!doctype html><title>${title}</title><body>${title}</body>`;

const serve = (port: number, origin: string) =>
    new Promise<http.Server>((resolve) => {
        const server = http.createServer((request, response) => {
            response.setHeader("content-type", "text/html");
            // The request path is echoed into HTML, so it is encoded first.
            response.end(htmlPage(`${origin} ${encodeURIComponent(request.url ?? "")}`));
        });

        server.listen(port, "127.0.0.1", () => {
            resolve(server);
        });
    });

const servers: http.Server[] = [];

test.beforeAll(async () => {
    servers.push(await serve(SITE_PORT, SITE), await serve(FOREIGN_PORT, FOREIGN));
    execFileSync(process.execPath, ["scripts/build.mjs"], {
        cwd: appDirectory,
        env: { ...process.env, NEORE_SITE_URL: SITE },
        stdio: "inherit",
    });
});

test.afterAll(() => {
    for (const server of servers) {
        server.close();
    }
});

const launch = () => electron.launch({ args: ["."], cwd: appDirectory });

/** The URL each open window shows. A page's title replaces the window title, so the URL identifies a window. */
const windowUrls = (app: ElectronApplication): Promise<string[]> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.webContents.getURL()));

/** Windows on the site: the main window. A popup to the site must not add one. */
const siteWindowCount = async (app: ElectronApplication): Promise<number> => {
    const urls = await windowUrls(app);

    return urls.filter((url) => url.startsWith(SITE)).length;
};

const findPage = async (app: ElectronApplication, isMatch: (url: string) => boolean): Promise<Page> => {
    const pagesNow = async (): Promise<Page[]> => {
        const pages = await app.windows();

        return pages.filter((page) => isMatch(page.url()));
    };

    await expect.poll(pagesNow).not.toHaveLength(0);

    const pages = await pagesNow();
    const [page] = pages;

    return page as Page;
};

/**
 * The site's window. `firstWindow()` is not it: the local Quick Composer page can
 * load first, so the site is picked by its URL, once the site has loaded.
 */
const siteWindow = (app: ElectronApplication): Promise<Page> => findPage(app, (url) => url.startsWith(SITE));

/** The Quick Composer's own page, which is loaded (and hidden) at start-up. */
const composerPage = (app: ElectronApplication): Promise<Page> => findPage(app, (url) => COMPOSER_FILE.test(url));

/** Replaces `shell.openExternal` in the main process, recording every URL it is asked to open. */
const recordExternalOpens = (app: ElectronApplication): Promise<void> =>
    app.evaluate(({ shell }) => {
        const opened: string[] = [];

        Object.assign(globalThis, { neoreOpened: opened });
        Object.assign(shell, {
            openExternal: async (url: string) => {
                opened.push(url);
            },
        });
    });

const openedUrls = (app: ElectronApplication): Promise<string[]> =>
    app.evaluate(() => (globalThis as { neoreOpened?: string[] }).neoreOpened ?? []);

test("loads the site and exposes the bridge only there", async () => {
    const app = await launch();

    try {
        const win = await siteWindow(app);

        await expect(win).toHaveURL(`${SITE}/chat`);
        // The advertised list is what the main process decided: `device` only when the core loaded.
        const probe = await app.evaluate(() => (globalThis as { neoreShell?: { device: boolean } }).neoreShell);
        const expected = probe?.device ? ["notifications", "compose", "sign-in", "device"] : ["notifications", "compose", "sign-in"];

        expect(await win.evaluate(() => (globalThis as PageGlobal).neoreNative?.capabilities)).toStrictEqual(expected);
        expect(await win.evaluate(() => typeof (globalThis as PageGlobal).neoreNative?.device)).toBe(probe?.device ? "object" : "undefined");
        // The local device window's bridge never reaches the site.
        expect(await win.evaluate(() => typeof (globalThis as PageGlobal).neoreDevice)).toBe("undefined");
    } finally {
        await app.close();
    }
});

test("sends a popup to another origin to the system browser, not a new window", async () => {
    const app = await launch();

    try {
        const win = await siteWindow(app);

        await recordExternalOpens(app);
        await win.evaluate((url) => window.open(url), `${FOREIGN}/offsite`);

        await expect.poll(() => openedUrls(app)).toStrictEqual([`${FOREIGN}/offsite`]);
        expect(await siteWindowCount(app)).toBe(1);
    } finally {
        await app.close();
    }
});

test("keeps a same-origin popup in the main window", async () => {
    const app = await launch();

    try {
        const win = await siteWindow(app);

        await win.evaluate((url) => window.open(url), `${SITE}/chat/thread-1`);

        await expect(win).toHaveURL(`${SITE}/chat/thread-1`);
        expect(await siteWindowCount(app)).toBe(1);
    } finally {
        await app.close();
    }
});

test("a foreign page in the window gets no bridge", async () => {
    const app = await launch();

    try {
        const win = await siteWindow(app);

        await win.evaluate((url) => {
            document.location.assign(url);
        }, `${FOREIGN}/login`);

        await expect(win).toHaveURL(`${FOREIGN}/login`);
        expect(await win.evaluate(() => typeof (globalThis as PageGlobal).neoreNative)).toBe("undefined");
    } finally {
        await app.close();
    }
});

test("creates the tray, and a Quick Composer window on its own local page", async () => {
    const app = await launch();

    try {
        await siteWindow(app);

        expect(await app.evaluate(() => (globalThis as { neoreShell?: { tray: boolean } }).neoreShell?.tray)).toBe(true);
        expect(await siteWindowCount(app)).toBe(1);

        const composer = await composerPage(app);

        expect(composer.url()).toMatch(COMPOSER_FILE);
        // The composer exposes its two commands and nothing of the site bridge.
        expect(await composer.evaluate(() => typeof (globalThis as PageGlobal).neoreNative)).toBe("undefined");
    } finally {
        await app.close();
    }
});

test("a text from the Quick Composer opens a new chat in the main window", async () => {
    const app = await launch();

    try {
        const win = await siteWindow(app);
        const composer = await composerPage(app);

        // The composer's own script (a classic script, under its CSP) must run for this to reach the main window.
        await composer.locator("#prompt").fill("draft from the composer");
        await composer.evaluate(() => (document.querySelector("#composer") as HTMLFormElement).requestSubmit());

        await expect(composer.locator("#status")).toBeEmpty();
        await expect.poll(() => win.evaluate(() => (globalThis as PageGlobal).neoreNative?.takePendingCompose())).toBe("draft from the composer");
    } finally {
        await app.close();
    }
});

test("a system-browser sign-in is started for Google, and its callback reaches the site once", async () => {
    const app = await launch();

    try {
        const win = await siteWindow(app);

        await recordExternalOpens(app);
        await win.evaluate(() => {
            document.location.assign("https://accounts.google.com/o/oauth2/v2/auth");
        });

        await expect.poll(() => openedUrls(app)).toHaveLength(1);

        const [grant] = await openedUrls(app);
        const url = new URL(grant ?? "");
        const code = "c".repeat(43);

        expect(url.origin).toBe(SITE);
        expect(url.pathname).toBe("/auth/extension");

        // The browser's redirect comes back through the OS; here, the same event the OS delivers.
        await app.evaluate(
            ({ app: electronApp }, link) => {
                electronApp.emit("second-instance", {}, ["neore", link]);
            },
            `neore://auth/callback?code=${code}&state=${url.searchParams.get("state") ?? ""}`,
        );

        const handoff = await win.evaluate(() => (globalThis as PageGlobal).neoreNative?.takePendingSignIn());

        expect(handoff).toStrictEqual({ code, codeVerifier: expect.any(String), redirectUri: "neore://auth/callback" });
        expect(await win.evaluate(() => (globalThis as PageGlobal).neoreNative?.takePendingSignIn())).toBeUndefined();
    } finally {
        await app.close();
    }
});

test("the device window opens from the site's relay, with its own bridge and not the site's", async () => {
    const app = await launch();

    try {
        const win = await siteWindow(app);
        // This check needs the built device-core addon (`packages/device-core-node`); without it the site is not offered `device`.
        const available = await app.evaluate(() => (globalThis as { neoreShell?: { device: boolean } }).neoreShell?.device === true);

        expect(available, "device-core-node must be built for this platform").toBe(true);

        await win.evaluate(() => (globalThis as PageGlobal).neoreNative?.device?.openSettings());

        const isDevice = (url: string) => url.endsWith("/device-window/device.html");
        const local = await findPage(app, isDevice);

        expect(await local.evaluate(() => typeof (globalThis as PageGlobal).neoreDevice)).toBe("object");
        expect(await local.evaluate(() => typeof (globalThis as PageGlobal).neoreNative)).toBe("undefined");
    } finally {
        await app.close();
    }
});

test("a coding agent is registered, started in a folder and prompted from the device window", async () => {
    const userData = mkdtempSync(path.join(tmpdir(), "neore-e2e-userdata-"));
    const work = mkdtempSync(path.join(tmpdir(), "neore-e2e-work-"));
    const fakeAgent = path.join(appDirectory, "src/acp/testing/fake-agent.mjs");
    // The app's own environment holds a Neore variable; the agent must not see it.
    const app = await electron.launch({
        args: [".", `--user-data-dir=${userData}`],
        cwd: appDirectory,
        env: { ...process.env, NEORE_E2E_PROBE: "leak" } as Record<string, string>,
    });

    try {
        const win = await siteWindow(app);

        expect(await app.evaluate(() => (globalThis as { neoreShell?: { device: boolean } }).neoreShell?.device === true), "device-core-node must be built").toBe(true);

        // The native confirmation and the folder picker answer for the user.
        await app.evaluate(({ dialog }, folder) => {
            Object.assign(dialog, {
                showMessageBox: async () => {
                    return { checkboxChecked: false, response: 1 };
                },
                showOpenDialog: async () => {
                    return { canceled: false, filePaths: [folder] };
                },
            });
        }, work);
        await win.evaluate(() => (globalThis as PageGlobal).neoreNative?.device?.openSettings());

        const local = await findPage(app, (url) => url.endsWith("/device-window/device.html"));

        await local.fill("#acp-name", "Fake agent");
        await local.fill("#acp-command", process.execPath);
        await local.fill("#acp-args", fakeAgent);
        await local.click("#acp-agent-form button[type=submit]");
        await expect(local.locator("#acp-agents li")).toContainText("Fake agent");

        await local.selectOption("#acp-env-scope", "fake-agent");
        await local.fill("#acp-env-name", "ONLY_ME");
        await local.fill("#acp-env-value", "value-xyz-123");
        await local.click("#acp-env-form button[type=submit]");
        await expect(local.locator("#acp-env")).toContainText("ONLY_ME");
        // Masked in the window: the value is not in the page.
        expect(await local.locator("#acp-env").textContent()).not.toContain("value-xyz-123");

        await local.click("button[aria-label='Start Fake agent in a folder']");
        await expect(local.locator("#acp-session-status")).toHaveText("Ready");

        await local.fill("#acp-prompt", "hello");
        await local.click("#acp-send");
        await expect(local.locator("#acp-transcript")).toContainText("Hello world");

        await local.fill("#acp-prompt", "env");
        await local.click("#acp-send");
        await expect(local.locator("#acp-transcript")).toContainText("ONLY_ME");

        const transcript = await local.locator("#acp-transcript").textContent();

        expect(transcript).toContain("value-xyz-123");
        expect(transcript).not.toContain("NEORE_E2E_PROBE");
        // The site's page never gets a coding-agent bridge.
        expect(await win.evaluate(() => typeof (globalThis as PageGlobal).neoreDevice)).toBe("undefined");
    } finally {
        await app.close();
        rmSync(userData, { force: true, recursive: true });
        rmSync(work, { force: true, recursive: true });
    }
});
