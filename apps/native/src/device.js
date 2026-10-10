// The LOCAL device window (`src-tauri/src/device/`): the only place a device
// call or a pairing is approved, and where shared folders, local MCP servers
// and allow rules are managed. Its capability (`capabilities/device.json`)
// grants these commands to this window alone; the remote web app cannot call
// them or script this page.
//
// Everything in a prompt came from a model or the network, so it is rendered
// with textContent only — never as HTML.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** Buttons stay disabled this long after a prompt appears, so a click meant for another window cannot land on "Allow". */
const CLICK_THROUGH_GUARD_MS = 800;

const TAINT_LABELS = {
    device: "output of an earlier action on this computer",
    files: "files attached to the chat",
    knowledge: "knowledge-base search results",
    mcp: "results from MCP / connector tools",
    web: "web pages or search results",
};

const $ = (id) => document.getElementById(id);

let current = null;
let expiryTimer = null;

const setText = (id, text) => {
    $(id).textContent = text;
};

const renderPrompt = (prompt) => {
    current = prompt;
    $("prompt").hidden = !prompt;
    $("settings").hidden = Boolean(prompt);
    setText("prompt-error", "");
    clearInterval(expiryTimer);

    if (!prompt) {
        void loadSettings();

        return;
    }

    const { body } = prompt;
    const buttons = [$("deny"), $("once"), $("always")];

    if (body.kind === "pairing") {
        setText("prompt-heading", "Pair this computer?");
        setText(
            "prompt-context",
            `The Neore account “${body.accountLabel}” wants to use this computer for agent tools. Every action will still ask you here first, and you can unpair at any time.`,
        );
        $("prompt-warning").hidden = true;
        setText("prompt-detail", "Nothing runs now. Pairing only lets the agent ASK.");
        $("prompt-input-box").hidden = true;
        $("prompt-sandbox").hidden = true;
        setText("once", "Pair");
        setText("deny", "Cancel");
        $("always").hidden = true;
    } else {
        setText("prompt-heading", `Allow “${body.tool}”?`);
        setText("prompt-context", body.threadTitle ? `Requested by the agent in “${body.threadTitle}”.` : "Requested by the agent.");

        const taints = body.taintedBy.map((source) => TAINT_LABELS[source] ?? source);

        $("prompt-warning").hidden = taints.length === 0;
        setText(
            "prompt-warning",
            `This request follows content from outside (${taints.join(", ")}). Text there can try to steer the agent — check exactly what will run before allowing it.`,
        );
        setText("prompt-detail", body.detail);

        // Rust puts the sandbox verdict on the first line of a shell call's detail.
        const sandboxLine = body.toolKind === "shell" ? body.detail.split("\n")[0] : "";

        $("prompt-sandbox").hidden = !sandboxLine;
        $("prompt-sandbox").className = sandboxLine.startsWith("Sandboxed") ? "muted" : "warning";
        setText("prompt-sandbox", sandboxLine);
        $("prompt-input-box").hidden = false;
        setText("prompt-input", body.input);
        setText("once", "Allow once");
        setText("deny", "Deny");
        $("always").hidden = !body.allowAlways;
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

const refreshPrompt = async () => {
    renderPrompt(await invoke("device_prompt_current"));
};

const answer = async (value) => {
    if (!current) {
        return;
    }

    try {
        await invoke("device_prompt_answer", { answer: value, id: current.id });
    } catch (error) {
        setText("prompt-error", String(error));
    }

    await refreshPrompt();
};

$("deny").addEventListener("click", () => void answer("deny"));
$("once").addEventListener("click", () => void answer("once"));
$("always").addEventListener("click", () => void answer("always"));

// ─── Settings ───────────────────────────────────────────────────────────────

let settings = null;

const status = (text) => setText("settings-status", text);

const listItem = (label, action, onAction) => {
    const item = document.createElement("li");
    const text = document.createElement("span");

    text.textContent = label;
    item.append(text);

    if (action) {
        const button = document.createElement("button");

        button.type = "button";
        button.textContent = action;
        button.setAttribute("aria-label", `${action}: ${label}`);
        button.addEventListener("click", onAction);
        item.append(button);
    }

    return item;
};

const update = async (changes) => {
    try {
        settings = await invoke("device_settings_update", { update: changes });
        status("Saved.");
        renderSettings();
    } catch (error) {
        status(String(error));
    }
};

const renderSettings = () => {
    if (!settings) {
        return;
    }

    setText(
        "pairing",
        settings.paired ? `Paired with ${settings.accountLabel ?? "your account"}.` : "Not paired. Pair from Settings → Devices in the Neore app.",
    );
    $("unpair").hidden = !settings.paired;

    $("require-sandbox").checked = settings.requireShellSandbox;
    setText(
        "sandbox-status",
        settings.sandboxUnavailable
            ? `Not available on this computer: ${settings.sandboxUnavailable}. ${settings.requireShellSandbox ? "Shell commands are refused." : "Shell commands run with your full access."}`
            : "Shell commands can change files only in the shared folders and cannot see the rest of your home folder. Network access is not restricted.",
    );

    $("roots").replaceChildren(
        ...settings.roots.map((root) => listItem(root, "Remove", () => void update({ roots: settings.roots.filter((other) => other !== root) }))),
    );
    $("servers").replaceChildren(
        ...settings.mcpServers.map((server) =>
            listItem(
                `${server.name}: ${[server.command, ...server.args].join(" ")}`,
                "Remove",
                () => void update({ mcpServers: settings.mcpServers.filter((other) => other.name !== server.name) }),
            ),
        ),
    );
    $("rules").replaceChildren(
        ...(settings.allowRules.length === 0
            ? [listItem("None — every action asks.")]
            : settings.allowRules.map((rule) =>
                  listItem(rule, "Remove", () => void update({ allowRules: settings.allowRules.filter((other) => other !== rule) })),
              )),
    );
    setText("audit-path", `Full log: ${settings.auditPath}`);
};

const loadAudit = async () => {
    const lines = await invoke("device_audit_tail");

    $("audit").replaceChildren(
        ...lines.slice(0, 30).map((line) => {
            try {
                const entry = JSON.parse(line);

                return listItem(`${new Date(entry.at).toLocaleString()} — ${entry.tool} — ${entry.decision} / ${entry.status}`);
            } catch {
                return listItem(line);
            }
        }),
    );
};

async function loadSettings() {
    settings = await invoke("device_settings_get");
    renderSettings();
    await loadAudit();
}

const addRoot = async (path) => {
    const trimmed = path.trim();

    if (trimmed) {
        await update({ roots: [...settings.roots, trimmed] });
    }
};

$("pick-root").addEventListener("click", async () => {
    const folder = await invoke("device_pick_folder");

    if (folder) {
        await addRoot(folder);
    }
});

$("add-root").addEventListener("click", async () => {
    await addRoot($("typed-root").value);
    $("typed-root").value = "";
});

$("require-sandbox").addEventListener("change", async (event) => {
    const required = event.target.checked;

    if (!required && !window.confirm("Allow shell commands to run WITHOUT a sandbox where this computer has none? They would run with your full access.")) {
        event.target.checked = true;

        return;
    }

    await update({ requireShellSandbox: required });
});

$("unpair").addEventListener("click", async () => {
    if (window.confirm("Unpair this computer? The agent will no longer be able to ask for anything here.")) {
        await update({ unpair: true });
    }
});

$("server-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = $("server-name").value.trim();
    const command = $("server-command").value.trim();
    const args = $("server-args")
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const env = Object.fromEntries(
        $("server-env")
            .value.split("\n")
            .map((line) => line.trim())
            .filter((line) => line.includes("="))
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );

    if (!name || !command) {
        status("A name and a command are required.");

        return;
    }

    // The exact command line, confirmed once more: it will run as you.
    if (!window.confirm(`Add “${name}”? This computer will run:\n\n${[command, ...args].join(" ")}`)) {
        return;
    }

    await update({ mcpServers: [...settings.mcpServers, { args, command, env, name }] });
    event.target.reset();
});

await listen("neore:device-prompt", () => void refreshPrompt());
window.addEventListener("focus", () => void refreshPrompt());
await refreshPrompt();
