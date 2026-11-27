import { describe, expect, it } from "vitest";

import linkTarget from "./link-target";

describe("linkTarget", () => {
    it("leaves a plain path alone", () => {
        expect(linkTarget("/chat/thread-1")).toEqual({ to: "/chat/thread-1" });
    });

    it("opens a settings page as the settings modal over the current page, keeping its search", () => {
        const target = linkTarget("/dashboard/settings/chat/triggers");

        expect(target.to).toBe(".");
        expect(typeof target.search).toBe("function");
        expect((target.search as (previous: Record<string, unknown>) => Record<string, unknown>)({ q: "x" })).toEqual({
            q: "x",
            settings: true,
            settingsTab: "chat-triggers",
        });
    });

    it("hands a settings link's fragment to the modal as the place to scroll to", () => {
        const target = linkTarget("/dashboard/settings/auth/account#daily-brief");

        expect((target.search as (previous: Record<string, unknown>) => Record<string, unknown>)({})).toMatchObject({
            settingsAnchor: "daily-brief",
            settingsTab: "auth-account",
        });
    });

    it("decodes an encoded fragment, so the modal finds the element it names", () => {
        const target = linkTarget("/dashboard/settings/app/personalization#voice-mode%2Dvoice");

        expect((target.search as (previous: Record<string, unknown>) => Record<string, unknown>)({})).toMatchObject({
            settingsAnchor: "voice-mode-voice",
        });
    });

    it("splits a query into search params, decoded, so the router receives them as search and not as part of the path", () => {
        expect(linkTarget("/develop?repository=octo%2Fhello&number=7")).toEqual({ search: { number: "7", repository: "octo/hello" }, to: "/develop" });
    });

    it("keeps the first of a repeated key and drops a fragment", () => {
        expect(linkTarget("/develop?number=7&number=8#top")).toEqual({ search: { number: "7" }, to: "/develop" });
    });
});
