import { describe, expect, it } from "vitest";

import { matchProjectHint } from "./project-hint-match";

const billing = { _id: "p-billing", title: "Billing" };
const garden = { _id: "p-garden", title: "Garden" };

const billingThread = { projectId: "p-billing", status: "active", title: "Invoice export as CSV" };

describe("matchProjectHint", () => {
    it("matches a project through a recent thread of it whose title shares the draft words", () => {
        // "invoice export" does not name Billing; the Billing thread's title carries both words.
        expect(matchProjectHint("invoice export", [billing, garden], [billingThread])).toBe(billing);
    });

    it("does not match on the project name alone when the draft does not say it", () => {
        expect(matchProjectHint("invoice export", [billing], [])).toBeNull();
    });

    it("matches a project whose name is in the draft", () => {
        expect(matchProjectHint("billing run for March", [billing, garden], [])).toBe(billing);
    });

    it("needs two draft words in a thread title, so one shared word is not enough", () => {
        expect(matchProjectHint("invoice question", [billing], [billingThread])).toBeNull();
    });

    it("accepts one matching word when the draft has only one", () => {
        expect(matchProjectHint("invoice", [billing], [billingThread])).toBe(billing);
    });

    it("ignores archived threads", () => {
        const archived = { ...billingThread, status: "archived" };

        expect(matchProjectHint("invoice export", [billing], [archived])).toBeNull();
    });

    it("ignores threads outside any project", () => {
        const loose = { projectId: undefined, status: "active", title: "Invoice export as CSV" };

        expect(matchProjectHint("invoice export", [billing], [loose])).toBeNull();
    });

    it("never matches a workflow project", () => {
        const workflow = { _id: "p-flow", projectType: "workflow", title: "Billing" };

        expect(matchProjectHint("billing", [workflow], [])).toBeNull();
    });

    it("returns null for a draft with only short or common words", () => {
        expect(matchProjectHint("hi, can you help?", [billing], [billingThread])).toBeNull();
        expect(matchProjectHint("", [billing], [billingThread])).toBeNull();
    });

    it("prefers the project whose thread hits more draft words", () => {
        const exports = { _id: "p-exports", title: "Exports" };
        const exportThread = { projectId: "p-exports", status: "active", title: "Invoice export CSV" };
        const billingExport = { projectId: "p-billing", status: "active", title: "Invoice export" };

        // Draft "invoice export csv": Billing's thread hits two words, Exports' thread hits three.
        expect(matchProjectHint("invoice export csv", [billing, exports], [billingExport, exportThread])).toBe(exports);
    });
});
