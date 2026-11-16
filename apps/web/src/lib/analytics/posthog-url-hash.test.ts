/**
 * A guest link carries its bearer token in the URL fragment. PostHog writes the page address into its cookie and storage
 * (`$initial_person_info`, session properties) before any event, out of `before_send`'s reach: with the app's own options,
 * the token must be in none of them, nor in an event.
 */
import type { CaptureResult } from "posthog-js";
import { posthog } from "posthog-js";
import { describe, expect, it, vi } from "vitest";

import { POSTHOG_OPTIONS } from "@/providers/analytics-provider";

vi.mock("@c15t/react", () => {
    return {
        useEffectivePermissions: () => {
            return { measurement: true };
        },
    };
});

const TOKEN = "ab".repeat(32);

describe("PostHog on a guest link", () => {
    it("keeps the link token out of its cookie, its storage and its events", async () => {
        const events: CaptureResult[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response("{}")),
        );
        globalThis.history.replaceState(null, "", `/guest#${TOKEN}`);

        posthog.init("phc_test", {
            ...POSTHOG_OPTIONS,
            api_host: "https://posthog.test",
            before_send: (event) => {
                const sent = POSTHOG_OPTIONS.before_send(event);

                if (sent) {
                    events.push(sent);
                }

                return sent;
            },
        });
        // As the app does once measurement consent is given (`PostHogConsentSync`).
        posthog.opt_in_capturing();
        posthog.capture("probe");
        await vi.waitFor(() => {
            expect(events.length).toBeGreaterThan(0);
        });

        const stored = [
            document.cookie,
            JSON.stringify({ ...globalThis.localStorage }),
            JSON.stringify({ ...globalThis.sessionStorage }),
            JSON.stringify(events),
        ];

        expect(stored.join("\n")).not.toContain(TOKEN);
        vi.unstubAllGlobals();
    });
});
