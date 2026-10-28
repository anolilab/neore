import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    terminal?: unknown;
}

/** The page-side globals the preloads expose; read inside `evaluate`, so typed by cast. */
type PageGlobal = {
    neoreDevice?: { openTerminal: (folder: string | null) => Promise<void>; terminalAvailability: () => Promise<{ available: boolean }> };
    neoreNative?: NeoreNativeForTests;
    neoreTerminal?: unknown;
};

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
// The site origin is baked in at build time, so the fixture server must be up first.
// Overridable so two runs in one checkout do not collide (`NEORE_E2E_PORT=4500 pnpm test:e2e`).
const SITE_PORT = Number(process.env.NEORE_E2E_PORT ?? 4399);
const FOREIGN_PORT = SITE_PORT + 1;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FOREIGN = `http://127.0.0.1:${FOREIGN_PORT}`;
const COMPOSER_FILE = /^file:\/\/.*\/quick-composer\/index\.html$/u;

const htmlPage = (title: string) => `<!doctype html><title>${title}</title><body>${title}</body>`;

/** Every request either fixture server received: method, URL, headers and body. The terminal test searches it. */
const received: string[] = [];

const serve = (port: number, origin: string) =>
    new Promise<http.Server>((resolve) => {
        const server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];

            request.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            });
            request.on("end", () => {
                received.push(`${request.method ?? ""} ${request.url ?? ""} ${JSON.stringify(request.headers)} ${Buffer.concat(chunks).toString("utf8")}`);
            });
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

/** The device window, with a coding agent registered and the native dialogs answering for the user. */
const agentWindow = async (app: ElectronApplication, work: string): Promise<{ local: Page; win: Page }> => {
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
    await local.fill("#acp-args", path.join(appDirectory, "src/acp/testing/fake-agent.mjs"));
    await local.click("#acp-agent-form button[type=submit]");
    await expect(local.locator("#acp-agents li")).toContainText("Fake agent");

    return { local, win };
};

/** What `acpStart` answers for a folder: "started", or the reason it was refused. */
const startOutcome = (local: Page, folder: string): Promise<string> =>
    local.evaluate(async (target) => {
        const api = (globalThis as unknown as { neoreDevice: { acpStart: (key: string, folder: string) => Promise<string> } }).neoreDevice;

        try {
            await api.acpStart("fake-agent", target);

            return "started";
        } catch (error) {
            return (error as Error).message;
        }
    }, folder);

const sendPrompt = async (local: Page, prompt: string): Promise<void> => {
    await local.fill("#acp-prompt", prompt);
    await local.click("#acp-send");
};

test("a coding agent runs only in an approved folder, with its environment built and its variables masked", async () => {
    const userData = mkdtempSync(path.join(tmpdir(), "neore-e2e-userdata-"));
    const work = mkdtempSync(path.join(tmpdir(), "neore-e2e-work-"));
    // The app's own environment holds a Neore variable; the agent must not see it.
    const app = await electron.launch({
        args: [".", `--user-data-dir=${userData}`],
        cwd: appDirectory,
        env: { ...process.env, NEORE_E2E_PROBE: "leak" } as Record<string, string>,
    });

    try {
        const { local, win } = await agentWindow(app, work);

        // Nothing is approved yet: a start is refused before a process exists.
        const refused = await startOutcome(local, work);

        expect(refused).toContain("not approved");
        await expect(local.locator("#acp-sessions li")).toHaveText("None.");

        await local.selectOption("#acp-env-scope", "fake-agent");
        await local.fill("#acp-env-name", "ONLY_ME");
        await local.fill("#acp-env-value", "value-xyz-123");
        await local.click("#acp-env-form button[type=submit]");
        await expect(local.locator("#acp-env")).toContainText("ONLY_ME");
        // Masked in the window: the value is not in the page.
        expect(await local.locator("#acp-env").textContent()).not.toContain("value-xyz-123");

        await local.fill("#acp-env-name", "NEORE_SNEAKY");
        await local.fill("#acp-env-value", "x");
        await local.click("#acp-env-form button[type=submit]");
        await expect(local.locator("#acp-error")).toContainText("reserved");

        // Approve the folder, then start there.
        await local.click("button[aria-label='Approve a folder for Fake agent']");
        await local.click(`button[aria-label^='Start Fake agent in ']`);
        await expect(local.locator("#acp-session-status")).toHaveText("Ready");

        await sendPrompt(local, "hello");
        await expect(local.locator("#acp-transcript")).toContainText("Hello world");

        await sendPrompt(local, "env");
        await expect(local.locator("#acp-transcript")).toContainText("ONLY_ME");

        const transcript = await local.locator("#acp-transcript").textContent();

        // The agent echoed its environment: the variable arrived, and its value is masked in the window.
        expect(transcript).toContain("\"ONLY_ME\":\"***\"");
        expect(transcript).not.toContain("value-xyz-123");
        expect(transcript).not.toContain("NEORE_E2E_PROBE");
        expect(transcript).not.toContain("NEORE_SNEAKY");
        // The site's page never gets a coding-agent bridge.
        expect(await win.evaluate(() => typeof (globalThis as PageGlobal).neoreDevice)).toBe("undefined");

        // Stop approving: the next start in that folder is refused again.
        await local.click("button[aria-label^='Stop approving Fake agent']");
        const afterRevoke = await startOutcome(local, work);

        expect(afterRevoke).toContain("not approved");
        // And the agent already running under that approval was ended with it.
        await expect(local.locator("#acp-session-status")).toContainText("Ended");
    } finally {
        await app.close();

        for (const directory of [userData, work]) {
            rmSync(directory, { force: true, recursive: true });
        }
    }
});

test("a coding agent's requests are answered one at a time or together, never with an 'always'", async () => {
    const userData = mkdtempSync(path.join(tmpdir(), "neore-e2e-userdata-"));
    const work = mkdtempSync(path.join(tmpdir(), "neore-e2e-work-"));
    const app = await electron.launch({ args: [".", `--user-data-dir=${userData}`], cwd: appDirectory });
    const frameLog = path.join(userData, "agent-frames.log");

    try {
        const { local } = await agentWindow(app, work);
        const bar = local.locator("#acp-requests");
        const transcript = local.locator("#acp-transcript");

        // The scripted agent logs every frame it receives and checks it against the protocol's schema.
        await local.selectOption("#acp-env-scope", "fake-agent");
        await local.fill("#acp-env-name", "FAKE_AGENT_LOG");
        await local.fill("#acp-env-value", frameLog);
        await local.click("#acp-env-form button[type=submit]");
        await expect(local.locator("#acp-env")).toContainText("FAKE_AGENT_LOG");

        await local.click("button[aria-label='Approve a folder for Fake agent']");
        await local.click(`button[aria-label^='Start Fake agent in ']`);
        await expect(local.locator("#acp-session-status")).toHaveText("Ready");

        // Approve once: the agent continues.
        await sendPrompt(local, "perm 1");
        await expect(bar).toContainText("Run command 1");
        await expect(bar).toContainText("/work/file.txt");
        // The agent offered an "always" option; the window shows none of it.
        const shown = await bar.textContent();

        expect(shown?.toLowerCase()).not.toContain("always");

        // Rust refuses an always option from the window's own API too, and the request keeps waiting.
        const refusal = await local.evaluate(async () => {
            const api = (globalThis as unknown as { neoreDevice: { acpPermissionAnswer: (id: number, option: string) => Promise<void>; acpPermissions: () => Promise<{ id: number }[]> } }).neoreDevice;
            const [first] = await api.acpPermissions();

            try {
                await api.acpPermissionAnswer(first.id, "always");

                return "accepted";
            } catch (error) {
                return (error as Error).message;
            }
        });

        expect(refusal).toContain("Always allow");
        await expect(bar).toContainText("Run command 1");

        await expect(bar.locator("button", { hasText: "Allow once" })).toBeEnabled();
        await bar.locator("button", { hasText: "Allow once" }).click();
        await expect(transcript).toContainText("ran 1");

        // A second request later in the same session still reaches the prompt; decline ends that call as declined.
        await sendPrompt(local, "perm 2");
        await expect(bar).toContainText("Run command 2");
        await expect(bar.locator("button", { hasText: "Deny" })).toBeEnabled();
        await bar.locator("button", { hasText: "Deny" }).click();
        await expect(transcript).toContainText("declined 2: reject");

        // Several requests from one session: one bar, one line each, and Approve all answers each once.
        await sendPrompt(local, "permmany 3");
        await expect(bar.locator(".request")).toHaveCount(3);
        const all = bar.locator("button", { hasText: "Approve all (3)" });

        await expect(all).toBeEnabled();
        await all.click();
        await expect(transcript).toContainText("allow,allow,allow");
        await expect(bar).toBeHidden();

        // Stopping a turn that waits on a request cancels it.
        await sendPrompt(local, "perm 4");
        await expect(bar).toContainText("Run command 4");
        await local.click("#acp-stop");
        await expect(bar).toBeHidden();
        await expect(local.locator("#acp-session-status")).toHaveText("Ready");

        // On the wire: every answer the agent received was a once-option or a cancel, and every frame was valid.
        const frames = readFileSync(frameLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { received?: { result?: { outcome?: { optionId?: string; outcome: string } } }; violation?: string });
        const outcomes = frames.flatMap((frame) => frame.received?.result?.outcome === undefined ? [] : [frame.received.result.outcome]);

        expect(outcomes.length).toBeGreaterThanOrEqual(6);
        expect(outcomes.filter((outcome) => outcome.outcome === "selected").map((outcome) => outcome.optionId)).not.toContain("always");
        expect(frames.flatMap((frame) => frame.violation === undefined ? [] : [frame.violation])).toEqual([]);
    } finally {
        await app.close();
        rmSync(userData, { force: true, recursive: true });
        rmSync(work, { force: true, recursive: true });
    }
});

/** A login shell reads the user's profile before it answers, which on a busy machine takes longer than an assertion's default. A cold PowerShell on a CI runner takes longer still. */
const SHELL_TIMEOUT = process.platform === "win32" ? 60_000 : 20_000;
/** The shell's own arithmetic: `sh` on macOS and Linux, PowerShell on Windows. The typed text never contains the result, so only the shell's answer can match it. */
const calc = (expression: string): string => process.platform === "win32" ? `$(${expression})` : `$((${expression}))`;
const TERMINAL_PAGE = /\/terminal-window\/terminal\.html$/u;
const isAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

test("the site's bridge has no terminal, and the terminal's bridge never reaches the site", async () => {
    const app = await launch();

    try {
        const win = await siteWindow(app);

        expect(await win.evaluate(() => (globalThis as PageGlobal).neoreNative?.terminal)).toBeUndefined();
        expect(await win.evaluate(() => typeof (globalThis as PageGlobal).neoreTerminal)).toBe("undefined");
        // The device relay (the only thing the site can call about this computer) offers no way to open one either.
        expect(await win.evaluate(() => Object.keys((globalThis as PageGlobal).neoreNative?.device ?? {}))).not.toContain("openTerminal");
    } finally {
        await app.close();
    }
});

type TerminalProbe = { openTerminal: (folder: string) => Promise<void>; terminalPids: () => number[] };

const terminalPids = (app: ElectronApplication): Promise<number[]> =>
    app.evaluate(() => (globalThis as { neoreShell?: TerminalProbe }).neoreShell?.terminalPids() ?? []);

const terminalCount = async (app: ElectronApplication): Promise<number> => {
    const pids = await terminalPids(app);

    return pids.length;
};

test.describe("the local terminal", () => {
    // Playwright's default is 60 s; a cold PowerShell on ConPTY, started twice in the reload test, can use most of it.
    test.setTimeout(process.platform === "win32" ? 180_000 : 60_000);

    test("runs a shell in the folder, sends nothing to any server, and ends every shell when the app quits", async () => {
        const marker = `marker-${String(Date.now())}`;
        const app = await launch();
        let shells: number[] = [];

        try {
            await siteWindow(app);
            // The probe opens it directly, so this needs neither the device window nor the built device addon.
            await app.evaluate((_electron, folder) => (globalThis as { neoreShell?: TerminalProbe }).neoreShell?.openTerminal(folder), appDirectory);

            const terminal = await findPage(app, (url) => TERMINAL_PAGE.test(url));
            const requests: string[] = [];

            terminal.on("request", (request) => {
                requests.push(request.url());
            });

            // Its own bridge, and nothing of the site's or the device window's.
            expect(await terminal.evaluate(() => typeof (globalThis as PageGlobal).neoreTerminal)).toBe("object");
            expect(await terminal.evaluate(() => typeof (globalThis as PageGlobal).neoreNative)).toBe("undefined");
            expect(await terminal.evaluate(() => typeof (globalThis as PageGlobal).neoreDevice)).toBe("undefined");

            await expect.poll(() => terminalCount(app)).toBe(1);
            shells = await terminalPids(app);

            await terminal.locator(".xterm-helper-textarea").focus();
            await terminal.keyboard.type(`echo ${marker.slice(0, 7)}${calc("6*7")}${marker.slice(7)}`);
            await terminal.keyboard.press("Enter");

            await expect(terminal.locator(".xterm-rows")).toContainText(`${marker.slice(0, 7)}42${marker.slice(7)}`, { timeout: SHELL_TIMEOUT });

            // The page itself cannot reach a server either: its session cancels everything but its own files.
            const reachedSite = await terminal.evaluate(async (url) => {
                try {
                    await fetch(url);

                    return true;
                } catch {
                    return false;
                }
            }, `${SITE}/from-terminal-${marker}`);

            expect(reachedSite).toBe(false);
            // Everything the page asked for was one of its own files.
            expect(requests.filter((url) => !url.startsWith("file://"))).toStrictEqual([]);
            // And no server, ours or foreign, ever saw the page's request, or what was typed or printed.
            expect(received.filter((entry) => entry.includes(marker.slice(7)))).toStrictEqual([]);
            expect(shells.every((pid) => isAlive(pid))).toBe(true);
        } finally {
            await app.close();
        }

        expect(shells).toHaveLength(1);
        await expect.poll(() => shells.some((pid) => isAlive(pid)), { timeout: 10_000 }).toBe(false);
    });

    test("a reload of the page ends its shell and starts a fresh one that works", async () => {
        const app = await launch();

        try {
            await siteWindow(app);
            await app.evaluate((_electron, folder) => (globalThis as { neoreShell?: TerminalProbe }).neoreShell?.openTerminal(folder), appDirectory);

            const terminal = await findPage(app, (url) => TERMINAL_PAGE.test(url));

            await expect.poll(() => terminalCount(app)).toBe(1);

            const [before] = await terminalPids(app);

            await terminal.reload();

            await expect.poll(async () => {
                const pids = await terminalPids(app);

                return pids.filter((pid) => pid !== before);
            }).toHaveLength(1);
            await expect.poll(() => isAlive(before as number), { timeout: 10_000 }).toBe(false);

            await terminal.locator(".xterm-helper-textarea").focus();
            await terminal.keyboard.type(`echo after-${calc("1+2")}-reload`);
            await terminal.keyboard.press("Enter");
            await expect(terminal.locator(".xterm-rows")).toContainText("after-3-reload", { timeout: SHELL_TIMEOUT });
        } finally {
            await app.close();
        }
    });
});
