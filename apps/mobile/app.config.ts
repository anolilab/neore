import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * `app.json` plus what only exists at build time. `EAS_PROJECT_ID` is the Expo project
 * the push token belongs to; without it the app gets no push token and never asks for
 * permission. `GOOGLE_SERVICES_JSON` (an EAS file secret, a path) is Android's Firebase
 * app file; without it the build works and Android gets no push.
 */
const appConfig = ({ config }: ConfigContext): ExpoConfig => {
    const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;
    const projectId = process.env.EAS_PROJECT_ID;
    const android = googleServicesFile ? { ...config.android, googleServicesFile } : config.android;
    // Read at runtime (`phone-push.ts`): an Android build without the file cannot get a push token, so it never asks.
    const extra = { ...config.extra, hasFirebaseConfig: Boolean(googleServicesFile), ...projectId && { eas: { projectId } } };

    return { ...config, android, extra, name: config.name ?? "Neore", slug: config.slug ?? "neore" };
};

export default appConfig;
