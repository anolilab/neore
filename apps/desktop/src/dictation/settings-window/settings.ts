/**
 * The dictation settings page: the opt-in switch, the speech model and its download or deletion, and the language. It reaches the
 * main process only through `window.neoreDictationSettings`, and renders with `textContent` alone.
 */
import type { ModelView, SettingsView } from "../settings-api";
import type { DictationSettingsWindowApi } from "./api";

const api = (globalThis as unknown as { neoreDictationSettings: DictationSettingsWindowApi }).neoreDictationSettings;

const $ = <Found extends HTMLElement>(id: string): Found => {
    const element = document.querySelector<Found>(`#${id}`);

    if (element === null) {
        throw new Error(`missing #${id}`);
    }

    return element;
};

const enabled = $<HTMLInputElement>("enabled");
const language = $<HTMLSelectElement>("language");
const status = $("status");
const list = $("model-list");

const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/u;
const SETTINGS_PREFIX = /^dictation settings: /u;

/** Each model's row is built once and updated in place, so the focus stays where the person put it. */
const rows = new Map<string, { download: HTMLButtonElement; radio: HTMLInputElement; remove: HTMLButtonElement; state: HTMLElement }>();

const show = (message: string): void => {
    status.textContent = message;
};

/** What the main process said, without Electron's "Error invoking remote method" wrapper and our own prefix. */
const reasonOf = (error: unknown): string => {
    const message = error instanceof Error ? error.message : "";
    const reason = message.replace(IPC_PREFIX, "").replace(SETTINGS_PREFIX, "");

    if (reason === "") {
        return "That could not be done.";
    }

    const sentence = `${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;

    return sentence.endsWith(".") ? sentence : `${sentence}.`;
};

const run = async (action: () => Promise<SettingsView>): Promise<void> => {
    try {
        render(await action());
    } catch (error) {
        // Show what is actually stored, so a refused change does not leave the switch or the choice looking applied.
        try {
            render(await api.get());
        } catch {
            // The window is closing; there is nothing to draw on.
        }

        show(reasonOf(error));
    }
};

/** Changes one setting, then shows what is now stored. */
const change = async (update: Parameters<DictationSettingsWindowApi["update"]>[0]): Promise<void> => {
    await run(async () => {
        await api.update(update);

        return api.get();
    });
};

const stateText = (model: ModelView): string => {
    if (model.state === "present") {
        return "Downloaded";
    }

    return model.state === "downloading" ? "Downloading…" : "Not downloaded";
};

const buildRow = (model: ModelView): void => {
    const row = document.createElement("div");
    const label = document.createElement("label");
    const radio = document.createElement("input");
    const name = document.createElement("span");
    const note = document.createElement("p");
    const state = document.createElement("p");
    const actions = document.createElement("div");
    const download = document.createElement("button");
    const remove = document.createElement("button");

    row.className = "model";
    radio.type = "radio";
    radio.name = "model";
    radio.value = model.id;
    radio.setAttribute("aria-describedby", `note-${model.id} state-${model.id}`);
    radio.addEventListener("change", () => {
        change({ model: model.id });
    });
    name.textContent = `${model.label} (${model.megabytes} MB)${model.isDefault ? " · recommended" : ""}`;
    label.append(radio, name);
    note.id = `note-${model.id}`;
    note.className = "muted";
    note.textContent = model.note;
    state.id = `state-${model.id}`;
    state.className = "muted";
    download.type = "button";
    download.textContent = `Download ${model.label} (${model.megabytes} MB)`;
    download.addEventListener("click", () => {
        show(`Downloading ${model.label}…`);
        run(() => api.download(model.id));
    });
    remove.type = "button";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${model.label} from this computer`);
    remove.addEventListener("click", () => {
        run(() => api.remove(model.id));
    });
    actions.className = "actions";
    actions.append(download, remove);
    row.append(label, note, state, actions);
    list.append(row);
    rows.set(model.id, { download, radio, remove, state });
};

const render = (view: SettingsView): void => {
    $("shortcut").textContent = view.shortcut;
    $("unavailable").hidden = view.available;
    $("shortcut-unavailable").hidden = !view.shortcutUnavailable;
    enabled.checked = view.enabled;
    enabled.disabled = !view.available;

    if (language.options.length === 0) {
        for (const { id, label } of view.languages) {
            language.append(new Option(label, id));
        }
    }

    language.value = view.language;
    language.disabled = !view.available;

    for (const model of view.models) {
        if (!rows.has(model.id)) {
            buildRow(model);
        }

        const row = rows.get(model.id);

        if (row !== undefined) {
            const focused = document.activeElement;

            row.radio.checked = model.id === view.model;
            row.radio.disabled = !view.available;
            row.state.textContent = stateText(model);
            // Off means no download: the button waits for the switch, so nothing is fetched before the person has opted in.
            row.download.hidden = model.state !== "missing";
            row.download.disabled = !view.enabled || !view.available;
            row.remove.hidden = model.state !== "present";

            // The button that was clicked may have just gone away; focus would drop to the page, so it moves to the next control in the row.
            if ((focused === row.download && row.download.hidden) || (focused === row.remove && row.remove.hidden)) {
                [row.radio, row.download, row.remove].find((control) => !control.hidden && !control.disabled)?.focus();
            }
        }
    }
};

enabled.addEventListener("change", () => {
    change({ enabled: enabled.checked });
});
language.addEventListener("change", () => {
    change({ language: language.value as SettingsView["language"] });
});

api.onChanged((message) => {
    run(() => api.get());

    if (message !== undefined) {
        show(message);
    }
});

// eslint-disable-next-line unicorn/prefer-top-level-await -- the page builds as an IIFE, where top-level await does not parse
run(() => api.get());
