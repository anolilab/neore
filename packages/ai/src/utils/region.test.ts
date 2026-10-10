import { describe, expect, it } from "vitest";

import { getRegionFromHeaders, isEURegion, isEURequest } from "./region";

describe("isEURegion", () => {
    describe("EU member states", () => {
        it.each([
            "DE",
            "FR",
            "IT",
            "ES",
            "NL",
            "PL",
            "BE",
            "AT",
            "SE",
            "DK",
            "FI",
            "IE",
            "PT",
            "GR",
            "CZ",
            "RO",
            "HU",
            "BG",
            "HR",
            "SK",
            "SI",
            "LT",
            "LV",
            "EE",
            "CY",
            "LU",
            "MT",
        ])("should return true for EU country: %s", (code) => {
            expect(isEURegion(code)).toBe(true);
        });
    });

    describe("EEA countries", () => {
        it.each(["IS", "LI", "NO"])("should return true for EEA country: %s", (code) => {
            expect(isEURegion(code)).toBe(true);
        });
    });

    describe("other GDPR territories", () => {
        it.each(["GB", "UK", "CH"])("should return true for GDPR territory: %s", (code) => {
            expect(isEURegion(code)).toBe(true);
        });
    });

    describe("non-EU countries", () => {
        it.each(["US", "CN", "JP", "AU", "BR", "IN", "RU", "CA", "MX", "KR"])("should return false for non-EU country: %s", (code) => {
            expect(isEURegion(code)).toBe(false);
        });
    });

    it("should handle case-insensitive codes", () => {
        expect(isEURegion("de")).toBe(true);
        expect(isEURegion("De")).toBe(true);
        expect(isEURegion("us")).toBe(false);
    });

    it("should return false for null/undefined", () => {
        expect(isEURegion(null)).toBe(false);
        expect(isEURegion(undefined)).toBe(false);
    });

    it("should return false for empty string", () => {
        expect(isEURegion("")).toBe(false);
    });

    describe("French territories", () => {
        it.each(["RE", "GP", "MQ", "GF", "YT"])("should return true for French territory: %s", (code) => {
            expect(isEURegion(code)).toBe(true);
        });
    });

    describe("UK territories", () => {
        it.each(["GI", "GG", "JE", "IM"])("should return true for UK territory: %s", (code) => {
            expect(isEURegion(code)).toBe(true);
        });
    });
});

describe("getRegionFromHeaders", () => {
    it("should extract from Cloudflare header", () => {
        expect(getRegionFromHeaders({ "cf-ipcountry": "DE" })).toBe("DE");
    });

    it("should extract from Vercel header", () => {
        expect(getRegionFromHeaders({ "x-vercel-ip-country": "FR" })).toBe("FR");
    });

    it("should extract from generic header", () => {
        expect(getRegionFromHeaders({ "x-country-code": "IT" })).toBe("IT");
    });

    it("should extract from CloudFront header", () => {
        expect(getRegionFromHeaders({ "cloudfront-viewer-country": "ES" })).toBe("ES");
    });

    it("should extract from App Engine header", () => {
        expect(getRegionFromHeaders({ "x-appengine-country": "NL" })).toBe("NL");
    });

    it("should return null when no country header found", () => {
        expect(getRegionFromHeaders({})).toBeNull();
        expect(getRegionFromHeaders({ "content-type": "text/html" })).toBeNull();
    });

    it("should ignore values longer than 2 characters", () => {
        expect(getRegionFromHeaders({ "cf-ipcountry": "DEU" })).toBeNull();
    });

    it("should uppercase the result", () => {
        expect(getRegionFromHeaders({ "cf-ipcountry": "de" })).toBe("DE");
    });

    it("should prioritize Cloudflare header first", () => {
        const headers = {
            "cf-ipcountry": "DE",
            "x-vercel-ip-country": "FR",
        };

        expect(getRegionFromHeaders(headers)).toBe("DE");
    });
});

describe("isEURequest", () => {
    it("should return true for EU request", () => {
        expect(isEURequest({ "cf-ipcountry": "DE" })).toBe(true);
    });

    it("should return false for non-EU request", () => {
        expect(isEURequest({ "cf-ipcountry": "US" })).toBe(false);
    });

    it("should return false when no headers present", () => {
        expect(isEURequest({})).toBe(false);
    });
});
