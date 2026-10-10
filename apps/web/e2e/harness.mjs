/**
 * Shared plumbing for the hand-run Playwright drivers in this directory
 * (`auth-flow.mjs`, `authed-chat.mjs`).
 *
 * These used to carry a copy each of the listener block, the teardown and the
 * report, and the copies had already drifted apart — the RPC-name regex matched
 * different keys in each file, so the same failure printed a function path in
 * one driver and `?` in the other. One copy here, everyone gets the fixes.
 */

const CORS_RE = /cors/i;
const AUTH_ENDPOINT_RE = /\/api\/auth\/(?:sign-in|sign-out|sign-up)/;
const RPC_FUNCTION_RE = /"(?:functionPath|path|name)":"([^"]+)"/;
const ACCEPT_ALL_RE = /accept all/i;

/**
 * Record everything that goes wrong on `page`: console errors, uncaught page
 * errors, network-level failures, CORS rejections, failed RPCs, and every
 * `/api/auth/*` round trip.
 *
 * Returns the (live) buckets — read them after the run, or hand them to
 * `report`.
 * @param {import("playwright").Page} page
 * @param {{ baseURL?: string }} [options] `baseURL` is only stripped from the
 *   logged auth URLs, to keep the report narrow.
 */
export const attachDiagnostics = (page, { baseURL = "" } = {}) => {
    /** @type {{ auth: string[], cors: string[], errors: string[], failed: string[], pageErrors: string[], rpc: string[] }} */
    const diagnostics = { auth: [], cors: [], errors: [], failed: [], pageErrors: [], rpc: [] };

    page.on("console", (message) => {
        if (message.type() === "error") diagnostics.errors.push(message.text().slice(0, 200));
    });

    page.on("pageerror", (error) => {
        diagnostics.pageErrors.push(String(error).slice(0, 300));
    });

    page.on("requestfailed", (request) => {
        const failure = request.failure()?.errorText ?? "";
        const entry = `${request.method()} ${request.url().slice(0, 110)} — ${failure}`;

        diagnostics.failed.push(entry);

        if (CORS_RE.test(failure)) diagnostics.cors.push(entry);
    });

    page.on("response", async (response) => {
        const url = response.url();
        const status = response.status();
        const bodyText = async (limit) => (status >= 400 ? (await response.text().catch(() => "")).slice(0, limit) : "");

        if (AUTH_ENDPOINT_RE.test(url)) {
            const detail = await bodyText(160);

            diagnostics.auth.push(`${String(status)} ${url.replace(baseURL, "")}${detail ? ` — ${detail}` : ""}`);
        }

        if (status < 400) return;

        diagnostics.failed.push(`${String(status)} ${response.request().method()} ${url.slice(0, 110)}`);

        if (!url.includes("_lunora/rpc")) return;

        // Lunora has spelled the callee under more than one key; try them all
        // rather than printing `?` for a failure you then cannot locate.
        const sent = response.request().postData() ?? "";
        const function_ = RPC_FUNCTION_RE.exec(sent)?.[1] ?? (sent.slice(0, 80) || "?");

        diagnostics.rpc.push(`${String(status)} ${function_} — ${await bodyText(160)}`);
    });

    return diagnostics;
};

/**
 * Print the diagnostics tail and decide the exit code.
 *
 * `checks` is a list of failure strings (falsy = the check passed), so a driver
 * writes `composers > 0 ? null : "no composer on /chat"`. CORS and RPC failures
 * are added here, because they fail every driver the same way.
 *
 * A driver that always exits 0 verifies nothing, so anything in the combined
 * list sets `process.exitCode = 1`.
 * @param {ReturnType<typeof attachDiagnostics>} diagnostics
 * @param {(string | null | undefined | false)[]} [checks]
 */
export const report = (diagnostics, checks = []) => {
    const section = (title, items, limit = 8) => {
        console.log(`${title}: ${items.length}`);
        [...new Set(items)].slice(0, limit).forEach((item) => console.log(`   ${item}`));
    };

    console.log("");
    section("auth requests  ", diagnostics.auth);
    section("CORS failures  ", diagnostics.cors);
    section("RPC failures   ", diagnostics.rpc);
    section("console errors ", diagnostics.errors);
    section("page errors    ", diagnostics.pageErrors);
    section("failed requests", diagnostics.failed);

    const failures = [
        ...checks,
        diagnostics.cors.length === 0 ? null : `${String(diagnostics.cors.length)} CORS failure(s)`,
        diagnostics.rpc.length === 0 ? null : `${String(diagnostics.rpc.length)} failed RPC(s)`,
    ].filter(Boolean);

    if (failures.length > 0) {
        console.log(`\nFAILED: ${failures.join("; ")}`);
        process.exitCode = 1;
    } else {
        console.log("\nOK");
    }

    return failures;
};

/**
 * Let in-flight requests settle before tearing the browser down. Closing on top
 * of them makes wrangler's dev proxy raise "Network connection lost." as a fatal
 * error event and take the whole backend process with it.
 * @param {import("playwright").Browser} browser
 * @param {import("playwright").Page} page
 */
export const settleAndClose = async (browser, page) => {
    // Bounded: the chat shell holds an open stream, so `networkidle` never
    // fires there and the default 30s timeout would be pure dead time.
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    // `networkidle` does not track WebSocket/EventSource traffic, and the chat
    // shell holds an open stream — there is no event to wait on for those, so
    // this is the one genuine stopwatch in the harness. Kept at the original
    // 1.5s: the failure it prevents kills the backend process, which is a far
    // worse outcome than a second of wall clock.
    await page.waitForTimeout(1500);
    await browser.close();
};

/**
 * Dismiss the cookie-consent banner if it is up.
 *
 * Not cosmetic: the banner is an overlay, so until it is dismissed it swallows
 * the click on a submit button and the form never posts — which reads exactly
 * like broken registration.
 * @param page
 */
export const acceptCookies = async (page) => {
    const accept = page.getByRole("button", { name: ACCEPT_ALL_RE }).first();
    const visible = await accept.waitFor({ state: "visible", timeout: 2500 }).then(
        () => true,
        () => false,
    );

    if (!visible) return;

    await accept.click();
    await accept.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
};

/**
 * Land on `path` and wait for its form to be USABLE, not merely visible.
 *
 * The auth pages are server-rendered, so the inputs paint before React attaches
 * the submit handler. A click in that window does nothing at all — no request,
 * no validation error — and the browser falls back to a native GET, which shows
 * up as a navigation to `/auth/sign-up?`. `networkidle` is the hydration signal.
 * @param page
 * @param path
 */
export const openAuthPage = async (page, path) => {
    await page.goto(path, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.locator("input[type=email]").first().waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await acceptCookies(page);
};

/**
 * Fill a field once it is visible.
 *
 * Base UI renders inputs with generated ids and no `name`, so type/placeholder
 * are the only stable handles.
 * @param page
 * @param selector
 * @param value
 */
export const fill = async (page, selector, value) => {
    const field = page.locator(selector).first();

    await field.waitFor({ state: "visible", timeout: 20_000 });
    await field.fill(value);
};

/**
 * Click submit and wait for `urlPart` to come back; returns its status, or 0.
 *
 * Retries, because the consent banner can re-appear after the fields are filled
 * and while it is up the click lands on the overlay and no request is ever made.
 * `manual-smoke.mjs` had no retry here and hit exactly that.
 * @param page
 * @param urlPart
 */
export const submitAndWait = async (page, urlPart) => {
    const submit = page.locator("button[type=submit]").first();

    for (let attempt = 0; attempt < 4; attempt += 1) {
        // `.catch` is attached immediately: if this attempt times out and the loop
        // moves on, an unattached rejection surfaces as an unhandled rejection and
        // kills the run instead of retrying.
        const response = page.waitForResponse((r) => r.url().includes(urlPart), { timeout: 20_000 }).catch(() => null);

        // `noWaitAfter` because submitting can schedule a navigation, and an HMR
        // reload mid-click leaves Playwright waiting on it indefinitely.
        await submit.click({ force: attempt > 0, noWaitAfter: true });

        const settled = await response;

        if (settled) return settled.status();

        await acceptCookies(page);
        await submit.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    }

    return 0;
};

/**
 * Settle, close, THEN report — in that order, always.
 *
 * Reporting first loses anything the listeners capture during the settle, and
 * one driver did exactly that. Making this a single call is what stops the
 * ordering being a decision each driver gets to make (and get wrong).
 * @param browser
 * @param page
 * @param diagnostics
 * @param checks
 */
export const finish = async (browser, page, diagnostics, checks = []) => {
    await settleAndClose(browser, page);
    report(diagnostics, checks);
};
