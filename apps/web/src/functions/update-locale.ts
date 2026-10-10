import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { serialize } from "cookie-es";
import { enum as zEnum } from "zod";

// Zod schema for locale validation
// Only allow supported locales to prevent injection attacks
const supportedLocales = ["en", "de", "es", "fr", "it", "ja", "pl", "pt", "zh"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];

/**
 * Runtime narrowing for callers that only have a `string` (e.g. a key of the
 * `locales` record, which is typed `Record<string, string>`). Shares the one
 * `supportedLocales` list with the zod validator so the two cannot drift.
 */
export const isSupportedLocale = (value: string): value is SupportedLocale => (supportedLocales as ReadonlyArray<string>).includes(value);

const localeSchema = zEnum(supportedLocales, {
    error: () => {
        return { message: `Locale must be one of: ${supportedLocales.join(", ")}` };
    },
});

const updateLocale = createServerFn({ method: "POST" })
    .validator(localeSchema)
    .handler(async (context) => {
        const data = context.data as SupportedLocale;

        // data is validated at runtime against supportedLocales
        setResponseHeader(
            "Set-Cookie",
            serialize("locale", data, {
                maxAge: 30 * 24 * 60 * 60,
                path: "/",
                sameSite: "lax", // CSRF protection
                secure: process.env.NODE_ENV === "production", // HTTPS only in production
            }),
        );
    });

export default updateLocale;
