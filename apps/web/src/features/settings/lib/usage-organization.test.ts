import { TransportError } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { retryOrganizationRead } from "./usage-organization";

describe("retryOrganizationRead", () => {
    it("tries once more only after a failure that may not repeat", () => {
        expect(retryOrganizationRead(0, new TypeError("Failed to fetch"))).toBe(true);
        expect(retryOrganizationRead(1, new TypeError("Failed to fetch"))).toBe(false);
        // A timeout reaches the client as a transport error, coded INTERNAL though no backend answered.
        expect(retryOrganizationRead(0, new TransportError("Request timed out"))).toBe(true);
        expect(retryOrganizationRead(1, new TransportError("Request timed out"))).toBe(false);
        const refused = Object.assign(new Error("Only organization admins"), { code: "FORBIDDEN", data: { code: "FORBIDDEN" } });

        expect(retryOrganizationRead(0, refused)).toBe(false);
    });
});
