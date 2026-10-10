/**
 * Establish a session via the API, then confirm the chat UI actually renders.
 *
 *   node e2e/authed-chat.mjs [baseURL]
 */
import { chromium } from "playwright";

import { attachDiagnostics, finish } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const stamp = Date.now();
const USER = { email: `authed${stamp}@example.com`, name: `Authed ${stamp}`, password: "SmokeTest!2345" };

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: BASE });
const page = await context.newPage();
const diagnostics = attachDiagnostics(page, { baseURL: BASE });

// Register through the app's own auth route, so the browser holds the cookies.
const signUp = await context.request.post("/api/auth/sign-up/email", {
    data: { email: USER.email, name: USER.name, password: USER.password },
    headers: { "Content-Type": "application/json", Origin: BASE, "x-captcha-response": "X.D.T" },
});

console.log(`sign-up: ${String(signUp.status())}`);

await page.goto("/chat", { timeout: 60_000, waitUntil: "domcontentloaded" });

// Wait for the composer, not a stopwatch: the chat shell paints well before the
// authenticated tree does, and a fixed sleep reports "no composer" on any run
// that is a second slower than usual.
await page
    .locator('textarea, [contenteditable="true"]')
    .first()
    .waitFor({ state: "visible", timeout: 45_000 })
    .catch(() => {});
await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
await page.screenshot({ path: "/tmp/authed-chat.png" });

const body = await page.evaluate(() => (document.body.textContent ?? "").replaceAll(/\s+/g, " ").slice(0, 900));

console.log(`\nurl: ${page.url()}`);
console.log(
    body
        .split("\n")
        .filter(Boolean)
        .slice(0, 22)
        .map((line) => `   ${line}`)
        .join("\n"),
);

const composers = await page.locator('textarea, [contenteditable="true"]').count();
const sessionStatus = (await context.request.get("/api/auth/get-session")).status();

console.log(`\ncomposer inputs: ${String(composers)}`);
console.log(`get-session:     ${String(sessionStatus)}`);

await finish(browser, page, diagnostics, [
    signUp.status() === 200 ? null : `sign-up returned ${String(signUp.status())}`,
    composers > 0 ? null : "no composer on /chat",
    sessionStatus === 200 ? null : `get-session returned ${String(sessionStatus)}`,
]);
