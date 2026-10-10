import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compareStrings } from "./collections";
import { displayUrlExpiresInSeconds, toStorageRef } from "./storage-ref";
import { collectStrings, isUrlFieldName, mapStrings, trySign } from "./storage-sign";
import { signUrlFieldsForDisplay } from "./stored-url-fields";

const ORIGIN = "http://localhost:8788";
const KEY = `agent-files/${"c".repeat(64)}`;

describe("mapStrings", () => {
    const tree = { content: "text", imageUrls: ["a", { note: "b" }], nested: { maskUrl: "c" }, url: "d" };

    it("visits every string without a selector", () => {
        expect(collectStrings(tree).toSorted(compareStrings)).toEqual(["a", "b", "c", "d", "text"]);
        expect(mapStrings("root", (text) => text.toUpperCase())).toBe("ROOT");
    });

    it("visits only URL-named fields (and arrays under them) with the URL selector", () => {
        expect(collectStrings(tree, isUrlFieldName).toSorted(compareStrings)).toEqual(["a", "c", "d"]);
        expect(mapStrings("root", (text) => text.toUpperCase(), isUrlFieldName)).toBe("root");
    });
});

describe("trySign", () => {
    it("returns null when the storage getter throws or signing rejects", async () => {
        expect(
            await trySign(
                () => {
                    throw new Error("no storage bound");
                },
                KEY,
                60,
            ),
        ).toBeNull();
        expect(
            await trySign(
                {
                    getSignedUrl: async () => {
                        throw new Error("boom");
                    },
                },
                KEY,
                60,
            ),
        ).toBeNull();
    });
});

describe("signUrlFieldsForDisplay", () => {
    beforeEach(() => {
        vi.stubEnv("PUBLIC_ORIGIN", ORIGIN);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("signs references in URL fields with a query-stable expiry, once per key, and leaves text alone", async () => {
        const getSignedUrl = vi.fn(async (key: string) => `${ORIGIN}/${key}?sig=fresh`);
        const ref = toStorageRef(KEY);
        const value = { imageUrl: ref, nodes: [{ content: ref, url: ref }] };

        expect(
            await signUrlFieldsForDisplay(() => {
                return { getSignedUrl };
            }, value),
        ).toEqual({
            imageUrl: `${ORIGIN}/${KEY}?sig=fresh`,
            nodes: [{ content: ref, url: `${ORIGIN}/${KEY}?sig=fresh` }],
        });
        expect(getSignedUrl).toHaveBeenCalledTimes(1);

        const [, options] = getSignedUrl.mock.calls[0] as unknown as [string, { expiresInSeconds: number }];

        // Bucketed: the same window yields the same expiry (±1s for a second boundary).
        expect(Math.abs(options.expiresInSeconds - displayUrlExpiresInSeconds())).toBeLessThanOrEqual(1);
    });

    it("returns the value as stored when no storage is bound", async () => {
        const value = { url: toStorageRef(KEY) };

        expect(
            await signUrlFieldsForDisplay(() => {
                throw new Error("no storage bound");
            }, value),
        ).toEqual(value);
    });

    it("passes null and undefined through", async () => {
        const getSignedUrl = vi.fn();

        expect(await signUrlFieldsForDisplay({ getSignedUrl }, null)).toBeNull();
        expect(await signUrlFieldsForDisplay({ getSignedUrl }, undefined)).toBeUndefined();
        expect(getSignedUrl).not.toHaveBeenCalled();
    });
});
