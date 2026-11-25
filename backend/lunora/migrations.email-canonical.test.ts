import { canonicalEmail } from "@lunora/auth";
import { describe, expect, it } from "vitest";

import { uniqueUserEmailCanonical } from "./migrations";

const up = uniqueUserEmailCanonical.up as unknown as (document: unknown) => Record<string, unknown> | undefined;

describe("uniqueUserEmailCanonical", () => {
    it("fills a row that predates the column with the value the auth plugin computes for its email", () => {
        const migrated = up({ _id: "u1", email: "Bob@Example.com", name: "Bob" });

        expect(migrated).toMatchObject({ _id: "u1", email: "Bob@Example.com", emailCanonical: canonicalEmail("Bob@Example.com") });
        expect(migrated?.emailCanonical).toBe("bob@example.com");
    });

    it("fills a row whose stored value is null", () => {
        expect(up({ _id: "u2", email: "Bob@Example.com", emailCanonical: null })).toMatchObject({ emailCanonical: "bob@example.com" });
    });

    it("leaves a row alone when it already has a value", () => {
        expect(up({ _id: "u3", email: "bob@example.com", emailCanonical: "bob@example.com" })).toBeUndefined();
    });

    it("folds Unicode the same way the auth plugin does", () => {
        // A decomposed "e" with an acute accent folds to the precomposed form.
        const migrated = up({ _id: "u4", email: "José@Example.com", name: "Jose" });

        expect(migrated?.emailCanonical).toBe(canonicalEmail("José@Example.com"));
        expect(migrated?.emailCanonical).toBe("josé@example.com");
    });
});
