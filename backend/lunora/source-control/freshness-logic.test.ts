import { describe, expect, it } from "vitest";

import {
    cachedRequestsOf,
    enteredRequests,
    MAX_CACHED_REQUESTS,
    nextPollDelay,
    POLL_INTERVAL_MS,
    POLL_INTERVAL_WITH_WEBHOOK_MS,
    requestDedupeKey,
    WEBHOOK_TRUST_MS,
} from "./freshness-logic";

const request = (number: number, updatedAt = 1000) => {
    return { authorLogin: "alice", number, title: `Pull ${number}`, updatedAt, url: `https://github.com/o/r/pull/${number}` };
};

describe("enteredRequests", () => {
    it("is the requests that were not in the list before", () => {
        expect(enteredRequests([request(1)], [request(1), request(2)]).map((entry) => entry.number)).toEqual([2]);
    });

    it("is nothing when the list shrank or is the same", () => {
        expect(enteredRequests([request(1), request(2)], [request(2)])).toEqual([]);
        expect(enteredRequests([request(1)], [request(1, 5000)])).toEqual([]);
    });

    it("counts a request that left and came back as new", () => {
        expect(enteredRequests([], [request(3)]).map((entry) => entry.number)).toEqual([3]);
    });
});

describe("requestDedupeKey", () => {
    it("names the host, the repository, the number and the version of the pull request", () => {
        expect(requestDedupeKey("https://github.com", "o/r", request(7, 42))).toBe("review-request:https://github.com:o/r#7:42");
    });

    it("differs for a later request on the same pull request", () => {
        expect(requestDedupeKey("h", "o/r", request(7, 1))).not.toBe(requestDedupeKey("h", "o/r", request(7, 2)));
    });
});

describe("cachedRequestsOf", () => {
    it("keeps the fields the cache stores and bounds the list and the text", () => {
        const many = Array.from({ length: MAX_CACHED_REQUESTS + 10 }, (_, index) => {
            return { ...request(index + 1), commentCount: 3, draft: false, labels: ["x"], repository: "o/r", title: "t".repeat(1000) };
        });
        const kept = cachedRequestsOf(many);

        expect(kept).toHaveLength(MAX_CACHED_REQUESTS);
        expect(Object.keys(kept[0]!).toSorted((a, b) => a.localeCompare(b))).toEqual(["authorLogin", "number", "title", "updatedAt", "url"]);
        expect(kept[0]!.title.length).toBeLessThan(400);
    });
});

describe("nextPollDelay", () => {
    const now = 1_000_000_000;

    it("polls at the ordinary pace after a good poll", () => {
        expect(nextPollDelay("ok", { now, webhookSeenAt: 0 })).toBe(POLL_INTERVAL_MS);
    });

    it("polls less often while a webhook has been heard from recently, but still polls", () => {
        expect(nextPollDelay("ok", { now, webhookSeenAt: now - 1000 })).toBe(POLL_INTERVAL_WITH_WEBHOOK_MS);
        expect(nextPollDelay("ok", { now, webhookSeenAt: now - WEBHOOK_TRUST_MS - 1 })).toBe(POLL_INTERVAL_MS);
    });

    it("backs off after a failure, longer when only the person can fix it", () => {
        expect(nextPollDelay("rate_limited", { now, webhookSeenAt: 0 })).toBeGreaterThan(POLL_INTERVAL_MS);
        expect(nextPollDelay("needs_reconnect", { now, webhookSeenAt: 0 })).toBeGreaterThan(nextPollDelay("host_error", { now, webhookSeenAt: 0 }));
    });
});
