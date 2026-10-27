/**
 * The coding-agents part of the local device window: register an agent, set its environment variables, start
 * a session in a folder, talk to it, stop it. Everything an agent wrote is rendered with `textContent`.
 * Variable values are typed here and never read back: the core returns names only.
 */
import type { AcpView, SessionSnapshot, SessionSummary, ToolStatus } from "../../acp/types";

const TOOL_LABELS: Record<ToolStatus, string> = {
    cancelled: "stopped",
    completed: "done",
    failed: "failed",
    in_progress: "running",
    pending: "waiting",
};

const $ = <Element extends HTMLElement = HTMLElement>(id: string): Element => {
    const element = document.querySelector<Element>(`#${id}`);

    if (element === null) {
        throw new Error(`missing #${id}`);
    }

    return element;
};

/** Electron prefixes a rejected invoke with this; the reason follows. */
const IPC_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/u;
const NON_KEY = /[^a-z0-9]+/u;
const TRAILING_DASH = /-$/u;

const state: { selected?: string; sessions: SessionSummary[]; view: AcpView } = { sessions: [], view: { agents: [], envNames: [] } };

const showError = (error: unknown): void => {
    $("acp-error").textContent = String(error instanceof Error ? error.message : error).replace(IPC_PREFIX, "");
};

const clearError = (): void => {
    $("acp-error").textContent = "";
    $("acp-notice").textContent = "";
};

const field = (id: string): string => $<HTMLInputElement | HTMLTextAreaElement>(id).value;

const guarded = async (action: () => Promise<void>): Promise<void> => {
    clearError();

    try {
        await action();
    } catch (error) {
        showError(error);
    }
};

const button = (label: string, ariaLabel: string, onClick: () => void): HTMLButtonElement => {
    const element = document.createElement("button");

    element.type = "button";
    element.textContent = label;
    element.setAttribute("aria-label", ariaLabel);
    element.addEventListener("click", onClick);

    return element;
};

const item = (label: string, ...actions: HTMLElement[]): HTMLLIElement => {
    const li = document.createElement("li");
    const text = document.createElement("span");

    text.textContent = label;
    li.append(text);

    if (actions.length > 0) {
        const group = document.createElement("span");

        group.className = "row";
        group.append(...actions);
        li.append(group);
    }

    return li;
};

// ─── Agents and variables ───────────────────────────────────────────────────

const agentLabel = (key: string): string => state.view.agents.find((agent) => agent.key === key)?.label ?? key;

const slug = (name: string): string => {
    const base = name
        .toLowerCase()
        .split(NON_KEY)
        .filter(Boolean)
        .join("-")
        .slice(0, 30)
        .replace(TRAILING_DASH, "");
    let key = base === "" ? "agent" : base;
    let n = 2;

    while (state.view.agents.some((agent) => agent.key === key)) {
        key = `${base}-${String(n)}`;
        n += 1;
    }

    return key;
};

const startIn = (key: string) =>
    guarded(async () => {
        const folder = await globalThis.neoreDevice.pickFolder();

        if (folder === null) {
            return;
        }

        const id = await globalThis.neoreDevice.acpStart(key, folder);

        state.selected = id;
        await refreshSessions();
    });

const probe = (key: string) =>
    guarded(async () => {
        const result = await globalThis.neoreDevice.acpProbe(key);

        $("acp-notice").textContent = `${agentLabel(key)}: ${result.agentName || "agent"} ${result.agentVersion}, protocol ${String(result.protocolVersion)}. No session was opened.`;
    });

const renderAgents = (): void => {
    const { view } = state;

    $("acp-agents").replaceChildren(
        ...view.agents.length === 0
            ? [item("No agents yet.")]
            : view.agents.map((agent) =>
                item(
                    `${agent.label}: ${[agent.command, ...agent.args].join(" ")}`,
                    button("Check version", `Check the version of ${agent.label}`, () => probe(agent.key)),
                    button("Start in a folder…", `Start ${agent.label} in a folder`, () => startIn(agent.key)),
                    button("Remove", `Remove ${agent.label}`, () => {
                        guarded(async () => {
                            if (!await globalThis.neoreDevice.confirm(`Remove “${agent.label}” and its variables?`)) {
                                return;
                            }

                            state.view = await globalThis.neoreDevice.acpUpdate({ key: agent.key, op: "removeAgent" });
                            renderAgents();
                        });
                    }),
                ),
            ),
    );

    const scope = $<HTMLSelectElement>("acp-env-scope");
    const chosen = scope.value;

    scope.replaceChildren(
        new Option("All agents", ""),
        ...view.agents.map((agent) => new Option(agent.label, agent.key)),
    );
    scope.value = chosen;

    const variables = [
        ...view.envNames.map((name) => { return { agentKey: undefined as string | undefined, name }; }),
        ...view.agents.flatMap((agent) => agent.envNames.map((name) => { return { agentKey: agent.key, name }; })),
    ];

    $("acp-env").replaceChildren(
        ...variables.length === 0
            ? [item("None.")]
            : variables.map(({ agentKey, name }) => {
                const owner = agentKey === undefined ? "All agents" : agentLabel(agentKey);

                return item(
                    `${owner}: ${name} = ••••••••`,
                    button("Remove", `Remove ${name} for ${owner}`, () => {
                        guarded(async () => {
                            state.view = await globalThis.neoreDevice.acpUpdate({ agentKey, name, op: "removeEnv" });
                            renderAgents();
                        });
                    }),
                );
            }),
    );
};

// ─── Sessions ───────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<SessionSnapshot["status"], string> = {
    busy: "Working…",
    ended: "Ended",
    idle: "Ready",
    starting: "Starting…",
};

const renderTranscript = (snapshot: SessionSnapshot): void => {
    const box = $("acp-transcript");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    const nodes: HTMLElement[] = [];

    for (const turn of snapshot.turns) {
        const user = document.createElement("p");

        user.className = "user";
        user.textContent = `You: ${turn.user}`;
        nodes.push(user);

        if (turn.thought !== "") {
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            const thought = document.createElement("pre");

            summary.textContent = "Reasoning";
            thought.textContent = turn.thought;
            details.append(summary, thought);
            nodes.push(details);
        }

        if (turn.tools.length > 0) {
            const tools = document.createElement("ul");

            tools.className = "tools";
            tools.append(...turn.tools.map((tool) => item(`${tool.title} — ${TOOL_LABELS[tool.status]}`)));
            nodes.push(tools);
        }

        if (turn.text !== "") {
            const reply = document.createElement("pre");

            reply.textContent = turn.truncated ? `${turn.text}\n[cut: the reply was longer than this window keeps]` : turn.text;
            nodes.push(reply);
        }

        if (turn.stopReason !== undefined && turn.stopReason !== "end_turn") {
            const note = document.createElement("p");

            note.className = "muted";
            note.textContent = `Stopped: ${turn.stopReason.replaceAll("_", " ")}`;
            nodes.push(note);
        }
    }

    box.replaceChildren(...nodes);

    if (atBottom) {
        box.scrollTop = box.scrollHeight;
    }
};

const renderSession = (snapshot: SessionSnapshot | undefined): void => {
    $("acp-session").hidden = snapshot === undefined;

    if (snapshot === undefined) {
        return;
    }

    const ended = snapshot.status === "ended";

    $("acp-session-title").textContent = `${snapshot.agentLabel} in ${snapshot.folder}`;
    $("acp-session-status").textContent = ended && snapshot.endReason !== undefined ? `Ended: ${snapshot.endReason}` : STATUS_TEXT[snapshot.status];
    renderTranscript(snapshot);
    $("acp-queued").replaceChildren(...snapshot.queued.map((prompt, index) => item(`Waiting (${String(index + 1)}): ${prompt}`)));
    $<HTMLButtonElement>("acp-send").disabled = ended || snapshot.status === "starting";
    $<HTMLButtonElement>("acp-stop").disabled = snapshot.status !== "busy";
    $<HTMLButtonElement>("acp-end").textContent = ended ? "Remove session" : "End session";
};

const refreshSessions = async (): Promise<void> => {
    state.sessions = await globalThis.neoreDevice.acpSessions();

    if (state.selected !== undefined && state.sessions.every((session) => session.id !== state.selected)) {
        state.selected = undefined;
    }

    $("acp-sessions").replaceChildren(
        ...state.sessions.length === 0
            ? [item("None.")]
            : state.sessions.map((session) => {
                const label = `${session.agentLabel} in ${session.folder} — ${STATUS_TEXT[session.status]}${session.queued > 0 ? `, ${String(session.queued)} waiting` : ""}`;

                return item(
                    label,
                    button(state.selected === session.id ? "Showing" : "Open", `Open the session with ${session.agentLabel} in ${session.folder}`, () => {
                        state.selected = session.id;
                        refreshSessions();
                    }),
                );
            }),
    );

    renderSession(state.selected === undefined ? undefined : await globalThis.neoreDevice.acpSession(state.selected));
};

const selectedId = (): string => {
    if (state.selected === undefined) {
        throw new Error("open a session first");
    }

    return state.selected;
};

export const initAcp = async (): Promise<void> => {
    $("acp-agent-form").addEventListener("submit", (event) => {
        event.preventDefault();
        guarded(async () => {
            const label = field("acp-name").trim();
            const command = field("acp-command").trim();

            if (label === "" || command === "") {
                throw new Error("A name and a command are required.");
            }

            const args = field("acp-args")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);

            // The exact command line, confirmed once more: it will run as you.
            if (!await globalThis.neoreDevice.confirm(`Add “${label}”? This computer will run:\n\n${[command, ...args].join(" ")}`)) {
                return;
            }

            state.view = await globalThis.neoreDevice.acpUpdate({ args, command, key: slug(label), label, op: "saveAgent" });
            ($("acp-agent-form") as HTMLFormElement).reset();
            renderAgents();
        });
    });

    $("acp-env-form").addEventListener("submit", (event) => {
        event.preventDefault();
        guarded(async () => {
            const agentKey = $<HTMLSelectElement>("acp-env-scope").value || undefined;

            state.view = await globalThis.neoreDevice.acpUpdate({ agentKey, name: field("acp-env-name").trim(), op: "setEnv", value: field("acp-env-value") });
            // The value is not kept anywhere in the page once it is saved.
            ($("acp-env-form") as HTMLFormElement).reset();
            renderAgents();
        });
    });

    $("acp-prompt-form").addEventListener("submit", (event) => {
        event.preventDefault();
        guarded(async () => {
            const prompt = field("acp-prompt");

            if (prompt.trim() === "") {
                return;
            }

            await globalThis.neoreDevice.acpSend(selectedId(), prompt);
            $<HTMLTextAreaElement>("acp-prompt").value = "";
        });
    });

    $("acp-stop").addEventListener("click", () => guarded(() => globalThis.neoreDevice.acpCancel(selectedId())));
    $("acp-end").addEventListener("click", () => {
        guarded(async () => {
            const id = selectedId();

            await (state.sessions.find((session) => session.id === id)?.status === "ended" ? globalThis.neoreDevice.acpForget(id) : globalThis.neoreDevice.acpClose(id));
            await refreshSessions();
        });
    });

    globalThis.neoreDevice.onAcpChanged(async () => {
        try {
            await refreshSessions();
        } catch (error) {
            showError(error);
        }
    });

    await guarded(async () => {
        state.view = await globalThis.neoreDevice.acpView();
        renderAgents();
        await refreshSessions();
    });
};
