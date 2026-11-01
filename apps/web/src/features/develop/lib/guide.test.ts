import { describe, expect, it } from "vitest";

import { hostOffersFor, offerKey, rangeText } from "./guide";

const NOW = 1_000_000;
const OFFER = { agentKey: "claude", agentLabel: "Claude Code", folderId: "f1", folderLabel: "hello" };
const device = (over: Record<string, unknown> = {}) => {
    return { _id: "d1", acpOffers: [OFFER], lastSeenAt: NOW - 1000, name: "Laptop", ...over };
};

describe("hostOffersFor", () => {
    it("offers the pairs of an online computer whose folder names the repository", () => {
        expect(hostOffersFor([device()], "octo/hello", NOW)).toEqual([{ ...OFFER, deviceId: "d1", deviceName: "Laptop" }]);
    });

    it("offers nothing for another repository's folder, an offline computer or one that never reported", () => {
        expect(hostOffersFor([device()], "octo/another", NOW)).toEqual([]);
        expect(hostOffersFor([device({ lastSeenAt: NOW - 10 * 60_000 })], "octo/hello", NOW)).toEqual([]);
        expect(hostOffersFor([device({ lastSeenAt: undefined })], "octo/hello", NOW)).toEqual([]);
        expect(hostOffersFor([device({ acpOffers: undefined })], "octo/hello", NOW)).toEqual([]);
    });

    it("tells two offers apart by computer, agent and folder", () => {
        expect(offerKey({ agentKey: "a", deviceId: "d", folderId: "f" })).not.toBe(offerKey({ agentKey: "a", deviceId: "d", folderId: "g" }));
    });
});

describe("rangeText", () => {
    it("writes one line or a span", () => {
        expect(rangeText({ end: 4, start: 4 })).toBe("4");
        expect(rangeText({ end: 30, start: 12 })).toBe("12–30");
    });
});
