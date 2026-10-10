/**
 * Every settings page, opened once by a signed-in user, in English and in
 * German. A crash on `/dashboard/settings/chat/usage` (Lingui "Attempted to
 * call a translation function without setting a locale") reached main because
 * no spec ever opened that page; this sweep is the net for the next one.
 *
 * Each page must render its title — in the breadcrumb, and as the page's one
 * `h1` with the same name — show no error boundary and log no page
 * error or console error. The route list is checked against the route files on
 * disk, so a new settings page fails here until it is added to the sweep.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ConsoleMessage, Page } from "@playwright/test";

import { expect, expectAssistantReply, openChat, sendMessage, settle, test } from "./chat-helpers";
import { APP_BASE_URL } from "./fixtures";

const SETTINGS_ROUTES_DIR = fileURLToPath(new URL("../src/routes/dashboard/settings", import.meta.url));

/** Routes the sweep does not open, and why. */
const SKIPPED_ROUTES = new Map<string, string>([
    // The OAuth provider's redirect target: without a real `code`/`state` pair it only reports the failed exchange.
    ["connectors/callback", "needs an OAuth redirect"],
]);

/** Every settings page, as its path below `/dashboard/settings/`. */
const SETTINGS_PAGES = [
    "app/customization",
    "app/keyboard-shortcuts",
    "app/personalization",
    "auth/account",
    "auth/api-keys",
    "auth/members",
    "auth/organization",
    "auth/organizations",
    "auth/security",
    "auth/teams",
    "chat/agent",
    "chat/devices",
    "chat/knowledge",
    "chat/mcp",
    "chat/model-filters",
    "chat/models",
    "chat/triggers",
    "chat/usage",
    "connectors",
    "connectors/messenger",
    "privacy",
] as const;

/** Both error UIs: the app's `ErrorBoundary` / `ErrorComponent` and TanStack's default "Something went wrong!". */
const ERROR_BOUNDARY_RE = /Something went wrong/i;

/** "1 reply on 1 active day …" / "1 Antwort an 1 aktiven Tag …": the number is what is asserted. */
const ONE_REPLY_RE = /(?:^|\D)1 (?:reply|Antwort)\b/;

const NON_EMPTY_RE = /\S/;
const ORGANIZATIONS_URL_RE = /\/dashboard\/settings\/auth\/organizations$/;
const TSX_EXTENSION_RE = /\.tsx$/;
const TRAILING_SLASH_RE = /\/$/;

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

const routeFilesOnDisk = (directory: string, prefix = ""): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
            return routeFilesOnDisk(`${directory}/${entry.name}`, `${prefix}${entry.name}/`);
        }

        const name = entry.name.replace(TSX_EXTENSION_RE, "");

        return name === "index" ? [prefix.replace(TRAILING_SLASH_RE, "")] : [`${prefix}${name}`];
    });

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

/** The page's visible title: the breadcrumb's current page. */
const pageTitle = (page: Page) => page.locator("main").getByRole("navigation", { name: "breadcrumb" }).locator('[aria-current="page"]');

/**
 * The page's `h1` — `sr-only`, rendered by the settings layout
 * (`SettingsPageOutline`) with the same name as the breadcrumb. Accessible, not
 * visible, so it is matched by role, which an `sr-only` element still has.
 */
const pageHeading = (page: Page) => page.getByRole("heading", { level: 1 });

/**
 * One `h1`, naming the page as the breadcrumb does (in the page's own locale),
 * so a screen-reader user can find the page by its heading.
 */
const expectPageHeading = async (page: Page, path: string): Promise<void> => {
    await expect.soft(pageTitle(page), `${path} shows its title`).toHaveText(NON_EMPTY_RE, { timeout: 60_000 });

    const title = (await pageTitle(page).textContent())?.trim() ?? "";

    await expect.soft(pageHeading(page), `${path} has exactly one h1`).toHaveCount(1);
    await expect.soft(pageHeading(page), `${path}'s h1 names the page`).toHaveText(title);
};

/**
 * Load a settings page.
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
const loadSettingsPage = async (page: Page, path: string, clearErrors: () => void): Promise<void> => {
    await settle(page);
    // Only this load's errors count.
    clearErrors();
    // Bounded, so a page that never finishes loading fails as itself, not as the whole sweep's timeout.
    await page.goto(`/dashboard/settings/${path}`, { timeout: 90_000 });
};

/**
 * Open every settings page in turn and return the errors each one logged. Render
 * failures are soft assertions, so one broken page does not hide the next.
 */
const sweepSettingsPages = async (page: Page, locale: string): Promise<Record<string, string[]>> => {
    const errors = collectErrors(page);
    const errorsByPage: Record<string, string[]> = {};

    for (const path of SETTINGS_PAGES) {
        await test.step(path, async () => {
            await loadSettingsPage(page, path, () => {
                errors.length = 0;
            });

            await expect(page, `${path} stays on its route`).toHaveURL(new RegExp(`/dashboard/settings/${path}(?:[?#]|$)`), { timeout: 60_000 });
            await expect(page.locator("html"), `${path} renders in ${locale}`).toHaveAttribute("lang", locale);
            await expectPageHeading(page, path);
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

    test("the sweep covers every settings route", () => {
        const onDisk = routeFilesOnDisk(SETTINGS_ROUTES_DIR)
            .filter((route) => !SKIPPED_ROUTES.has(route))
            .toSorted((a, b) => a.localeCompare(b));

        expect(onDisk).toEqual([...SETTINGS_PAGES].toSorted((a, b) => a.localeCompare(b)));
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

    test("without an organization, the organization pages send the user to the organization list", async ({ userPage: page }) => {
        for (const path of ["auth/organization", "auth/members"]) {
            await settle(page);
            await page.goto(`/dashboard/settings/${path}`, { timeout: 90_000 });
            // It used to replace to `/auth/settings`, a route this app does not have.
            await expect(page).toHaveURL(ORGANIZATIONS_URL_RE, { timeout: 60_000 });
        }
    });

    test("the usage page counts a reply in its activity heatmap", async ({ userPage: page }) => {
        const prompt = `Usage heatmap probe ${Math.random().toString(36).slice(2, 7)}`;

        await openChat(page);
        await sendMessage(page, prompt);
        await expectAssistantReply(page, `Mock reply: ${prompt}`);

        const errors = collectErrors(page);
        const activity = page.getByText(ONE_REPLY_RE).first();

        // The rollup is recorded by a job scheduled after the run, and the heatmap is a one-shot
        // query, so reload until it has landed.
        await expect(async () => {
            await settle(page);
            await page.goto("/dashboard/settings/chat/usage");
            await expect(page.getByText("Activity", { exact: true })).toBeVisible({ timeout: 60_000 });
            await expect(activity).toBeVisible({ timeout: 10_000 });
        }).toPass({ timeout: 180_000 });

        await expect(page.getByText(ERROR_BOUNDARY_RE)).toHaveCount(0);
        await settle(page);
        expect(errors).toEqual([]);
    });
});
