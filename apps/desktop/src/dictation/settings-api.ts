import type { OfferedModel } from "./catalog.js";
import type { ModelStore } from "./model-store.js";
import { ModelError } from "./model-store.js";
import type { DictationSettings, Language, SettingsStore } from "./settings.js";
import { LANGUAGES, parseUpdate } from "./settings.js";

const LANGUAGE_LABELS: Record<Language, string> = {
    auto: "Detect the language",
    de: "German",
    en: "English",
    es: "Spanish",
    fr: "French",
    it: "Italian",
    ja: "Japanese",
    pl: "Polish",
    pt: "Portuguese",
    zh: "Chinese",
};

export interface ModelView {
    id: string;
    isDefault: boolean;
    label: string;
    /** Download size in megabytes, shown before anything is downloaded. */
    megabytes: number;
    note: string;
    state: "downloading" | "missing" | "present";
}

/** Everything the settings page shows. It holds no path, no URL and no audio. */
export interface SettingsView {
    /** False where the speech helper was not built: the page says so and offers nothing. */
    available: boolean;
    enabled: boolean;
    language: Language;
    languages: { id: Language; label: string }[];
    /** The model that will be used: the chosen one, or this machine's default. */
    model: string;
    models: ModelView[];
    shortcut: string;
    /** True when the switch is on but the OS refused the shortcut (another app holds it). */
    shortcutUnavailable: boolean;
}

export interface SettingsApiOptions {
    /** Ends a dictation that is running now (a deleted model, or a switch turned off, must not be used by it) and resolves once its helper has exited. */
    cancelDictation: () => Promise<void>;
    /** Whether the speech helper exists in this build. */
    hasHelper: () => boolean;
    models: Pick<ModelStore, "cancelDownloads" | "download" | "isDownloading" | "remove" | "status">;
    offered: ReadonlyArray<OfferedModel>;
    /** The switch changed: the shortcut follows it. */
    onEnabledChange: (enabled: boolean) => void;
    /** A download or deletion ended; a sentence for the page's status line. */
    onNotice: (message: string) => void;
    /** The model in use, after settings are applied. */
    resolveModel: (settings: DictationSettings) => string;
    settings: SettingsStore;
    shortcut: string;
    /** Whether the shortcut was refused when it was last registered. */
    shortcutRefused: () => boolean;
}

export interface SettingsApi {
    /** Starts a download and returns at once; `finished` settles when it has ended (its outcome was reported through `onNotice`). */
    download: (id: unknown) => { finished: Promise<void> };
    remove: (id: unknown) => Promise<void>;
    update: (payload: unknown) => Promise<DictationSettings>;
    view: () => Promise<SettingsView>;
}

/** What the settings window may do. It is the only caller, so each method re-checks its argument; the switch gates every download. */
export const createSettingsApi = (options: SettingsApiOptions): SettingsApi => {
    const known = new Set(options.offered.map(({ spec }) => spec.id));
    const specOf = (id: unknown): OfferedModel["spec"] => {
        const found = options.offered.find(({ spec }) => spec.id === id);

        if (found === undefined) {
            throw new TypeError("dictation settings: unknown model");
        }

        return found.spec;
    };

    const downloadingOrMissing = (spec: OfferedModel["spec"]): ModelView["state"] => options.models.isDownloading(spec) ? "downloading" : "missing";

    const view = async (): Promise<SettingsView> => {
        const settings = options.settings.get();
        const models = await Promise.all(
            options.offered.map(async ({ isDefault, note, spec }): Promise<ModelView> => {
                const { state } = await options.models.status(spec);

                return {
                    id: spec.id,
                    isDefault,
                    label: spec.label,
                    megabytes: Math.round(spec.bytes / 1_000_000),
                    note,
                    state: state === "present" ? "present" : downloadingOrMissing(spec),
                };
            }),
        );

        return {
            available: options.hasHelper(),
            enabled: settings.enabled,
            language: settings.language,
            languages: LANGUAGES.map((id) => { return { id, label: LANGUAGE_LABELS[id] }; }),
            model: options.resolveModel(settings),
            models,
            shortcut: options.shortcut,
            shortcutUnavailable: settings.enabled && options.shortcutRefused(),
        };
    };

    const requireHelper = (): void => {
        if (!options.hasHelper()) {
            throw new Error("dictation settings: on-device dictation is not available on this computer yet");
        }
    };

    return {
        download: (id) => {
            requireHelper();

            // Off means no model is fetched: the window cannot start one, and a download already running is stopped when the switch goes off.
            if (!options.settings.get().enabled) {
                throw new Error("dictation settings: turn dictation on before downloading a model");
            }

            const spec = specOf(id);
            const running = options.models.download(spec);

            return {
                finished: (async () => {
                    try {
                        await running;
                        options.onNotice(`${spec.label} is ready.`);
                    } catch (error) {
                        if (!(error instanceof ModelError && error.code === "cancelled")) {
                            options.onNotice(error instanceof ModelError ? error.message : `${spec.label} could not be downloaded.`);
                        }
                    }
                })(),
            };
        },
        remove: async (id) => {
            const spec = specOf(id);

            // A dictation may be loading this very file, and Windows will not delete a file that is open.
            await options.cancelDictation();
            await options.models.remove(spec);
            options.onNotice(`${spec.label} was deleted from this computer.`);
        },
        update: async (payload) => {
            const update = parseUpdate(payload, known);

            if (update.enabled === true) {
                requireHelper();
            }

            const before = options.settings.get();
            const after = options.settings.update(update);

            if (before.enabled && !after.enabled) {
                await options.cancelDictation();
                await options.models.cancelDownloads();
            }

            if (before.enabled !== after.enabled) {
                options.onEnabledChange(after.enabled);
            }

            return after;
        },
        view,
    };
};
