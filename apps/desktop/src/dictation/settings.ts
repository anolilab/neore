import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** What the recogniser may be told to listen for: the nine languages the speech benchmark covers (Appendix A), and detection. */
export const LANGUAGES = ["auto", "en", "de", "es", "fr", "it", "pl", "pt", "ja", "zh"] as const;

export type Language = (typeof LANGUAGES)[number];

export const isLanguage = (value: unknown): value is Language => LANGUAGES.includes(value as Language);

export interface DictationSettings {
    /** Opt-in: absent or anything but `true` means off. */
    enabled: boolean;
    language: Language;
    /** The chosen model id, or `undefined` for this machine's default. */
    model: string | undefined;
}

export const DEFAULT_SETTINGS: DictationSettings = { enabled: false, language: "auto", model: undefined };

/** What a caller may change. Every field is checked; a bad one is a refusal, never a stored value. */
export type SettingsUpdate = Partial<DictationSettings>;

/** Anything but a plain object yields the defaults, and each field falls back on its own: one bad value never turns the switch on. */
export const parseSettings = (raw: string | undefined, knownModels: ReadonlySet<string>): DictationSettings => {
    let data: unknown;

    try {
        data = raw === undefined ? undefined : JSON.parse(raw);
    } catch {
        return DEFAULT_SETTINGS;
    }

    if (typeof data !== "object" || data === null) {
        return DEFAULT_SETTINGS;
    }

    const { enabled, language, model } = data as Record<string, unknown>;

    return {
        enabled: enabled === true,
        language: isLanguage(language) ? language : DEFAULT_SETTINGS.language,
        model: typeof model === "string" && knownModels.has(model) ? model : undefined,
    };
};

/** The one validation of an update that came over IPC. Throws on anything unexpected, so nothing half-valid is applied. */
export const parseUpdate = (payload: unknown, knownModels: ReadonlySet<string>): SettingsUpdate => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new TypeError("dictation settings: an update must be an object");
    }

    const update: SettingsUpdate = {};

    for (const [key, value] of Object.entries(payload)) {
        if (key === "enabled" && typeof value === "boolean") {
            update.enabled = value;
        } else if (key === "language" && isLanguage(value)) {
            update.language = value;
        } else if (key === "model" && typeof value === "string" && knownModels.has(value)) {
            update.model = value;
        } else {
            throw new TypeError(`dictation settings: unexpected ${key}`);
        }
    }

    return update;
};

export interface SettingsStore {
    get: () => DictationSettings;
    update: (update: SettingsUpdate) => DictationSettings;
}

/**
 * The settings file under app data, read once and kept; every change is written at once (temp file, then rename, like the window state).
 * Local only: nothing here goes to the backend.
 */
export const createSettingsStore = (file: string, knownModels: ReadonlySet<string>): SettingsStore => {
    let current: DictationSettings;

    try {
        current = parseSettings(readFileSync(file, "utf8"), knownModels);
    } catch {
        current = DEFAULT_SETTINGS;
    }

    return {
        get: () => current,
        update: (update) => {
            const next = { ...current, ...update };

            mkdirSync(path.dirname(file), { mode: 0o700, recursive: true });

            const temporary = `${file}.${process.pid}.tmp`;

            writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
            renameSync(temporary, file);
            current = next;

            return current;
        },
    };
};
