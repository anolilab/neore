import { describe, expect, it } from "vitest";

import { posthogAppHost } from "./posthog-host";

describe(posthogAppHost, () => {
    it("moves an ingestion host to the app host of its region", () => {
        expect(posthogAppHost("https://eu.i.posthog.com/")).toBe("https://eu.posthog.com");
        expect(posthogAppHost("https://us.i.posthog.com")).toBe("https://us.posthog.com");
    });

    it("defaults to the US region and leaves other hosts alone", () => {
        expect(posthogAppHost(undefined)).toBe("https://us.posthog.com");
        expect(posthogAppHost("https://ph.example.com/")).toBe("https://ph.example.com");
    });
});
