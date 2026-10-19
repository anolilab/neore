/**
 * The LOCAL device window's page (port of `apps/native/src/device.js`). The only
 * place a device call or a pairing is approved, and where shared folders, local
 * MCP servers and allow rules are managed. Bundled as a classic script
 * (`device.js`); it reaches the main process only through `window.neoreDevice`.
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
    const element = document.getElementById(id);

    if (element === null) {
        throw new Error(`missing #${id}`);
    }

    return element;
};

let current: Prompt | null = null;
let expiryTimer: ReturnType<typeof setInterval> | undefined;
let settings: SettingsView | null = null;

const setText = (id: string, text: string): void => {
    $(id).textContent = text;
};

const setHidden = (id: string, hidden: boolean): void => {
    $(id).hidden = hidden;
};

const renderPrompt = (prompt: Prompt | null): void => {
    current = prompt;
    setHidden("prompt", !prompt);
    setHidden("settings", Boolean(prompt));
    setText("prompt-error", "");
    clearInterval(expiryTimer);

    if (prompt === null) {
        void loadSettings();

        return;
    }

    const buttons = [$("deny"), $("once"), $("always")] as HTMLButtonElement[];
    const { body } = prompt;

    if (body.kind === "pairing") {
        setText("prompt-heading", "Pair this computer?");
        setText(
            "prompt-context",
            `The Neore account “${body.accountLabel}” wants to use this computer for agent tools. Every action will still ask you here first, and you can unpair at any time.`,
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

        // The shell's detail starts with the sandbox verdict on its first line.
        const sandboxLine = body.toolKind === "shell" ? body.detail.split("\n", 1)[0] ?? "" : "";

        setHidden("prompt-sandbox", !sandboxLine);
        $("prompt-sandbox").className = sandboxLine.startsWith("Sandboxed") ? "muted" : "warning";
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
        if (current?.id === prompt.id) {
            for (const button of buttons) {
                button.disabled = false;
            }
        }
    }, CLICK_THROUGH_GUARD_MS);

    const tick = () => {
        const seconds = Math.max(0, Math.round((prompt.expiresAt - Date.now()) / 1000));

        setText("prompt-expiry", `Denied automatically in ${String(seconds)} s.`);
    };

    tick();
    expiryTimer = setInterval(tick, 1000);
    $("deny").focus();
};

const refreshPrompt = async (): Promise<void> => {
    renderPrompt(await globalThis.neoreDevice.promptCurrent());
};

const answer = async (value: "always" | "deny" | "once"): Promise<void> => {
    if (current === null) {
        return;
    }

    try {
        await globalThis.neoreDevice.promptAnswer(current.id, value);
    } catch (error) {
        setText("prompt-error", String(error));
    }

    await refreshPrompt();
};

$("deny").addEventListener("click", () => void answer("deny"));
$("once").addEventListener("click", () => void answer("once"));
$("always").addEventListener("click", () => void answer("always"));

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

const update = async (changes: Record<string, unknown>): Promise<void> => {
    try {
        settings = await globalThis.neoreDevice.settingsUpdate(changes);
        status("Saved.");
        renderSettings();
    } catch (error) {
        status(String(error));
    }
};

const renderSettings = (): void => {
    if (settings === null) {
        return;
    }

    const view = settings;

    setText(
        "pairing",
        view.paired ? `Paired with ${view.accountLabel ?? "your account"}.` : "Not paired. Pair from Settings → Devices in the Neore app.",
    );
    setHidden("unpair", !view.paired);

    ($("require-sandbox") as HTMLInputElement).checked = view.requireShellSandbox;
    setText(
        "sandbox-status",
        view.sandboxUnavailable === null
            ? "Shell commands can change files only in the shared folders. See the sandbox note in each approval for what else they can reach. Network access is not restricted."
            : `Not available on this computer: ${view.sandboxUnavailable}. ${view.requireShellSandbox ? "Shell commands are refused." : "Shell commands run with your full access."}`,
    );

    $("roots").replaceChildren(
        ...view.roots.map((root) => listItem(root, "Remove", () => void update({ roots: view.roots.filter((other) => other !== root) }))),
    );
    $("servers").replaceChildren(
        ...view.mcpServers.map((server) =>
            listItem(`${server.name}: ${[server.command, ...server.args].join(" ")}`, "Remove", () =>
                void update({ mcpServers: view.mcpServers.filter((other) => other.name !== server.name) })),
        ),
    );
    $("rules").replaceChildren(
        ...view.allowRules.length === 0
            ? [listItem("None — every action asks.")]
            : view.allowRules.map((rule) =>
                listItem(rule, "Remove", () => void update({ allowRules: view.allowRules.filter((other) => other !== rule) })),
            ),
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

async function loadSettings(): Promise<void> {
    settings = await globalThis.neoreDevice.settingsGet();
    renderSettings();
    await loadAudit();
}

const addRoot = async (path: string): Promise<void> => {
    const trimmed = path.trim();

    if (trimmed && settings !== null) {
        await update({ roots: [...settings.roots, trimmed] });
    }
};

$("pick-root").addEventListener("click", async () => {
    const folder = await globalThis.neoreDevice.pickFolder();

    if (folder) {
        await addRoot(folder);
    }
});

$("add-root").addEventListener("click", async () => {
    const field = $("typed-root") as HTMLInputElement;

    await addRoot(field.value);
    field.value = "";
});

$("require-sandbox").addEventListener("change", async (event) => {
    const checkbox = event.target as HTMLInputElement;
    const required = checkbox.checked;

    if (!required && !await globalThis.neoreDevice.confirm("Allow shell commands to run WITHOUT a sandbox where this computer has none? They would run with your full access.")) {
        checkbox.checked = true;

        return;
    }

    await update({ requireShellSandbox: required });
});

$("unpair").addEventListener("click", async () => {
    if (await globalThis.neoreDevice.confirm("Unpair this computer? The agent will no longer be able to ask for anything here.")) {
        await update({ unpair: true });
    }
});

$("server-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const field = (id: string) => ($(id) as HTMLInputElement | HTMLTextAreaElement).value;
    const name = field("server-name").trim();
    const command = field("server-command").trim();
    const args = field("server-args")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const env = Object.fromEntries(
        field("server-env")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.includes("="))
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );

    if (!name || !command || settings === null) {
        status("A name and a command are required.");

        return;
    }

    // The exact command line, confirmed once more: it will run as you.
    if (!await globalThis.neoreDevice.confirm(`Add “${name}”? This computer will run:\n\n${[command, ...args].join(" ")}`)) {
        return;
    }

    await update({ mcpServers: [...settings.mcpServers, { args, command, env, name }] });
    (event.target as HTMLFormElement).reset();
});

globalThis.neoreDevice.onPromptQueued(() => void refreshPrompt());
window.addEventListener("focus", () => void refreshPrompt());
void refreshPrompt();
