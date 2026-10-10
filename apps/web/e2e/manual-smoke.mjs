/**
 * Ad-hoc smoke driver: register -> log in -> reach chat, screenshotting every
 * step and reporting every console error, page error, failed request and CORS
 * rejection along the way.
 *
 * `auth-flow.mjs` checks the same journey properly; this one exists for the
 * screenshots when you need to see where it went wrong. Not part of the test
 * suite — run it directly:
 *   node e2e/manual-smoke.mjs [baseURL]
 */
import { chromium } from "playwright";

import { attachDiagnostics, finish } from "./harness.mjs";

const REGISTER_PATH_RE = /register|sign-up/;

const BASE = process.argv[2] ?? "http://localhost:5173";
const stamp = Date.now();
const USER = { email: `smoke${stamp}@example.com`, name: `Smoke ${stamp}`, password: "SmokeTest!2345" };

const browser = await chromium.launch();
const page = await (await browser.newContext({ baseURL: BASE })).newPage();
const diagnostics = attachDiagnostics(page, { baseURL: BASE });

const snap = async (label) => {
    await page.screenshot({ fullPage: false, path: `/tmp/smoke-${label}.png` }).catch(() => {});
    console.log(`\n── ${label} — ${page.url()}`);

    const text = await page.evaluate(() => (document.body?.textContent ?? "").replaceAll(/\s+/g, " ").slice(0, 700)).catch(() => "");

    console.log(
        text
            .split("\n")
            .filter(Boolean)
            .slice(0, 18)
            .map((line) => `   ${line}`)
            .join("\n"),
    );
};

/**
 * Submit the visible form and wait for `urlPart` to answer, rather than for a fixed number of seconds.
 * @param urlPart
 */
const submit = async (urlPart) => {
    // `.catch` first: an unattached rejection would kill the run outright.
    const response = page.waitForResponse((r) => r.url().includes(urlPart), { timeout: 20_000 }).catch(() => null);

    // `noWaitAfter` because submitting can schedule a navigation, and an HMR
    // reload mid-click leaves Playwright waiting on it indefinitely.
    await page
        .locator("button[type=submit]")
        .first()
        .click({ noWaitAfter: true })
        .catch(() => {});
    console.log(`   ${urlPart} -> ${String((await response)?.status() ?? "no response")}`);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
};

await page.goto("/", { timeout: 60_000, waitUntil: "domcontentloaded" });
await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
await snap("01-landing");

// The consent banner is an overlay: until it is dismissed it swallows the
// submit click and no request is ever made, which reads as broken registration.
const accept = page.getByRole("button", { name: /accept all/i }).first();

if (
    await accept.waitFor({ state: "visible", timeout: 2500 }).then(
        () => true,
        () => false,
    )
) {
    await accept.click();
    await accept.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
}

// Registration — the route has moved before, so probe the known spellings.
for (const path of ["/auth/sign-up", "/sign-up", "/register", "/auth/register"]) {
    const response = await page.goto(path, { timeout: 30_000, waitUntil: "domcontentloaded" }).catch(() => null);

    if (
        response &&
        response.status() < 400 &&
        (await page
            .locator("input[type=password]")
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .then(
                () => true,
                () => false,
            ))
    ) {
        console.log(`\n   registration form found at ${path}`);
        break;
    }
}

// The form is server-rendered, so it paints before React attaches the submit
// handler — clicking in that window does nothing at all. `networkidle` is the
// hydration signal.
await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
await snap("02-signup");

// Base UI renders these without a `name`, with generated ids — placeholder is
// the only stable handle.
const emailField = page.locator("input[type=email]").first();

if (await emailField.count()) {
    const nameField = page.locator('input[placeholder*="name" i]').first();

    if (await nameField.count()) await nameField.fill(USER.name);

    await emailField.fill(USER.email);

    const passwords = page.locator("input[type=password]");

    for (let index = 0; index < (await passwords.count()); index += 1) await passwords.nth(index).fill(USER.password);

    await submit("/api/auth/sign-up/email");
    await page.waitForURL((url) => !REGISTER_PATH_RE.test(url.pathname), { timeout: 8000 }).catch(() => {});
}

await snap("03-after-signup");

// If sign-up did not log us in, sign in explicitly.
if (REGISTER_PATH_RE.test(page.url())) {
    await page.goto("/auth/sign-in", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

    const email = page.locator("input[type=email]").first();

    if (
        await email.waitFor({ state: "visible", timeout: 30_000 }).then(
            () => true,
            () => false,
        )
    ) {
        await email.fill(USER.email);
        await page.locator("input[type=password]").first().fill(USER.password);
        await submit("/api/auth/sign-in/email");
        await page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 8000 }).catch(() => {});
    }

    await snap("04-after-signin");
}

await page.goto("/chat", { timeout: 45_000, waitUntil: "domcontentloaded" }).catch(() => {});
await page
    .locator('textarea, [contenteditable="true"]')
    .first()
    .waitFor({ state: "visible", timeout: 45_000 })
    .catch(() => {});
await snap("05-chat");

const composers = await page.locator('textarea, [contenteditable="true"]').count();

console.log(`\n   composer inputs on /chat: ${String(composers)}`);
console.log(`   final url: ${page.url()}`);

await finish(browser, page, diagnostics, [composers > 0 ? null : "no composer on /chat"]);

console.log(`\ncredentials: ${USER.email} / ${USER.password}`);
