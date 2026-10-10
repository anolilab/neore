/**
 * Pins the rendered HTML of every email template, byte for byte.
 *
 * The primitives in `components/primitives/` are a hand port of the deprecated
 * `@react-email/*` packages (see that module's header). A port is only safe if
 * the output does not move, and email HTML fails in ways that are invisible
 * outside a real client — attribute order, CSS property order and the Outlook
 * `mso-*` conditionals all matter. The fixtures were captured from the original
 * packages BEFORE the port, so this test is what proves the swap changed nothing.
 *
 * A deliberate template change means re-capturing the fixture in the same commit.
 *
 * Rendered through `@lunora/mail`'s `renderEmail`, which is what production
 * sends (`../mailer.ts`), so a render change upstream fails here too.
 */
import { renderEmail } from "@lunora/mail";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import AccountDeletionConfirmed from "./account-deletion-confirmed";
import DataExportReady from "./data-export-ready";
import MagicLink from "./magic-link";
import OrganizationInvite from "./organization-invite";
import ResetPassword from "./reset-password";
import VerifyEmail from "./verify-email";
import VerifyOTP from "./verify-otp";

const BRAND = { brandLogoUrl: "https://x.test/l.png", brandName: "Neore", brandTagline: "tag" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each template has its own prop shape
const CASES: [string, any, Record<string, unknown>][] = [
    ["verify-otp", VerifyOTP, { ...BRAND, code: "123456" }],
    ["magic-link", MagicLink, { ...BRAND, url: "https://ex.test/m" }],
    ["verify-email", VerifyEmail, { ...BRAND, url: "https://ex.test/v" }],
    ["reset-password", ResetPassword, { ...BRAND, url: "https://ex.test/r" }],
    [
        "organization-invite",
        OrganizationInvite,
        {
            acceptUrl: "https://ex.test/i",
            invitationId: "inv_1",
            inviterEmail: "d@ex.test",
            inviterName: "Dana",
            organizationName: "Acme Corp",
            role: "admin",
            to: "u@ex.test",
        },
    ],
    ["account-deletion-confirmed", AccountDeletionConfirmed, {}],
    ["data-export-ready", DataExportReady, { downloadUrl: "https://ex.test/d", expiresAt: "2026-12-31" }],
];

describe("email templates", () => {
    it.each(CASES)("%s renders byte-identically to its fixture", async (name, Component, properties) => {
        const { html } = await renderEmail(createElement(Component, properties));
        const expected = readFileSync(join(import.meta.dirname, "__fixtures__", `${name}.html`), "utf8");

        expect(html).toBe(expected);
    });
});
