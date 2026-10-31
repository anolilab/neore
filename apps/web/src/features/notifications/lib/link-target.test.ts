import { describe, expect, it } from "vitest";

import linkTarget from "./link-target";

describe("linkTarget", () => {
    it("leaves a plain path alone", () => {
        expect(linkTarget("/dashboard/settings/chat/triggers")).toEqual({ to: "/dashboard/settings/chat/triggers" });
    });

    it("splits a query into search params, decoded, so the router receives them as search and not as part of the path", () => {
        expect(linkTarget("/develop?repository=octo%2Fhello&number=7")).toEqual({ search: { number: "7", repository: "octo/hello" }, to: "/develop" });
    });

    it("keeps the first of a repeated key and drops a fragment", () => {
        expect(linkTarget("/develop?number=7&number=8#top")).toEqual({ search: { number: "7" }, to: "/develop" });
    });
});
