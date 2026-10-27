/**
 * The coding-agents part of the local device window: register an agent, set its environment variables, start
 * a session in a folder, talk to it, stop it. Everything an agent wrote is rendered with `textContent`.
 * Variable values are typed here and never read back: the core returns names only.
 */
import type { AcpView, PermissionView, SessionSnapshot, SessionSummary, ToolStatus } from "../../acp/types";
import { approveAllIds, barSignature, groupBySession } from "./permission-bar";

const TOOL_LABELS: Record<ToolStatus, string> = {
    cancelled: "stopped",
    completed: "done",
    declined: "declined",
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

/** Buttons on a bar that just changed stay disabled this long, so a click meant for the old bar cannot land on the new one. */
const CLICK_THROUGH_GUARD_MS = 800;

const state: {
    guard?: ReturnType<typeof setTimeout>;
    requests: PermissionView[];
    selected?: string;
    sessions: SessionSummary[];
    signature: string;
    view: AcpView;
} = { requests: [], sessions: [], signature: "", view: { agents: [], consents: [], envNames: [] } };

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
    const root = base === "" ? "agent" : base;
    let key = root;
    let n = 2;

    while (state.view.agents.some((agent) => agent.key === key)) {
        key = `${root}-${String(n)}`;
        n += 1;
    }

    return key;
};

const startIn = (key: string, folder: string) =>
    guarded(async () => {
        const id = await globalThis.neoreDevice.acpStart(key, folder);

        state.selected = id;
        await refreshSessions();
    });

const approveFolder = (key: string) =>
    guarded(async () => {
        const folder = await globalThis.neoreDevice.pickFolder();

        if (folder === null) {
            return;
        }

        const confirmed = await globalThis.neoreDevice.confirm(
            `Let “${agentLabel(key)}” work in ${folder}?\n\nIt runs as you. It is not confined to this folder, and anything it asks to do prompts you here first. You can stop approving at any time.`,
        );

        if (confirmed) {
            state.view = await globalThis.neoreDevice.acpUpdate({ agentKey: key, folder, op: "grant" });
            renderAgents();
        }
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
            : view.agents.flatMap((agent) => [
                item(
                    `${agent.label}: ${[agent.command, ...agent.args].join(" ")}`,
                    button("Check version", `Check the version of ${agent.label}`, () => probe(agent.key)),
                    button("Approve a folder…", `Approve a folder for ${agent.label}`, () => approveFolder(agent.key)),
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
                ...view.consents
                    .filter((consent) => consent.agentKey === agent.key)
                    .map((consent) =>
                        item(
                            `↳ ${consent.folderPath}`,
                            button("Start", `Start ${agent.label} in ${consent.folderPath}`, () => startIn(agent.key, consent.folderPath)),
                            button("Stop approving", `Stop approving ${agent.label} in ${consent.folderPath}`, () => {
                                guarded(async () => {
                                    state.view = await globalThis.neoreDevice.acpUpdate({ agentKey: agent.key, folderId: consent.folderId, op: "revoke" });
                                    renderAgents();
                                });
                            }),
                        ),
                    ),
            ]),
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

// ─── Requests waiting for the user ──────────────────────────────────────────

const answerRequests = (action: () => Promise<unknown>) =>
    guarded(async () => {
        try {
            await action();
        } finally {
            // A request that timed out or was answered elsewhere fails here, and the bar must still drop it.
            try {
                await refreshRequests();
            } catch {
                // The answer's own error is the one to show.
            }
        }
    });

const requestLine = (request: PermissionView): HTMLElement => {
    const box = document.createElement("div");
    const line = document.createElement("div");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const full = document.createElement("pre");
    const actions = document.createElement("div");

    box.className = "request";
    line.className = "line";
    line.textContent = [request.tool, request.target, request.folder].filter(Boolean).join(" · ");
    summary.textContent = request.command === null ? "Full details" : "Full command and details";
    full.tabIndex = 0;
    full.textContent = request.command === null ? request.details : `${request.command}\n\n${request.details}`;
    details.append(summary, full);
    actions.className = "row";

    for (const option of request.options) {
        const label = request.options.length > 1 ? `Allow once: ${option.name}` : "Allow once";

        actions.append(button(label, `${label}: ${request.tool}`, () => answerRequests(() => globalThis.neoreDevice.acpPermissionAnswer(request.id, option.optionId))));
    }

    actions.append(button("Deny", `Deny: ${request.tool}`, () => answerRequests(() => globalThis.neoreDevice.acpPermissionDecline(request.id))));
    box.append(line, details, actions);

    return box;
};

const renderRequests = (): void => {
    const bar = $("acp-requests");
    const groups = groupBySession(state.requests);
    const signature = barSignature(state.requests);
    const changed = signature !== state.signature;

    // Redrawing for nothing would re-enable the buttons the guard holds still, and fold the panels the user opened.
    if (!changed) {
        return;
    }

    state.signature = signature;
    bar.hidden = groups.length === 0;
    bar.replaceChildren(
        ...groups.map((group) => {
            const section = document.createElement("div");
            const heading = document.createElement("h2");
            const ids = approveAllIds(group);

            heading.textContent = `${group.agentLabel} asks (${String(group.requests.length)})`;
            section.append(heading, ...group.requests.map((request) => requestLine(request)));

            // The ids are the ones drawn here. A request that arrives later redraws the bar, and answers only itself until the user presses again.
            if (ids !== undefined) {
                const all = button(`Approve all (${String(ids.length)})`, `Allow once each of the ${String(ids.length)} requests from ${group.agentLabel}`, () =>
                    answerRequests(() => globalThis.neoreDevice.acpPermissionAnswerBatch(ids)));

                all.classList.add("primary");
                section.append(all);
            }

            return section;
        }),
    );

    if (groups.length > 0) {
        const buttons = [...bar.querySelectorAll("button")];

        for (const element of buttons) {
            element.disabled = true;
        }

        clearTimeout(state.guard);
        state.guard = setTimeout(() => {
            if (state.signature === signature) {
                for (const element of buttons) {
                    element.disabled = false;
                }
            }
        }, CLICK_THROUGH_GUARD_MS);
    }
};

const refreshRequests = async (): Promise<void> => {
    state.requests = await globalThis.neoreDevice.acpPermissions();
    renderRequests();
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
            await Promise.all([refreshRequests(), refreshSessions()]);
        } catch (error) {
            showError(error);
        }
    });

    await guarded(async () => {
        state.view = await globalThis.neoreDevice.acpView();
        renderAgents();
        await Promise.all([refreshRequests(), refreshSessions()]);
    });
};
