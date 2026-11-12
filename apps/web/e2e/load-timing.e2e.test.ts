/**
 * Load-timing benchmark for a signed-in user — a measurement, not a test, so it runs only with `E2E_LOAD_TIMING=1`.
 *
 * Measures, from navigation start, on a load of `/chat/<thread>`: the composer visible, the sidebar thread list
 * visible with rows, the thread's messages visible, FCP and LCP; and thread-switch time (sidebar click → the other
 * thread's messages visible) to a thread first opened in this page and back to one already shown. Each run is a
 * fresh browser context (cold: empty HTTP cache, no service worker) followed by a reload in it (warm), unthrottled and
 * with a Fast 3G-like profile set over CDP. Prints the medians as a markdown table.
 *
 * Point it at a PRODUCTION build to compare builds: `vite build && node scripts/generate-sw.mjs` in apps/web, serve
 * it with `pnpm exec vite preview --port 5173`, then from apps/web:
 *
 *     E2E_LOAD_TIMING=1 LOAD_TIMING_LABEL=after LOAD_TIMING_STATE=~/.cache/load-timing-user.json \
 *       pnpm exec playwright test load-timing --project=chromium --no-deps
 *
 * Seeding sends three messages, and `vite preview` does not proxy `/llm-gateway` (the Cloudflare plugin answers
 * first), so seed once against `pnpm dev:app`, or put a small proxy on :5173 that sends `/llm-gateway/*` to :8787.
 * Measuring needs no gateway. On a busy machine, alternate the builds run by run (`LOAD_TIMING_RUNS=1` in a loop):
 * two back-to-back blocks pick up the machine's drift, not the builds' difference.
 *
 * `LOAD_TIMING_STATE` keeps the seeded user (session + thread ids) so a second build is measured on the same data;
 * the first run creates it. `LOAD_TIMING_RUNS` (default 7) sets the runs per profile; `LOAD_TIMING_OUT` writes JSON.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Browser, BrowserContext, Page } from "@playwright/test";

import { completeOnboarding, contextPoster, expect, expectAssistantReply, freshUser, sendMessage, test, trackBackendRequests } from "./chat-helpers";
import { APP_BASE_URL } from "./fixtures";
import { signUpInvited } from "./seed";

const ENABLED = process.env.E2E_LOAD_TIMING === "1";
const RUNS = Number(process.env.LOAD_TIMING_RUNS) || 7;
const LABEL = process.env.LOAD_TIMING_LABEL ?? "build";
const STATE_FILE = process.env.LOAD_TIMING_STATE;
const MILESTONE_TIMEOUT_MS = 90_000;
const THREAD_URL_RE = /\/chat\/[\w-]+$/;

/** Chrome DevTools' legacy "Fast 3G" with Lighthouse's 0.9 factor: 562.5ms RTT, ~1.44 Mbps down, ~675 Kbps up. */
const FAST_3G = { downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8, latency: 562.5, offline: false, uploadThroughput: (750 * 1024 * 0.9) / 8 };
const PROFILES = ["unthrottled", "fast-3g"] as const;

interface SeededThread {
    id: string;
    marker: string;
}

interface Seed {
    storageState: Awaited<ReturnType<BrowserContext["storageState"]>>;
    threads: [SeededThread, SeededThread, SeededThread];
}

interface LoadSample {
    composer?: number;
    fcp?: number;
    lcp?: number;
    messages?: number;
    sidebar?: number;
    switchCached?: number;
    switchUncached?: number;
}

/**
 * Runs before the app's own scripts: marks (`load-probe:<milestone>`), per animation frame, when each milestone first
 * shows. A frame callback runs just before that frame paints, so the mark is the paint that shows it.
 */
const installProbe = ({ marker }: { marker: string }): void => {
    const seen = new Set<string>();
    const shown = (element: Element): boolean => element.getClientRects().length > 0;
    const check = (name: string, visible: () => boolean): void => {
        if (seen.has(name) || !visible()) {
            return;
        }

        seen.add(name);
        performance.mark(`load-probe:${name}`);
    };
    const tick = (): void => {
        check("composer", () => [...document.querySelectorAll('.tiptap[contenteditable="true"]')].some((element) => shown(element)));
        check("sidebar", () => [...document.querySelectorAll("[data-thread-id]")].some((row) => shown(row)));
        check("messages", () =>
            [...document.querySelectorAll('.message-item[data-message-role="user"]')].some(
                (message) => shown(message) && (message.textContent ?? "").includes(marker),
            ),
        );

        if (seen.size < 3) {
            requestAnimationFrame(tick);
        }
    };

    requestAnimationFrame(tick);
};

const readLoad = async (page: Page): Promise<LoadSample> => {
    await expect
        .poll(async () => await page.evaluate(() => performance.getEntriesByType("mark").filter((mark) => mark.name.startsWith("load-probe:")).length), {
            timeout: MILESTONE_TIMEOUT_MS,
        })
        .toBe(3);

    return await page.evaluate(async () => {
        const at = (name: string): number | undefined => performance.getEntriesByName(`load-probe:${name}`, "mark")[0]?.startTime;
        // The buffered entries arrive in the first callback; LCP stops updating at the first input, so the last one is final.
        const lcp = await new Promise<number | undefined>((resolve) => {
            try {
                const observer = new PerformanceObserver((list) => {
                    observer.disconnect();
                    resolve(list.getEntries().at(-1)?.startTime);
                });

                observer.observe({ buffered: true, type: "largest-contentful-paint" });
                setTimeout(() => {
                    resolve(undefined);
                }, 1000);
            } catch {
                resolve(undefined);
            }
        });

        return {
            composer: at("composer"),
            fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime,
            lcp,
            messages: at("messages"),
            sidebar: at("sidebar"),
        };
    });
};

/** Click the sidebar row of `thread` from inside the page and time until its messages show. */
const timeSwitch = async (page: Page, thread: SeededThread): Promise<number> => {
    await page.locator(`[data-thread-id="${thread.id}"] a`).first().waitFor({ state: "visible", timeout: MILESTONE_TIMEOUT_MS });

    const elapsed = await page.evaluate(
        async ({ id, marker, timeoutMs }) =>
            await new Promise<number | null>((resolve) => {
                const link = document.querySelector<HTMLAnchorElement>(`[data-thread-id="${CSS.escape(id)}"] a`);

                if (!link) {
                    resolve(null);

                    return;
                }

                const start = performance.now();
                const tick = (): void => {
                    const hit = [...document.querySelectorAll('.message-item[data-message-role="user"]')].some(
                        (message) => message.getClientRects().length > 0 && (message.textContent ?? "").includes(marker),
                    );

                    if (hit) {
                        resolve(performance.now() - start);
                    } else if (performance.now() - start > timeoutMs) {
                        resolve(null);
                    } else {
                        requestAnimationFrame(tick);
                    }
                };

                link.click();
                requestAnimationFrame(tick);
            }),
        { id: thread.id, marker: thread.marker, timeoutMs: MILESTONE_TIMEOUT_MS },
    );

    expect(elapsed, `switch to ${thread.id}`).not.toBeNull();

    return elapsed ?? NaN;
};

const seed = async (page: Page): Promise<Seed> => {
    if (STATE_FILE && existsSync(STATE_FILE)) {
        return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Seed;
    }

    await signUpInvited(freshUser("load-timing"), contextPoster(page));
    await completeOnboarding(page);

    const threads: SeededThread[] = [];

    for (const name of ["alpha", "bravo", "charlie"]) {
        const marker = `load-timing-${name}-${String(Date.now())}`;

        await page.goto("/chat");
        await sendMessage(page, `Hello ${marker}`);
        await page.waitForURL(THREAD_URL_RE, { timeout: 60_000 });
        await expectAssistantReply(page, marker);
        threads.push({ id: new URL(page.url()).pathname.split("/").at(-1) ?? "", marker });
    }

    const result: Seed = { storageState: await page.context().storageState(), threads: threads as Seed["threads"] };

    if (STATE_FILE) {
        writeFileSync(STATE_FILE, JSON.stringify(result));
    }

    return result;
};

const median = (values: (number | undefined)[]): number | undefined => {
    const sorted = values.filter((value): value is number => value !== undefined && Number.isFinite(value)).toSorted((a, b) => a - b);

    if (sorted.length === 0) {
        return undefined;
    }

    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** One run: a fresh context loads thread A cold, switches to B (uncached) and back to A (cached), reloads A warm, then C and A. */
const measureRun = async (browser: Browser, data: Seed, profile: (typeof PROFILES)[number]): Promise<{ cold: LoadSample; warm: LoadSample }> => {
    const [alpha, bravo, charlie] = data.threads;
    const context = await browser.newContext({ baseURL: APP_BASE_URL, locale: "en-US", storageState: data.storageState });
    const page = await context.newPage();
    const drain = trackBackendRequests(page);

    await page.addInitScript(installProbe, { marker: alpha.marker });

    if (profile === "fast-3g") {
        const cdp = await context.newCDPSession(page);

        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", FAST_3G);
    }

    try {
        await page.goto(`/chat/${alpha.id}`);

        const cold: LoadSample = await readLoad(page);

        cold.switchUncached = await timeSwitch(page, bravo);
        cold.switchCached = await timeSwitch(page, alpha);
        await drain();

        await page.goto(`/chat/${alpha.id}`);

        const warm: LoadSample = await readLoad(page);

        warm.switchUncached = await timeSwitch(page, charlie);
        warm.switchCached = await timeSwitch(page, alpha);
        await drain();

        return { cold, warm };
    } finally {
        await context.close();
    }
};

const METRICS: [keyof LoadSample, string][] = [
    ["fcp", "FCP"],
    ["lcp", "LCP"],
    ["composer", "Composer visible"],
    ["sidebar", "Sidebar list visible"],
    ["messages", "Thread messages visible"],
    ["switchUncached", "Switch to a thread not yet opened"],
    ["switchCached", "Switch back to an opened thread"],
];

test.describe("Load timing (benchmark)", () => {
    test.beforeEach(() => {
        // Conditional, not a disabled test: a benchmark that takes many minutes, run on request.
        test.skip(!ENABLED, "a benchmark: set E2E_LOAD_TIMING=1 to run it");
    });

    test("signed-in load and thread switch, cold and warm", async ({ browser, page }) => {
        // A benchmark of RUNS × 2 profiles × 2 loads, not a test: the suite's per-test budget does not apply.
        test.setTimeout(RUNS * 4 * 5 * 60_000);

        const data = await seed(page);
        const samples: Record<string, LoadSample[]> = {};

        // Profiles interleave within each run, so a slow stretch of the machine lands on both.
        for (let run = 0; run < RUNS; run += 1) {
            for (const profile of PROFILES) {
                const { cold, warm } = await measureRun(browser, data, profile);

                samples[`${profile} cold`] = [...(samples[`${profile} cold`] ?? []), cold];
                samples[`${profile} warm`] = [...(samples[`${profile} warm`] ?? []), warm];
            }
        }

        const columns = Object.keys(samples);

        expect(columns).toHaveLength(PROFILES.length * 2);
        const format = (value: number | undefined): string => (value === undefined ? "–" : String(Math.round(value)));
        const table = [
            `| ${LABEL} (median ms, n=${String(RUNS)}) | ${columns.join(" | ")} |`,
            `| --- | ${columns.map(() => "---:").join(" | ")} |`,
            ...METRICS.map(
                ([key, title]) => `| ${title} | ${columns.map((column) => format(median((samples[column] ?? []).map((sample) => sample[key])))).join(" | ")} |`,
            ),
        ].join("\n");

        console.log(`\n${table}\n`);
        await test.info().attach(`load-timing-${LABEL}`, { body: table });

        if (process.env.LOAD_TIMING_OUT) {
            writeFileSync(process.env.LOAD_TIMING_OUT, JSON.stringify({ label: LABEL, runs: RUNS, samples }, undefined, 2));
        }
    });
});
