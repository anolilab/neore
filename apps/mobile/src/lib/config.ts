/**
 * Build-time URLs. Metro inlines the EXPO_PUBLIC_ variables only when each name is
 * written out literally, so `loadConfig` names them one by one. A missing value is
 * a build problem: the root layout shows an error instead of calling `undefined`.
 */

import { trimTrailing } from "./trim-trailing";

export interface PostHogConfig {
    apiKey: string;
    host: string;
}

export interface MobileConfig {
    /** The web app origin: serves `/auth/extension`, the sign-in page. */
    appUrl: string;
    gatewayUrl: string;
    lunoraUrl: string;
    /** Crash reports are off unless both values are set in the build. */
    posthog?: PostHogConfig;
}

const required = (name: string, value: string | undefined): string => {
    if (!value) {
        throw new Error(`${name} is not set. Add it to apps/mobile/.env.`);
    }

    return trimTrailing(value, "/");
};

const posthogFrom = (apiKey: string | undefined, host: string | undefined): PostHogConfig | undefined => {
    if (!apiKey || !host) {
        return undefined;
    }

    return { apiKey, host: trimTrailing(host, "/") };
};

export const readConfig = (env: Record<string, string | undefined>): MobileConfig => {
    return {
        appUrl: required("EXPO_PUBLIC_APP_URL", env.EXPO_PUBLIC_APP_URL),
        gatewayUrl: required("EXPO_PUBLIC_LLM_GATEWAY_URL", env.EXPO_PUBLIC_LLM_GATEWAY_URL),
        lunoraUrl: required("EXPO_PUBLIC_LUNORA_URL", env.EXPO_PUBLIC_LUNORA_URL),
        posthog: posthogFrom(env.EXPO_PUBLIC_POSTHOG_API_KEY, env.EXPO_PUBLIC_POSTHOG_HOST),
    };
};

export const loadConfig = (): MobileConfig =>
    readConfig({
        EXPO_PUBLIC_APP_URL: process.env.EXPO_PUBLIC_APP_URL,
        EXPO_PUBLIC_LLM_GATEWAY_URL: process.env.EXPO_PUBLIC_LLM_GATEWAY_URL,
        EXPO_PUBLIC_LUNORA_URL: process.env.EXPO_PUBLIC_LUNORA_URL,
        EXPO_PUBLIC_POSTHOG_API_KEY: process.env.EXPO_PUBLIC_POSTHOG_API_KEY,
        EXPO_PUBLIC_POSTHOG_HOST: process.env.EXPO_PUBLIC_POSTHOG_HOST,
    });
