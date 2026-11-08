/**
 * Phone push goes through Expo's push service with its access-token security on
 * (`EXPO_ACCESS_TOKEN`, a Worker secret). OPTIONAL, like the VAPID pair: unset,
 * phones are not registered and nothing is sent to them.
 */

export type PhonePlatform = "android" | "ios";

const read = (env: Record<string, unknown>, key: string): string => {
    const value = env[key];

    return typeof value === "string" ? value.trim() : "";
};

/** The access token every request to Expo's push API carries, or `undefined` while phone push is off. */
export const expoAccessToken = (env: Record<string, unknown>): string | undefined => read(env, "EXPO_ACCESS_TOKEN") || undefined;

export const isPhonePushConfigured = (env: Record<string, unknown>): boolean => expoAccessToken(env) !== undefined;
