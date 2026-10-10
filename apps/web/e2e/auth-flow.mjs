/**
 * The whole user-visible auth loop, through the real forms: register -> land in
 * chat as that user -> sign out -> sign back in.
 *
 * Deliberately does NOT create the session over the API — that path proves the
 * backend works but skips every form, redirect and client-side auth transition,
 * which is where this app kept breaking.
 *
 *   node e2e/auth-flow.mjs [baseURL]
 */
import { chromium } from "playwright";

import { attachDiagnostics, fill, finish, openAuthPage, submitAndWait } from "./harness.mjs";

const BASE = process.argv[2] ?? "http://localhost:5173";
const stamp = Date.now();
const USER = { email: `flow${stamp}@example.com`, name: `Flow ${stamp}`, password: "FlowTest!2345" };

const browser = await chromium.launch();
const page = await (await browser.newContext({ baseURL: BASE })).newPage();
const diagnostics = attachDiagnostics(page, { baseURL: BASE });

const body = async () => page.evaluate(() => (document.body.textContent ?? "").replaceAll(/\s+/g, " ").slice(0, 1200));

/**
 * Dismiss the cookie-consent banner if it is up.
 *
 * Not cosmetic: the banner is an overlay, so until it is dismissed it swallows
 * the click on "Sign Up" and the form never submits — which reads exactly like
 * broken registration.
 *
 * The wait is on the button, not a stopwatch: it returns the moment the banner
 * animates in, and the (short) timeout is only the "no banner on this page"
 * case, where there is nothing to wait for at all.
 */
// ---------------------------------------------------------------- register
await openAuthPage(page, "/auth/sign-up");

const nameField = page.locator('input[placeholder*="name" i]').first();

if (await nameField.count()) await nameField.fill(USER.name);

await fill(page, "input[type=email]", USER.email);

const passwords = page.locator("input[type=password]");

for (let index = 0; index < (await passwords.count()); index += 1) await passwords.nth(index).fill(USER.password);

// Wait on the request itself, not on a stopwatch: a fixed timeout silently
// reports "registration failed" whenever the page is a second slower than usual.
const signUpStatus = await submitAndWait(page, "/api/auth/sign-up/email");

// Where sign-up lands you is logged, not asserted, so this wait is short and
// optional — the load-bearing signal is the response status above.
await page.waitForURL((url) => !url.pathname.includes("/sign-up"), { timeout: 8000 }).catch(() => {});

console.log(`register -> ${String(signUpStatus)} -> ${page.url()}`);

// --------------------------------------------------------------- sign out
// Sign-up redirects to the sign-in page rather than logging you straight in, so
// there is nothing authenticated to look at yet — /chat is measured after the
// sign-in below. Sign out anyway, so the sign-in is a real one.
await page.evaluate(async () => {
    await fetch("/api/auth/sign-out", { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST" });
});

// ---------------------------------------------------------------- sign in
await openAuthPage(page, "/auth/sign-in");
await fill(page, "input[type=email]", USER.email);
await fill(page, "input[type=password]", USER.password);

const signInStatus = await submitAndWait(page, "/api/auth/sign-in/email");

// Same again: logged, not asserted. The app does not always leave /auth/sign-in
// on its own, so this legitimately runs out — hence the short bound.
await page.waitForURL((url) => !url.pathname.includes("/sign-in"), { timeout: 8000 }).catch(() => {});

const afterSignInUrl = page.url();

await page.goto("/chat", { timeout: 45_000, waitUntil: "domcontentloaded" });

// Wait for the composer rather than a stopwatch — the chat shell paints well
// before the authenticated tree does.
const composer = page.locator('textarea, [contenteditable="true"]').first();

await composer.waitFor({ state: "visible", timeout: 45_000 }).catch(() => {});

// The greeting is the last thing to resolve (it needs the session query), and it
// is one of the checks below, so wait for the text itself instead of guessing.
await page.waitForFunction((name) => (document.body.textContent ?? "").includes(name), USER.name.split(" ", 1)[0], { timeout: 20_000 }).catch(() => {});

const finalText = await body();
const composers = await page.locator('textarea, [contenteditable="true"]').count();
const chatUrl = page.url();
const sessionUser = await page.evaluate(async () => {
    const response = await fetch("/api/auth/get-session", { headers: { "Content-Type": "application/json" } });

    if (!response.ok) return `HTTP ${String(response.status)}`;

    const data = await response.json().catch(() => null);

    return data?.user ? `${data.user.email} (anonymous: ${String(data.user.isAnonymous)})` : "no user";
});

await page.screenshot({ path: "/tmp/auth-flow-final.png" });

const shows = (haystack, needle) => (haystack.toLowerCase().includes(needle.toLowerCase()) ? "yes" : "NO");

console.log(`sign-in  -> ${String(signInStatus)} -> ${afterSignInUrl}`);
console.log("");
console.log(`registered email in session:  ${sessionUser}`);
console.log(`chat composer present:        ${composers > 0 ? `yes (${String(composers)})` : "NO"}`);
console.log(`chat url:                     ${chatUrl}`);
console.log(`chat body:                    ${finalText.slice(0, 400)}`);
console.log(`chat greets by name:          ${shows(finalText, USER.name.split(" ", 1)[0])}`);
console.log(`still "Anonymous" after auth: ${shows(finalText, "Hello Anonymous")}`);

// Exit non-zero when a check fails. `AGENTS.md` points at this script as the
// verification loop for the runtime lessons, and a loop that always exits 0
// verifies nothing — every earlier failure here was noticed only by a human
// reading the output.
await finish(browser, page, diagnostics, [
    signUpStatus === 200 ? null : `sign-up returned ${String(signUpStatus)}`,
    signInStatus === 200 ? null : `sign-in returned ${String(signInStatus)}`,
    composers > 0 ? null : "no composer on /chat",
    sessionUser.includes(USER.email) ? null : `session is not the registered user (${sessionUser})`,
]);

console.log(`\ncredentials: ${USER.email} / ${USER.password}`);
