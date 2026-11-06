import { MODEL_REGISTRY } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import type { LinkableModel } from "./prompt-link-model";
import { linkModelAppliesOnOpen } from "./prompt-link-model";

const text: LinkableModel = { id: "text-model", mode: "text", provider: "openai" };
const offered = (...entries: LinkableModel[]): ReadonlyMap<string, LinkableModel> => new Map(entries.map((entry) => [entry.id, entry]));

const open = (linkable: ReadonlyMap<string, LinkableModel>, model: string | undefined, extra: { isAnonymous?: boolean } = {}) =>
    linkModelAppliesOnOpen({ isAnonymous: extra.isAnonymous ?? false, linkable, model });

describe(linkModelAppliesOnOpen, () => {
    it("selects a text model the picker offers, in a text new chat", () => {
        expect(open(offered(text), text.id)).toBe(true);
    });

    it("selects a text model whose entry leaves the mode unset, as a text row does", () => {
        expect(open(offered({ id: "plain" }), "plain")).toBe(true);
    });

    it("selects nothing the picker does not offer, an image or video model, or an external one", () => {
        const image = { id: "image-model", mode: "image", provider: "fal" };
        const external = { id: "ext/model", mode: "text", provider: "external" };

        expect(open(offered(text), "not-offered")).toBe(false);
        expect(open(offered(image), image.id)).toBe(false);
        expect(open(offered(external), external.id)).toBe(false);
        expect(open(offered(text), undefined)).toBe(false);
    });

    it("selects a text model whatever mode the composer was last in: a link always opens a text chat", () => {
        expect(open(offered(text), text.id)).toBe(true);
    });

    it("selects the free model for an anonymous visitor, and no other text model", () => {
        const free = MODEL_REGISTRY.find((model) => model.id === "cf-gpt-oss-20b");

        expect(open(offered({ id: "cf-gpt-oss-20b", mode: "text", provider: "cloudflare" }), "cf-gpt-oss-20b", { isAnonymous: true })).toBe(true);
        expect(free).toBeDefined();
        expect(open(offered(text), text.id, { isAnonymous: true })).toBe(false);
    });
});
