/**
 * Reads the options an agent offers (its model, reasoning effort, mode ...) from what it sends: the answers to
 * `session/new` and `session/load`, `config_option_update`, `current_mode_update`, and the answer to a change.
 * Pure: a malformed value is dropped, never sent. The agent's `configOptions` take precedence over its legacy `modes`
 * and `models` states, which stand in only when it sends no options.
 *
 * Bounds match the backend's (`backend/lunora/acp/validators.ts`): at most 20 options with at most 100 choices each,
 * ids up to 128 bytes of UTF-8, names up to 200 characters. Every text goes through the caller's `scrub` (the agent's environment
 * values are removed there); an id or value the scrub would change is dropped, since it would no longer name the
 * agent's own choice.
 */
import type { AgentChoiceList, AgentOption, SessionStatePatch } from "./host-events";

export const MAX_OPTIONS = 20;
export const MAX_CHOICES = 100;
/** The computer's own check counts an id in UTF-8 bytes, so the bound is bytes: a longer id is refused there, after the change is sent. */
const MAX_ID_BYTES = 128;
const MAX_NAME_CHARS = 200;
const MAX_CATEGORY_CHARS = 64;

/**
 * The most JSON one part of the report may take. The backend refuses a `session_state` post over 256 KiB (`MAX_INGEST_BYTES`),
 * and a refused post drops its usage with it. Counts do not bound that alone: a name of 200 characters can be 800 bytes.
 */
const OPTIONS_BYTE_BUDGET = 64 * 1024;
const LEGACY_LIST_BYTE_BUDGET = 32 * 1024;

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/** The longest prefix of `items` whose JSON array fits in `budget` bytes. */
const fitPrefix = <T>(items: ReadonlyArray<T>, budget: number): T[] => {
    const kept: T[] = [];
    let used = 2; // the brackets

    for (const item of items) {
        const size = bytesOf(item) + 1; // with its comma

        if (used + size > budget) {
            break;
        }

        kept.push(item);
        used += size;
    }

    return kept;
};

/** The option with as many of its choices as fit in `budget` bytes; `undefined` when the option without them does not fit. */
const fitOption = (option: AgentOption, budget: number): AgentOption | undefined => {
    const bare = bytesOf({ ...option, choices: [] });

    if (bare > budget) {
        return undefined;
    }

    return { ...option, choices: fitPrefix(option.choices, budget - bare) };
};

type Scrub = (text: string) => string;

/** What the agent reported, before the precedence between options and legacy states is applied. */
export interface RawOptions {
    configOptions?: AgentOption[];
    models?: AgentChoiceList;
    modes?: AgentChoiceList;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** An id the agent chose, kept only whole: empty, too long or changed by the scrub reads as no id. */
const idOf = (value: unknown, scrub: Scrub): string | undefined => {
    if (typeof value !== "string" || value === "" || new TextEncoder().encode(value).length > MAX_ID_BYTES) {
        return undefined;
    }

    return scrub(value) === value ? value : undefined;
};

const nameOf = (value: unknown, fallback: string, scrub: Scrub): string => {
    const name = typeof value === "string" ? scrub(value).slice(0, MAX_NAME_CHARS) : "";

    return name === "" ? fallback : name;
};

/** The choices of a list option, groups flattened into one list, cut to the bound. */
const choicesOf = (options: unknown, scrub: Scrub): AgentOption["choices"] => {
    const choices: AgentOption["choices"] = [];

    const add = (entry: unknown): void => {
        if (!isRecord(entry) || choices.length >= MAX_CHOICES) {
            return;
        }

        const value = idOf(entry.value, scrub);

        if (value !== undefined && choices.every((choice) => choice.value !== value)) {
            choices.push({ name: nameOf(entry.name, value, scrub), value });
        }
    };

    const entries: unknown[] = Array.isArray(options) ? (options as unknown[]) : [];

    for (const entry of entries) {
        if (isRecord(entry) && Array.isArray(entry.options)) {
            for (const inner of entry.options as unknown[]) {
                add(inner);
            }
        } else {
            add(entry);
        }
    }

    return choices;
};

/** One option, if it is a list the person can choose from. A boolean option, or one with no usable id or value, is left out. */
const optionOf = (entry: unknown, scrub: Scrub): AgentOption | undefined => {
    if (!isRecord(entry) || (entry.type !== undefined && entry.type !== "select")) {
        return undefined;
    }

    const id = idOf(entry.id, scrub);
    const currentValue = idOf(entry.currentValue, scrub);

    if (id === undefined || currentValue === undefined) {
        return undefined;
    }

    const category = typeof entry.category === "string" ? scrub(entry.category).slice(0, MAX_CATEGORY_CHARS) : "";

    return {
        choices: choicesOf(entry.options, scrub),
        currentValue,
        id,
        name: nameOf(entry.name, id, scrub),
        ...category !== "" && { category },
    };
};

/** `configOptions` of an answer or an update; `undefined` when it is not a list. */
export const configOptionsOf = (value: unknown, scrub: Scrub): AgentOption[] | undefined => {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const options: AgentOption[] = [];
    let used = 2; // the brackets of the list

    for (const entry of value as unknown[]) {
        const option = optionOf(entry, scrub);

        if (option !== undefined && options.length < MAX_OPTIONS && options.every((other) => other.id !== option.id)) {
            const fitted = fitOption(option, OPTIONS_BYTE_BUDGET - used);

            if (fitted === undefined) {
                break;
            }

            options.push(fitted);
            used += bytesOf(fitted) + 1;
        }
    }

    // A nonempty list with no usable entry is malformed, not a list that clears the choices: it is ignored, and the choices offered
    // before stay. Only an explicitly empty list means the agent offers none.
    if (options.length === 0 && value.length > 0) {
        return undefined;
    }

    return options;
};

const listOf = (state: unknown, currentKey: string, listKey: string, idKey: string, scrub: Scrub): AgentChoiceList | undefined => {
    if (!isRecord(state)) {
        return undefined;
    }

    const current = idOf(state[currentKey], scrub);
    const entries = state[listKey];

    if (current === undefined || !Array.isArray(entries)) {
        return undefined;
    }

    const available: AgentChoiceList["available"] = [];

    for (const entry of entries as unknown[]) {
        const id = isRecord(entry) ? idOf(entry[idKey], scrub) : undefined;

        if (id !== undefined && isRecord(entry) && available.length < MAX_CHOICES && available.every((other) => other.id !== id)) {
            available.push({ id, name: nameOf(entry.name, id, scrub) });
        }
    }

    return { available: fitPrefix(available, LEGACY_LIST_BYTE_BUDGET), current };
};

/** What a `session/new` or `session/load` answer says about options, in the agent's own shape. */
export const optionsOf = (answer: unknown, scrub: Scrub): RawOptions => {
    if (!isRecord(answer)) {
        return {};
    }

    const configOptions = configOptionsOf(answer.configOptions, scrub);
    const modes = listOf(answer.modes, "currentModeId", "availableModes", "id", scrub);
    const models = listOf(answer.models, "currentModelId", "availableModels", "modelId", scrub);

    return { ...configOptions !== undefined && { configOptions }, ...modes !== undefined && { modes }, ...models !== undefined && { models } };
};

/** The state to send and to offer: the agent's options, or its legacy states when it sent no options. */
export const resolveOptions = (raw: RawOptions): SessionStatePatch => {
    if (raw.configOptions !== undefined && raw.configOptions.length > 0) {
        return { configOptions: raw.configOptions };
    }

    // An empty list is the agent saying it has no options now: it is sent, so the options stored before are replaced.
    return {
        ...raw.configOptions !== undefined && { configOptions: raw.configOptions },
        ...raw.modes !== undefined && { modes: raw.modes },
        ...raw.models !== undefined && { models: raw.models },
    };
};

/** `current_mode_update`: the mode the agent is in now. The legacy state, and the mode option when the agent has one, follow. */
export const withCurrentMode = (raw: RawOptions, modeId: unknown, scrub: Scrub): RawOptions => {
    const id = idOf(modeId, scrub);

    if (id === undefined) {
        return raw;
    }

    return {
        ...raw,
        ...raw.modes !== undefined && { modes: { ...raw.modes, current: id } },
        ...raw.configOptions !== undefined && {
            configOptions: raw.configOptions.map((option) =>
                option.category?.toLowerCase() === "mode" && option.choices.some((choice) => choice.value === id) ? { ...option, currentValue: id } : option,
            ),
        },
    };
};

/** Replaces the value of one option; the rest stay. */
export const withOptionValue = (raw: RawOptions, optionId: string, value: string): RawOptions => {
    return {
        ...raw,
        ...raw.configOptions !== undefined && {
            configOptions: raw.configOptions.map((option) => option.id === optionId ? { ...option, currentValue: value } : option),
        },
    };
};

/** Whether the agent offered this value: of an option, or (with no `optionId`) a mode of the legacy state, which counts only when it sent no options. */
export const isOffered = (raw: RawOptions, optionId: string | undefined, value: string): boolean => {
    if (optionId !== undefined) {
        return raw.configOptions?.find((option) => option.id === optionId)?.choices.some((choice) => choice.value === value) === true;
    }

    return (raw.configOptions?.length ?? 0) === 0 && raw.modes?.available.some((mode) => mode.id === value) === true;
};
