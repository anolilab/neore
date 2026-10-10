import { describe, expect, it } from "vitest";

import { DELETION_SESSION_FRESH_AGE_MS } from "./constants";
import { assertAccountDeletionAllowed, SESSION_NOT_FRESH } from "./deletion-guard";

const NOW = 1_800_000_000_000;
const IMPERSONATING = /impersonating/;

describe(assertAccountDeletionAllowed, () => {
    it("lets a fresh session proceed", () => {
        expect(() => assertAccountDeletionAllowed({ createdAt: NOW - 60_000 }, NOW)).not.toThrow();
    });

    it("refuses a stale session with the SESSION_NOT_FRESH code", () => {
        expect(() => assertAccountDeletionAllowed({ createdAt: NOW - DELETION_SESSION_FRESH_AGE_MS }, NOW)).toThrow(
            expect.objectContaining({ code: "FORBIDDEN", data: expect.objectContaining({ code: SESSION_NOT_FRESH }) }),
        );
    });

    it("refuses when there is no session row to prove recency with", () => {
        expect(() => assertAccountDeletionAllowed(null, NOW)).toThrow(expect.objectContaining({ data: expect.objectContaining({ code: SESSION_NOT_FRESH }) }));
    });

    it("refuses an impersonated session, however fresh", () => {
        expect(() => assertAccountDeletionAllowed({ createdAt: NOW, impersonatedBy: "admin-1" }, NOW)).toThrow(IMPERSONATING);
    });
});
