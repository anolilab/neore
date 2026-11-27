/**
 * Every settings tab, opened once by a signed-in user through its old page URL, in English and in
 * German. A crash on the usage page (Lingui "Attempted to call a translation function without setting
 * a locale") reached main because no spec ever opened it; this sweep is the net for the next one.
 *
 * Settings live in a modal now, and each old `/dashboard/settings/*` URL redirects to `/chat` with the modal
 * open at that page's tab. Each URL must land there, show the tab's title (the navigation's current item, and
 * the tab's one `h2` with the same name), show no error boundary and log no page error or console error. The
 * path list is checked against the path table in `settings-link.ts`, so a page added to the table fails here
 * until it is added to the sweep.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ConsoleMessage, Page } from "@playwright/test";

import { expect, expectAssistantReply, openChat, sendMessage, settle, test } from "./chat-helpers";
import { APP_BASE_URL } from "./fixtures";

const SETTINGS_LINK_SOURCE = fileURLToPath(new URL("../src/features/settings/lib/settings-link.ts", import.meta.url));

/** Every old settings page, as its path below `/dashboard/settings/`, with the modal tab it opens and that tab's English title. */
const SETTINGS_PAGES = {
    "api-keys": { tab: "chat-api-keys", title: "API Keys" },
    "app/customization": { tab: "app-customization", title: "Customization" },
    "app/keyboard-shortcuts": { tab: "app-keyboard", title: "Keyboard Shortcuts" },
    "app/personalization": { tab: "chat-personalization", title: "Personalization" },
    "auth/account": { tab: "auth-account", title: "Account" },
    "auth/api-keys": { tab: "auth-api-keys", title: "API Keys" },
    "auth/members": { tab: "auth-members", title: "Members" },
    "auth/organization": { tab: "auth-organization", title: "Organization" },
    "auth/organizations": { tab: "auth-organizations", title: "Organizations" },
    "auth/security": { tab: "auth-security", title: "Security" },
    "auth/teams": { tab: "auth-teams", title: "Teams" },
    "billing/limits": { tab: "auth-billing", title: "Billing" },
    "chat/agent": { tab: "chat-agent", title: "Agent" },
    "chat/bots": { tab: "chat-bots", title: "Bots" },
    "chat/devices": { tab: "chat-devices", title: "Devices" },
    "chat/knowledge": { tab: "chat-knowledge", title: "Knowledge Base" },
    "chat/mcp": { tab: "chat-mcp", title: "MCP Servers" },
    "chat/model": { tab: "chat-models", title: "Models" },
    "chat/model-filters": { tab: "chat-model-filters", title: "Model Restrictions" },
    "chat/models": { tab: "chat-models", title: "Models" },
    "chat/triggers": { tab: "chat-triggers", title: "Triggers" },
    "chat/usage": { tab: "chat-usage", title: "Usage" },
    "compliance/model-filters": { tab: "chat-model-filters", title: "Model Restrictions" },
    connectors: { tab: "connectors", title: "Connectors" },
    "connectors/messenger": { tab: "connectors-messenger", title: "Messenger" },
    privacy: { tab: "privacy", title: "Privacy & Data" },
} as const;

type SettingsPath = keyof typeof SETTINGS_PAGES;

// `"app/customization": "app-customization",` or `connectors: "connectors",`
const PAIR_RE = /^ +(?:"([^"]+)"|([a-z]+)): "([^"]+)",$/gmu;

/** The `path: tab` pairs of `TAB_BY_SETTINGS_PATH`, read from its source: the app's own table, not a copy of it. */
const redirectTable = (): Record<string, string> => {
    const source = readFileSync(SETTINGS_LINK_SOURCE, "utf8");
    const table = source.slice(source.indexOf("TAB_BY_SETTINGS_PATH"));
    const body = table.slice(table.indexOf("{"), table.indexOf("};"));

    return Object.fromEntries([...body.matchAll(PAIR_RE)].map((match) => [match[1] ?? match[2] ?? "", match[3] ?? ""]));
};

/** The modal's URL for a tab: `/chat` with `settings` and `settingsTab` in its search. */
const settingsUrlFor = (tab: string): RegExp => new RegExp(String.raw`/chat\?(?:.*&)?settingsTab=${tab}(?:&|$)`);

/** Both error UIs: the app's `ErrorBoundary` / `ErrorComponent` and TanStack's default "Something went wrong!". */
const ERROR_BOUNDARY_RE = /Something went wrong/i;

/** "1 reply on 1 active day …" / "1 Antwort an 1 aktiven Tag …": the number is what is asserted. */
const ONE_REPLY_RE = /(?:^|\D)1 (?:reply|Antwort)\b/;

const NON_EMPTY_RE = /\S/;

/**
 * Console noise that is not the page's fault. Each entry says why it is allowed;
 * anything else logged at `error` level fails the page.
 */
const BENIGN_CONSOLE_ERRORS: { reason: string; test: RegExp }[] = [
    {
        // A resource the browser could not load is reported as a bare console error with no page context
        // (an avatar, a favicon, an aborted RPC during navigation). A crash surfaces as `pageerror` instead.
        reason: "failed resource load",
        test: /^Failed to load resource/,
    },
];

/** Record the page errors and unexpected console errors `page` produces from now on. */
const collectErrors = (page: Page): string[] => {
    const errors: string[] = [];

    page.on("pageerror", (error) => {
        errors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message: ConsoleMessage) => {
        if (message.type() !== "error") {
            return;
        }

        const text = message.text();

        if (BENIGN_CONSOLE_ERRORS.every((benign) => !benign.test.test(text))) {
            errors.push(`console.error: ${text}`);
        }
    });

    return errors;
};

/** The settings modal. */
/** The settings modal, found by its section list rather than its name, which follows the locale ("Einstellungen" in German). */
const settingsDialog = (page: Page) => page.getByRole("dialog").filter({ has: page.getByRole("navigation") });

/** The navigation's current item: the tab the modal shows. */
const currentTabItem = (page: Page) => settingsDialog(page).getByRole("navigation").locator('[aria-current="true"]');

/**
 * The tab's title is the navigation's current item, and the tab has one `h2` with the same name (in the modal's own
 * locale), so a screen-reader user can find the tab by its heading. In English the title is the expected one.
 */
const expectTabTitle = async (page: Page, path: SettingsPath, locale: string): Promise<void> => {
    await expect.soft(currentTabItem(page), `${path} shows its title`).toHaveText(NON_EMPTY_RE, { timeout: 60_000 });

    const title = (await currentTabItem(page).textContent())?.trim() ?? "";

    // Only English has the expected title to compare; another locale compares the page with itself.
    expect.soft(locale === "en" ? title : SETTINGS_PAGES[path].title, `${path} opens the ${SETTINGS_PAGES[path].tab} tab`).toBe(SETTINGS_PAGES[path].title);

    await expect
        .soft(settingsDialog(page).getByRole("heading", { exact: true, level: 2, name: title }), `${path} has exactly one h2 naming the tab`)
        .toHaveCount(1);
};

/**
 * Load an old settings page URL; it redirects to the chat with the modal open.
 *
 * The sweep is two full page loads a second, from one IP. It used to reload any
 * page that got a 429 from `/api/auth/*` and wait out better-auth's per-IP
 * window first, because a rate-limited `get-session` rendered the dashboard
 * without its session. That is the app's job now, and this spec relies on it:
 * `get-session` is exempt from the limiter (`AUTH_RATE_LIMIT_CUSTOM_RULES`,
 * `backend/lunora/auth.ts`), and any session read that still fails is retried
 * and treated as "unknown", never as signed out (`src/lib/auth/session-read.ts`,
 * `src/lib/auth/route-guard.ts`). A page that does not render here is the
 * page's — or that recovery's — fault.
 */
const loadSettingsPage = async (page: Page, path: SettingsPath, clearErrors: () => void): Promise<void> => {
    await settle(page);
    // Only this load's errors count.
    clearErrors();
    // Bounded, so a page that never finishes loading fails as itself, not as the whole sweep's timeout.
    await page.goto(`/dashboard/settings/${path}`, { timeout: 90_000 });
};

/**
 * Open every old settings page URL in turn and return the errors each one logged. Render
 * failures are soft assertions, so one broken page does not hide the next.
 */
const sweepSettingsPages = async (page: Page, locale: string): Promise<Record<string, string[]>> => {
    const errors = collectErrors(page);
    const errorsByPage: Record<string, string[]> = {};

    for (const path of Object.keys(SETTINGS_PAGES) as SettingsPath[]) {
        await test.step(path, async () => {
            await loadSettingsPage(page, path, () => {
                errors.length = 0;
            });

            await expect(page, `${path} redirects to the chat with its tab open`).toHaveURL(settingsUrlFor(SETTINGS_PAGES[path].tab), { timeout: 60_000 });
            await expect(settingsDialog(page), `${path} opens the settings modal`).toBeVisible({ timeout: 60_000 });
            await expect(page.locator("html"), `${path} renders in ${locale}`).toHaveAttribute("lang", locale);
            await expectTabTitle(page, path, locale);
            await expect.soft(page.getByText(ERROR_BOUNDARY_RE), `${path} shows no error boundary`).toHaveCount(0);
            // Queries resolve after the title paints; let the page finish asking before judging its console.
            await settle(page);

            if (errors.length > 0) {
                errorsByPage[path] = [...errors];
            }
        });
    }

    return errorsByPage;
};

/**
 * Create an organization for the signed-in user and make it the active one:
 * without an active organization the organization and members pages have
 * nothing to show and send the user to the organization list instead.
 */
const createOrganization = async (page: Page): Promise<void> => {
    const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`;
    const response = await page.request.post("/api/auth/organization/create", {
        data: { name: `E2E ${slug}`, slug },
        headers: { Origin: new URL(APP_BASE_URL).origin },
    });

    expect(response.ok(), await response.text()).toBe(true);

    // Creating does NOT make it active (every get-full-organization answered
    // `null` until this was added) — the app's create dialog calls setActive
    // right after, so the test does too.
    const { id: organizationId } = (await response.json()) as { id: string };
    const activate = await page.request.post("/api/auth/organization/set-active", {
        data: { organizationId },
        headers: { Origin: new URL(APP_BASE_URL).origin },
    });

    expect(activate.ok(), await activate.text()).toBe(true);
};

test.describe("Settings pages", () => {
    test.describe.configure({ timeout: 900_000 });

    test("the sweep covers every old settings path", () => {
        const sweptTabs = Object.fromEntries(Object.entries(SETTINGS_PAGES).map(([path, { tab }]) => [path, tab]));

        expect(redirectTable()).toEqual(sweptTabs);
    });

    test("every settings page renders in English", async ({ userPage: page }) => {
        await createOrganization(page);
        expect(await sweepSettingsPages(page, "en")).toEqual({});
    });

    test("every settings page renders in German", async ({ userPage: page }) => {
        await createOrganization(page);
        await page.context().addCookies([{ name: "locale", url: APP_BASE_URL, value: "de" }]);
        expect(await sweepSettingsPages(page, "de")).toEqual({});
    });

    test("without an organization, the organization tabs send the user to the organization list", async ({ userPage: page }) => {
        for (const path of ["auth/organization", "auth/members"]) {
            await settle(page);
            await page.goto(`/dashboard/settings/${path}`, { timeout: 90_000 });
            // The tab has nothing to show, so the modal switches to the list (replacing its own history entry).
            await expect(page).toHaveURL(settingsUrlFor("auth-organizations"), { timeout: 60_000 });
            await expect(currentTabItem(page)).toHaveText("Organizations");
        }
    });

    test("the usage tab counts a reply in its activity heatmap", async ({ userPage: page }) => {
        const prompt = `Usage heatmap probe ${Math.random().toString(36).slice(2, 7)}`;

        await openChat(page);
        await sendMessage(page, prompt);
        await expectAssistantReply(page, `Mock reply: ${prompt}`);

        const errors = collectErrors(page);
        const activity = settingsDialog(page).getByText(ONE_REPLY_RE).first();

        // The rollup is recorded by a job scheduled after the run, and the heatmap is a one-shot
        // query, so reload until it has landed.
        await expect(async () => {
            await settle(page);
            await page.goto("/dashboard/settings/chat/usage");
            await expect(settingsDialog(page).getByText("Activity", { exact: true })).toBeVisible({ timeout: 60_000 });
            await expect(activity).toBeVisible({ timeout: 10_000 });
        }).toPass({ timeout: 180_000 });

        await expect(page.getByText(ERROR_BOUNDARY_RE)).toHaveCount(0);
        await settle(page);
        expect(errors).toEqual([]);
    });
});
