/**
 * The LOCAL device window's page. It is the only place a device call or a pairing is approved,
 * and where shared folders, local MCP servers and allow rules are managed. Bundled as a classic
 * script (`device.js`); it reaches the main process only through `window.neoreDevice`.
 *
 * Everything in a prompt came from a model or the network, so it is rendered
 * with textContent only — never as HTML.
 */
import type { Prompt, SettingsView } from "../types";

/** Buttons stay disabled this long after a prompt appears, so a click meant for another window cannot land on "Allow". */
const CLICK_THROUGH_GUARD_MS = 800;

const TAINT_LABELS: Record<string, string> = {
    device: "output of an earlier action on this computer",
    files: "files attached to the chat",
    knowledge: "knowledge-base search results",
    mcp: "results from MCP / connector tools",
    web: "web pages or search results",
};

const $ = (id: string): HTMLElement => {
    const element = document.querySelector<HTMLElement>(`#${id}`);

    if (element === null) {
        throw new Error(`missing #${id}`);
    }

    return element;
};

// Page-wide state, kept on one object so the functions below assign properties rather than module bindings.
const state: {
    current: Prompt | null;
    expiryTimer?: ReturnType<typeof setInterval>;
    saves: Promise<void>;
    settings: SettingsView | null;
    terminalAvailable: boolean;
} = {
    current: null,
    saves: Promise.resolve(),
    settings: null,
    terminalAvailable: false,
};

const setText = (id: string, text: string): void => {
    $(id).textContent = text;
};

const setHidden = (id: string, isHidden: boolean): void => {
    $(id).hidden = isHidden;
};

const renderPrompt = (prompt: Prompt | null): void => {
    state.current = prompt;
    setHidden("prompt", !prompt);
    setHidden("settings", Boolean(prompt));
    setText("prompt-error", "");
    clearInterval(state.expiryTimer);

    if (prompt === null) {
        loadSettings();

        return;
    }

    const buttons = [$("deny"), $("once"), $("always")] as HTMLButtonElement[];
    const { body } = prompt;

    if (body.kind === "pairing") {
        setText("prompt-heading", "Pair this computer?");
        // A new pairing replaces the stored one; say so when settings show one.
        const replaces = state.settings?.paired ? ` This replaces the current pairing (“${state.settings.accountLabel ?? "your account"}”).` : "";

        setText(
            "prompt-context",
            `The Neore account “${body.accountLabel}” wants to use this computer for agent tools.${replaces} Every action will still ask you here first, and you can unpair at any time.`,
        );
        setHidden("prompt-warning", true);
        setText("prompt-detail", "Nothing runs now. Pairing only lets the agent ASK.");
        setHidden("prompt-input-box", true);
        setHidden("prompt-sandbox", true);
        setText("once", "Pair");
        setText("deny", "Cancel");
        setHidden("always", true);
    } else {
        setText("prompt-heading", `Allow “${body.tool}”?`);
        setText("prompt-context", body.threadTitle ? `Requested by the agent in “${body.threadTitle}”.` : "Requested by the agent.");

        const taints = body.taintedBy.map((source) => TAINT_LABELS[source] ?? source);

        setHidden("prompt-warning", taints.length === 0);
        setText(
            "prompt-warning",
            `This request follows content from outside (${taints.join(", ")}). Text there can try to steer the agent — check exactly what will run before allowing it.`,
        );
        setText("prompt-detail", body.detail);

        const sandboxLine = body.sandbox?.note ?? "";

        setHidden("prompt-sandbox", !sandboxLine);
        $("prompt-sandbox").className = body.sandbox?.confined ? "muted" : "warning";
        setText("prompt-sandbox", sandboxLine);
        setHidden("prompt-input-box", false);
        setText("prompt-input", body.input);
        setText("once", "Allow once");
        setText("deny", "Deny");
        setHidden("always", !body.allowAlways);
    }

    for (const button of buttons) {
        button.disabled = true;
    }

    setTimeout(() => {
        if (state.current?.id === prompt.id) {
            for (const button of buttons) {
                button.disabled = false;
            }
        }
    }, CLICK_THROUGH_GUARD_MS);

    // The core drops an expired prompt without an event, so a queued one behind it would stay hidden. Ask once
    // at the deadline; if the core still holds the expired prompt, the next tick asks again, at most once a second.
    let asked = false;

    const tick = () => {
        const remaining = prompt.expiresAt - Date.now();

        if (remaining <= 0) {
            if (!asked) {
                asked = true;
                clearInterval(state.expiryTimer);
                refreshPrompt();
            }

            return;
        }

        setText("prompt-expiry", `Denied automatically in ${String(Math.round(remaining / 1000))} s.`);
    };

    tick();
    state.expiryTimer = setInterval(tick, 1000);
    $("deny").focus();
};

const refreshPrompt = async (): Promise<void> => {
    renderPrompt(await globalThis.neoreDevice.promptCurrent());
};

const answer = async (value: "always" | "deny" | "once"): Promise<void> => {
    if (state.current === null) {
        return;
    }

    try {
        await globalThis.neoreDevice.promptAnswer(state.current.id, value);
    } catch (error) {
        setText("prompt-error", String(error));
    }

    await refreshPrompt();
};

$("deny").addEventListener("click", () => answer("deny"));
$("once").addEventListener("click", () => answer("once"));
$("always").addEventListener("click", () => answer("always"));

// ─── Settings ───────────────────────────────────────────────────────────────

const status = (text: string): void => setText("settings-status", text);

const listItem = (label: string, action?: string, onAction?: () => void): HTMLLIElement => {
    const item = document.createElement("li");
    const text = document.createElement("span");

    text.textContent = label;
    item.append(text);

    if (action !== undefined && onAction !== undefined) {
        const button = document.createElement("button");

        button.type = "button";
        button.textContent = action;
        button.setAttribute("aria-label", `${action}: ${label}`);
        button.addEventListener("click", onAction);
        item.append(button);
    }

    return item;
};

// Each change is built from the settings as they stand when its turn comes, so a quick second edit cannot overwrite the first.
const update = async (change: (latest: SettingsView) => Record<string, unknown>): Promise<void> => {
    const previous = state.saves;

    state.saves = (async () => {
        await previous;

        if (state.settings === null) {
            return;
        }

        try {
            state.settings = await globalThis.neoreDevice.settingsUpdate(change(state.settings));
            status("Saved.");
            renderSettings();
        } catch (error) {
            status(String(error));
        }
    })();

    await state.saves;
};

const removeRoot = (root: string): Promise<void> =>
    update((latest) => {
        return { roots: latest.roots.filter((other) => other !== root) };
    });

const removeServer = (name: string): Promise<void> =>
    update((latest) => {
        return { mcpServers: latest.mcpServers.filter((other) => other.name !== name) };
    });

const removeRule = (rule: string): Promise<void> =>
    update((latest) => {
        return { allowRules: latest.allowRules.filter((other) => other !== rule) };
    });

const openTerminal = async (folder: string | null): Promise<void> => {
    try {
        await globalThis.neoreDevice.openTerminal(folder);
        status("");
    } catch (error) {
        status(String(error));
    }
};

const rootItem = (root: string): HTMLLIElement => {
    const item = listItem(root, "Remove", () => removeRoot(root));

    if (state.terminalAvailable) {
        const button = document.createElement("button");

        button.type = "button";
        button.textContent = "Terminal";
        button.setAttribute("aria-label", `Open a terminal in ${root}`);
        button.addEventListener("click", () => openTerminal(root));
        item.append(button);
    }

    return item;
};

const renderSettings = (): void => {
    if (state.settings === null) {
        return;
    }

    const view = state.settings;

    setText("pairing", view.paired ? `Paired with ${view.accountLabel ?? "your account"}.` : "Not paired. Pair from Settings → Devices in the Neore app.");
    setHidden("unpair", !view.paired);

    ($("require-sandbox") as HTMLInputElement).checked = view.requireShellSandbox;
    ($("allow-network") as HTMLInputElement).checked = view.allowShellNetwork;
    const network = view.allowShellNetwork ? "allowed" : "blocked where the sandbox can enforce it (macOS and Linux). Windows does not restrict it";
    const unsandboxed = view.requireShellSandbox ? "Shell commands are refused." : "Shell commands run with your full access.";

    setText(
        "sandbox-status",
        view.sandboxUnavailable === null
            ? `Shell commands can change files only in the shared folders. See the sandbox note in each approval for what else they can reach. Network access is ${network}.`
            : `Not available on this computer: ${view.sandboxUnavailable}. ${unsandboxed}`,
    );

    $("roots").replaceChildren(...view.roots.map((root) => rootItem(root)));
    $("servers").replaceChildren(
        ...view.mcpServers.map((server) =>
            listItem(`${server.name}: ${[server.command, ...server.args].join(" ")}`, "Remove", () => removeServer(server.name)),
        ),
    );
    $("rules").replaceChildren(
        ...view.allowRules.length === 0
            ? [listItem("None — every action asks.")]
            : view.allowRules.map((rule) => listItem(rule, "Remove", () => removeRule(rule))),
    );
    setText("audit-path", `Full log: ${view.auditPath}`);
};

const loadAudit = async (): Promise<void> => {
    const lines = await globalThis.neoreDevice.auditTail();

    $("audit").replaceChildren(
        ...lines.slice(0, 30).map((line) => {
            try {
                const entry = JSON.parse(line) as { at: number; decision: string; status: string; tool: string };

                return listItem(`${new Date(entry.at).toLocaleString()} — ${entry.tool} — ${entry.decision} / ${entry.status}`);
            } catch {
                return listItem(line);
            }
        }),
    );
};

const loadTerminalAvailability = async (): Promise<void> => {
    const availability = await globalThis.neoreDevice.terminalAvailability();

    state.terminalAvailable = availability.available;
    setHidden("open-terminal", !availability.available);
    setHidden("terminal-status", availability.available);
    setText("terminal-status", availability.available ? "" : availability.reason);
};

const loadSettings = async (): Promise<void> => {
    await loadTerminalAvailability();
    state.settings = await globalThis.neoreDevice.settingsGet();
    renderSettings();
    await loadAudit();
};

const addRoot = async (path: string): Promise<void> => {
    const trimmed = path.trim();

    if (trimmed) {
        await update((latest) => {
            return { roots: [...latest.roots, trimmed] };
        });
    }
};

$("pick-root").addEventListener("click", async () => {
    const folder = await globalThis.neoreDevice.pickFolder();

    if (folder) {
        await addRoot(folder);
    }
});

$("open-terminal").addEventListener("click", () => openTerminal(null));

$("add-root").addEventListener("click", async () => {
    const field = $("typed-root") as HTMLInputElement;

    await addRoot(field.value);
    field.value = "";
});

$("require-sandbox").addEventListener("change", async (event) => {
    const checkbox = event.target as HTMLInputElement;
    const required = checkbox.checked;

    if (
        !required
        && !await globalThis.neoreDevice.confirm(
            "Allow shell commands to run WITHOUT a sandbox where this computer has none? They would run with your full access.",
        )
    ) {
        checkbox.checked = true;

        return;
    }

    await update(() => {
        return { requireShellSandbox: required };
    });
});

$("allow-network").addEventListener("change", async (event) => {
    const checkbox = event.target as HTMLInputElement;
    const allowed = checkbox.checked;

    if (
        allowed
        && !await globalThis.neoreDevice.confirm("Allow shell commands to use the network? An approved command could then send files or data to any server.")
    ) {
        checkbox.checked = false;

        return;
    }

    await update(() => {
        return { allowShellNetwork: allowed };
    });
});

$("unpair").addEventListener("click", async () => {
    if (await globalThis.neoreDevice.confirm("Unpair this computer? The agent will no longer be able to ask for anything here.")) {
        await update(() => {
            return { unpair: true };
        });
    }
});

$("server-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const field = (id: string) => ($(id) as HTMLInputElement | HTMLTextAreaElement).value;
    const name = field("server-name").trim();
    const command = field("server-command").trim();

    if (!name || !command || state.settings === null) {
        status("A name and a command are required.");

        return;
    }

    const args = field("server-args")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    // The exact command line, confirmed once more: it will run as you.
    if (!await globalThis.neoreDevice.confirm(`Add “${name}”? This computer will run:\n\n${[command, ...args].join(" ")}`)) {
        return;
    }

    const env = Object.fromEntries(
        field("server-env")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.includes("="))
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );

    await update((latest) => {
        return { mcpServers: [...latest.mcpServers, { args, command, env, name }] };
    });
    (event.target as HTMLFormElement).reset();
});

globalThis.neoreDevice.onPromptQueued(() => refreshPrompt());
window.addEventListener("focus", () => refreshPrompt());
// eslint-disable-next-line unicorn/prefer-top-level-await -- the page builds as an IIFE, where top-level await does not parse
refreshPrompt();
