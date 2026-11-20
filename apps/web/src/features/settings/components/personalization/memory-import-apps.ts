import { useLingui } from "@lingui/react/macro";

/** Mirrors `IMPORT_APPS` in `backend/lunora/memory/import-logic.ts`. */
export const IMPORT_APPS = ["chatgpt", "claude", "gemini", "other"] as const;

export type ImportApp = (typeof IMPORT_APPS)[number];

export const isImportApp = (value: unknown): value is ImportApp => typeof value === "string" && (IMPORT_APPS as ReadonlyArray<string>).includes(value);

/** Product names stay untranslated; "other" is the only label that needs a translation. */
export const useImportAppLabels = (): Record<ImportApp, string> => {
    const { t } = useLingui();

    return { chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", other: t`Another assistant` };
};
