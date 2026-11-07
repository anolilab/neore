import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * The keychain access group the app and its iOS Notification Service Extension share
 * (`targets/notification-service`): the app's OWN default group, its application
 * identifier. A grant the app stored before this build already lives here, so the
 * extension can read it without anything being moved or deleted.
 */
export const SHARED_KEYCHAIN_GROUP = "$(AppIdentifierPrefix)ai.neore.mobile";

/**
 * `app.json` plus what only exists at build time. `EAS_PROJECT_ID` is the Expo project
 * the push token belongs to; without it the app gets no push token and never asks for
 * permission. `GOOGLE_SERVICES_JSON` (an EAS file secret, a path) is Android's Firebase
 * app file; without it the build works and Android gets no push. `APPLE_TEAM_ID` signs
 * the Notification Service Extension target.
 */
const appConfig = ({ config }: ConfigContext): ExpoConfig => {
    const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
    const projectId = process.env.EAS_PROJECT_ID;
    const appleTeamId = process.env.APPLE_TEAM_ID;
    const android = googleServicesFile ? { ...config.android, googleServicesFile } : config.android;
    const ios = {
        ...config.ios,
        entitlements: { ...config.ios?.entitlements, "keychain-access-groups": [SHARED_KEYCHAIN_GROUP] },
        ...appleTeamId && { appleTeamId },
    };
    // Read at runtime (`phone-push.ts`): an Android build without the file cannot get a push token, so it never asks.
    const extra = { ...config.extra, hasFirebaseConfig: Boolean(googleServicesFile), ...projectId && { eas: { projectId } } };

    return { ...config, android, extra, ios, name: config.name ?? "Neore", slug: config.slug ?? "neore" };
};

export default appConfig;
