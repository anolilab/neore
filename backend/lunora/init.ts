/**
 * Dev-database bootstrap: seed connector definitions the first time a developer
 * with an ADMIN email runs against an empty database.
 *
 * Run it with `lunora run init:initializeDatabase`. It is a NAMED export for that
 * reason — codegen only registers named ones, and a default export is dropped
 * without a word.
 */
import { internal } from "./_generated/internal";
import { internalMutation } from "./_generated/server";
import { ADMIN, ENVIRONMENT } from "./env";

export const initializeDatabase = internalMutation.input({}).mutation(async ({ ctx }) => {
    if (ENVIRONMENT !== "development") {
        return null;
    }

    const adminEmails = (ADMIN ?? "")
        .split(",")
        .map((email) => email.trim())
        .filter((email) => email.length > 0);

    if (adminEmails.length === 0) {
        return null;
    }

    // "First init" means NONE of the admin emails exist yet. Return on the first
    // hit, not the first miss: one pre-existing admin plus one new one must not
    // re-seed.
    for (const email of adminEmails) {
        const existing = await ctx.db.user.findFirst({ where: { email } });

        if (existing) {
            return null;
        }
    }

    await ctx.runMutation(internal.connectors.seed.seed, {});

    return null;
});
