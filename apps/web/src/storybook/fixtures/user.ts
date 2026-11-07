import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";

import type { LunoraFixture } from "../lunora";
import { lunora, onStoryReset } from "../lunora";
import { getActivePersona } from "../session";
import { OWNER, ownedBy } from "./owner";

type Preferences = NonNullable<ReturnOf<typeof api.auth.functions.getAIUserPreferences>>;
type Settings = NonNullable<ReturnOf<typeof api.auth.functions.getUserSettings>>;

const CREATED = Date.UTC(2026, 0, 15);

/** `aiUserPreferences` for the signed-in persona; override any field. */
export const preferences = (overrides: Partial<Preferences> = {}): Preferences => {
    return {
        _creationTime: CREATED,
        _id: "prefs_storybook" as Preferences["_id"],
        userId: OWNER,
        ...overrides,
    };
};

/** `userSettings` for the signed-in persona; override any field. */
export const settings = (overrides: Partial<Settings> = {}): Settings => {
    return {
        _creationTime: CREATED,
        _id: "settings_storybook" as Settings["_id"],
        // The welcome tour would cover every page story; its own stories set this to false.
        onboardingCompleted: true,
        userId: OWNER,
        ...overrides,
    } as Settings;
};

/**
 * What nearly every signed-in screen reads on mount: preferences, settings, the admin flag,
 * paid access and custom providers. The two settings rows are STATEFUL: a write merges its arguments into
 * the row the next read returns, so a toggle in a story stays toggled after the refetch.
 * Each call starts from fresh rows. Spread it first and add a story's own fixtures after,
 * which win.
 */
export const userFixtures = (
    options: {
        canRunPaidModels?: boolean;
        isAdmin?: boolean;
        isImpersonating?: boolean;
        preferences?: Partial<Preferences>;
        settings?: Partial<Settings>;
    } = {},
): LunoraFixture[] => {
    let preferencesRow: Preferences;
    let settingsRow: Settings;

    // Fresh rows for each story and for each visit to one, so a save in one story never shows in the next.
    const reset = () => {
        preferencesRow = preferences(options.preferences);
        settingsRow = settings(options.settings);
    };

    reset();
    onStoryReset(reset);

    return [
        lunora(api.auth.functions.getAIUserPreferences, () => ownedBy(preferencesRow)),
        lunora(api.auth.functions.getUserSettings, () => ownedBy(settingsRow)),
        // Unless a story says otherwise, these follow the persona.
        lunora(api.auth.admin.isCurrentUserAdmin, () => {
            return { isAdmin: options.isAdmin ?? getActivePersona() === "admin" };
        }),
        lunora(api.auth.admin.isImpersonating, () => {
            return { isImpersonating: options.isImpersonating ?? false };
        }),
        lunora(api.auth.functions.getPaidModelAccess, () => {
            return { canRunPaidModels: options.canRunPaidModels ?? !["free", "guest"].includes(getActivePersona()) };
        }),
        lunora(api.chat.custom_providers.listCustomProviders, []),
        lunora(api.auth.functions.updateAIUserPreferences, (patch) => {
            preferencesRow = { ...preferencesRow, ...(patch as Partial<Preferences>) };
        }),
        lunora(api.auth.functions.updateUserSettings, (patch) => {
            settingsRow = { ...settingsRow, ...(patch as Partial<Settings>) };
        }),
    ];
};
