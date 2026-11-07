/**
 * The options an agent offers for its session (its model, reasoning effort, mode ...), read from what it sends: the
 * answer to `session/new` or `session/load`, and the `config_option_update` and `current_mode_update` updates. Pure: a
 * malformed value is dropped, never sent.
 *
 * Only list options are kept (`type: "select"`; a boolean option has no list to choose from). The agent's `configOptions`
 * take precedence over its legacy `modes` state, which stands in only for an agent that sends no options. Bounds match
 * the backend's (`backend/lunora/acp/validators.ts#vAgentOptions`). Every text goes through the caller's `scrub` (the
 * agent's environment values are removed there); an id the scrub would change is dropped, since it would no longer name
 * the agent's own choice.
 */
export const MAX_OPTIONS = 10;
export const MAX_CHOICES = 64;
/** The computer's core counts an id in UTF-8 bytes: a longer one would be refused there, after the change is sent. */
const MAX_ID_BYTES = 128;
const MAX_NAME_CHARS = 120;
const MAX_CATEGORY_CHARS = 64;

/**
 * What the options may take as JSON: counts alone do not bound bytes. The post that carries them (the backend refuses one over
 * 256 KiB, and a refused open leaves the session local) encodes them a second time, which at most doubles them, and the
 * capability report repeats the model choices: at most four times this, well under the cap.
 */
const MAX_OPTIONS_BYTES = 32 * 1024;

export interface AgentChoice {
    name: string;
    value: string;
}

/** One list option of the agent, with the value it has now. */
export interface AgentOption {
    /** The agent's own grouping (`model`, `thought_level`, `mode` ...), when it gave one. */
    category?: string;
    choices: AgentChoice[];
    currentValue: string;
    id: string;
    name: string;
}

/** What the agent offers: its options, or (for an agent that sends none) its legacy mode list. */
export interface AgentOptions {
    configOptions?: AgentOption[];
    modes?: { available: AgentChoice[]; current: string };
}

type Scrub = (text: string) => string;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** An id the agent chose, kept only whole: empty, too long or changed by the scrub reads as no id. */
const idOf = (value: unknown, scrub: Scrub): string | undefined =>
    typeof value === "string" && value !== "" && Buffer.byteLength(value) <= MAX_ID_BYTES && scrub(value) === value ? value : undefined;

const nameOf = (value: unknown, fallback: string, scrub: Scrub): string => {
    const name = typeof value === "string" ? scrub(value).slice(0, MAX_NAME_CHARS) : "";

    // The fallback is the id, which may be longer than a name is allowed to be.
    return (name === "" ? fallback : name).slice(0, MAX_NAME_CHARS);
};

/** A list of `{ [idKey], name }` entries, groups (`{ options: [...] }`) flattened, duplicates and bad ids dropped. */
const choicesOf = (entries: unknown, idKey: string, scrub: Scrub): AgentChoice[] => {
    const choices: AgentChoice[] = [];
    const flat = (Array.isArray(entries) ? (entries as unknown[]) : []).flatMap((entry) =>
        isRecord(entry) && Array.isArray(entry.options) ? (entry.options as unknown[]) : [entry],
    );

    for (const entry of flat) {
        const value = isRecord(entry) ? idOf(entry[idKey], scrub) : undefined;

        if (value !== undefined && choices.length < MAX_CHOICES && choices.every((choice) => choice.value !== value)) {
            choices.push({ name: nameOf((entry as Record<string, unknown>).name, value, scrub), value });
        }
    }

    return choices;
};

const optionOf = (entry: unknown, scrub: Scrub): AgentOption | undefined => {
    if (!isRecord(entry) || entry.type !== "select" || !Array.isArray(entry.options)) {
        return undefined;
    }

    const id = idOf(entry.id, scrub);
    const currentValue = idOf(entry.currentValue, scrub);

    if (id === undefined || currentValue === undefined) {
        return undefined;
    }

    const category = typeof entry.category === "string" ? scrub(entry.category).slice(0, MAX_CATEGORY_CHARS) : "";

    return { choices: choicesOf(entry.options, "value", scrub), currentValue, id, name: nameOf(entry.name, id, scrub), ...(category !== "" && { category }) };
};

/** `configOptions` of an answer or an update; `undefined` when it is not a list, or a nonempty list with nothing usable in it. */
export const configOptionsOf = (value: unknown, scrub: Scrub): AgentOption[] | undefined => {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const options: AgentOption[] = [];
    let used = 2;

    for (const entry of value as unknown[]) {
        const option = optionOf(entry, scrub);

        if (option === undefined || options.some((other) => other.id === option.id)) {
            continue;
        }

        used += bytesOf(option) + 1;

        if (options.length >= MAX_OPTIONS || used > MAX_OPTIONS_BYTES) {
            break;
        }

        options.push(option);
    }

    // Only an explicitly empty list says the agent offers none; one with nothing usable is malformed and changes nothing.
    return options.length === 0 && value.length > 0 ? undefined : options;
};

/** What a `session/new` or `session/load` answer says about options. */
export const optionsOf = (answer: unknown, scrub: Scrub): AgentOptions => {
    if (!isRecord(answer)) {
        return {};
    }

    const configOptions = configOptionsOf(answer.configOptions, scrub);

    // A list the agent sent, even an empty one, is what it offers: its legacy modes are then ignored.
    if (configOptions !== undefined) {
        return { configOptions };
    }

    const modes = isRecord(answer.modes) ? answer.modes : undefined;
    const current = idOf(modes?.currentModeId, scrub);
    const available = choicesOf(modes?.availableModes, "id", scrub);

    return current !== undefined && available.length > 0 ? { modes: { available, current } } : {};
};

/**
 * A `session/update` that changes the options, applied; `undefined` for any other update or one that changes nothing.
 * `config_option_update` replaces the options whole; `current_mode_update` moves the legacy mode and a `mode` option.
 */
export const applyOptionsUpdate = (options: AgentOptions, update: Record<string, unknown>, scrub: Scrub): AgentOptions | undefined => {
    if (update.sessionUpdate === "config_option_update") {
        const configOptions = configOptionsOf(update.configOptions, scrub);

        // The options replace everything offered before, legacy modes included.
        return configOptions === undefined ? undefined : { configOptions };
    }

    if (update.sessionUpdate !== "current_mode_update") {
        return undefined;
    }

    const id = idOf(update.currentModeId, scrub);

    if (id === undefined) {
        return undefined;
    }

    const moves = (option: AgentOption): boolean =>
        option.category === "mode" && option.currentValue !== id && option.choices.some((choice) => choice.value === id);
    const movesLegacy = options.modes !== undefined && options.modes.current !== id && options.modes.available.some((mode) => mode.value === id);

    // An unknown mode, or the one already current, changes nothing: no report is sent for it.
    if (!movesLegacy && options.configOptions?.some((option) => moves(option)) !== true) {
        return undefined;
    }

    return {
        ...(options.configOptions !== undefined && {
            configOptions: options.configOptions.map((option) => (moves(option) ? { ...option, currentValue: id } : option)),
        }),
        ...(options.modes !== undefined && {
            modes: { ...options.modes, current: movesLegacy ? id : options.modes.current },
        }),
    };
};
