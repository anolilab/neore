/**
 * The reload after a save refused as stale: it moves the edit onto the login as the server now has it, but never onto a
 * read older than what the form already holds.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (parts: TemplateStringsArray) => parts.join("") };
        },
    };
});

const { reloadAfterConflict } = await import("./site-logins");

type Draft = Parameters<typeof reloadAfterConflict>[0];
type Listed = NonNullable<Parameters<typeof reloadAfterConflict>[1]>;

const SITE = "https://example.com";

const draftAt = (updatedAt: number, signInUrl: string): Draft =>
    ({
        id: "login-1",
        label: "",
        opened: { label: "", signInUrl, teammateIds: [], updatedAt, username: "ada@example.com" },
        password: "",
        signInUrl,
        site: SITE,
        teammateIds: [],
        username: "ada@example.com",
    }) as unknown as Draft;

const listed = (updatedAt: number, signInUrl: string): Listed =>
    ({ hasPassword: true, id: "login-1", signInUrl, site: SITE, teammateIds: [], updatedAt, username: "ada@example.com" }) as unknown as Listed;

describe(reloadAfterConflict, () => {
    it("moves an edit still on the refused version onto the login as the server has it", () => {
        const submitted = draftAt(1, `${SITE}/login`);

        expect(reloadAfterConflict(submitted, listed(5, `${SITE}/sign-in`))(submitted)).toMatchObject({
            opened: { updatedAt: 5 },
            signInUrl: `${SITE}/sign-in`,
        });
    });

    it("leaves an edit that saved a newer version meanwhile as it is, when the read answers late", () => {
        const submitted = draftAt(1, `${SITE}/login`);
        // The person saved the login again while the read was on its way: the form holds version 9.
        const current = draftAt(9, `${SITE}/new`);

        expect(reloadAfterConflict(submitted, listed(5, `${SITE}/old`))(current)).toBe(current);
    });
});
