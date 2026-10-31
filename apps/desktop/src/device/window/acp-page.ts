/**
 * The coding-agents part of the local device window: register an agent, set its environment variables, start
 * a session in a folder, talk to it, stop it. Everything an agent wrote is rendered with `textContent`.
 * Variable values are typed here and never read back: the core returns names only.
 */
import type { CapabilityReport } from "@neore/ai/capabilities";

import type { HooksView } from "../../acp/hooks/types";
import type { RegistryListing } from "../../acp/registry";
import type { AcpView, ImportSummary, NativeSessionView, PermissionView, SessionSnapshot, SessionSummary, ToolStatus } from "../../acp/types";
import { canImportSessions } from "./import-control";
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
    /** The saved sessions being offered for import, and where they are from. */
    importing?: { agentKey: string; folder: string; sessions: NativeSessionView[] };
    listings: RegistryListing[];
    /** What each agent reported at its last start, by key. */
    reports: Record<string, CapabilityReport>;
    requests: PermissionView[];
    /** Counts registry searches: only the answer to the latest one is shown. */
    searchSerial: number;
    selected?: string;
    sessions: SessionSummary[];
    signature: string;
    view: AcpView;
} = { listings: [], reports: {}, requests: [], searchSerial: 0, sessions: [], signature: "", view: { agents: [], consents: [], envNames: [] } };

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

        await refreshReports();
        $("acp-notice").textContent = `${agentLabel(key)}: ${result.agentName || "agent"} ${result.agentVersion}, protocol ${String(result.protocolVersion)}. No session was opened.${canImportSessions(state.reports[key]) ? " Its saved sessions can be imported." : ""}`;
    });

// ─── Importing saved sessions ───────────────────────────────────────────────

const refreshReports = async (): Promise<void> => {
    state.reports = await globalThis.neoreDevice.acpReports();

    // An agent that was changed reports nothing until it starts again: its open list goes with the control.
    if (state.importing !== undefined && !canImportSessions(state.reports[state.importing.agentKey])) {
        state.importing = undefined;
        renderImport();
    }

    renderAgents();
};

const importedText = (summary: ImportSummary): string => {
    if (summary.status === "already") {
        return "That session is already in Neore; nothing was added.";
    }

    const notes = [
        summary.droppedTurns > 0 ? `${String(summary.droppedTurns)} later turns were not kept` : "",
        summary.shortenedTurns > 0 ? `${String(summary.shortenedTurns)} turns have a message cut to the size Neore stores` : "",
    ].filter(Boolean);

    return `Imported ${String(summary.turns)} turns as a thread in Neore.${notes.length === 0 ? "" : ` ${notes.join("; ")}.`}`;
};

const renderImport = (): void => {
    const { importing } = state;

    $("acp-import").hidden = importing === undefined;

    if (importing === undefined) {
        return;
    }

    const { agentKey, folder, sessions } = importing;

    $("acp-import-heading").textContent = `Saved sessions of ${agentLabel(agentKey)} in ${folder}`;
    $("acp-import-list").replaceChildren(
        ...sessions.length === 0
            ? [item("None.")]
            : sessions.map((session) => {
                const when = session.updatedAt === "" ? "" : ` · ${new Date(session.updatedAt).toLocaleString()}`;
                const name = session.title === "" ? "Untitled session" : session.title;

                return item(
                    `${name}${when}`,
                    button("Import", `Import the session ${name}`, () => {
                        guarded(async () => {
                            $("acp-notice").textContent = "Importing…";
                            $("acp-notice").textContent = importedText(await globalThis.neoreDevice.acpImport(agentKey, folder, session.sessionId, session.title === "" ? undefined : session.title));
                        });
                    }),
                );
            }),
    );
};

const openImport = (agentKey: string, folder: string) =>
    guarded(async () => {
        $("acp-notice").textContent = "Asking the agent for its saved sessions…";
        state.importing = { agentKey, folder, sessions: await globalThis.neoreDevice.acpImportList(agentKey, folder) };
        $("acp-notice").textContent = "";
        renderImport();
    });

const renderAgents = (): void => {
    const { view } = state;

    $("acp-agents").replaceChildren(
        ...view.agents.length === 0
            ? [item("No agents yet.")]
            : view.agents.flatMap((agent) => [
                item(
                    agent.install === null
                        ? `${agent.label}: ${[agent.command, ...agent.args].join(" ")}`
                        : `${agent.label} ${agent.install.version} from the registry, by ${agent.install.publisher} (pinned, checksum ${agent.install.sha256.slice(0, 12)}…)`,
                    button("Check version", `Check the version of ${agent.label}`, () => probe(agent.key)),
                    button("Approve a folder…", `Approve a folder for ${agent.label}`, () => approveFolder(agent.key)),
                    button("Remove", `Remove ${agent.label}`, () => {
                        guarded(async () => {
                            if (!await globalThis.neoreDevice.confirm(`Remove “${agent.label}”, its variables${agent.install === null ? "" : " and its installed files"}?`)) {
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
                            // Only for an agent that said it can; a missing, unknown or not-offered answer shows nothing.
                            ...canImportSessions(state.reports[agent.key])
                                ? [button("Import sessions…", `Import saved sessions of ${agent.label} in ${consent.folderPath}`, () => openImport(agent.key, consent.folderPath))]
                                : [],
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

// ─── Registry ───────────────────────────────────────────────────────────────

const installFromRegistry = (listing: RegistryListing) =>
    guarded(async () => {
        // The main process words and shows the confirmation (publisher, version, source); this only asks.
        const view = await globalThis.neoreDevice.acpRegistryInstall(listing.id, listing.version);

        if (view === null) {
            return;
        }

        state.view = view;
        renderAgents();
        renderRegistry(state.listings);
        $("acp-notice").textContent = `${listing.name} ${listing.version} is installed. Approve a folder for it to use it.`;
    });

const renderRegistry = (listings: RegistryListing[]): void => {
    state.listings = listings;

    $("acp-registry-results").replaceChildren(
        ...listings.length === 0
            ? [item("No agents found.")]
            : listings.map((listing) => {
                const installed = state.view.agents.find((agent) => agent.key === listing.id)?.install;
                const li = item(
                    `${listing.name} ${listing.version} · by ${listing.publisher} · ${listing.license}`,
                    ...listing.installable
                        ? [button(installed === null || installed === undefined ? "Install…" : "Reinstall…", `Install ${listing.name} ${listing.version}`, () => installFromRegistry(listing))]
                        : [],
                );
                const note = document.createElement("small");

                note.className = "muted";
                note.textContent = listing.installable ? listing.description : `Not installable here: ${listing.reason ?? "unknown"}`;
                li.append(note);

                return li;
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

const HOOK_STATE_TEXT: Record<HooksView["state"], string> = {
    approved: "Approved. File events and the manual hooks below can prompt this session.",
    changed: "This file changed since you approved it. Nothing fires until you approve it again.",
    invalid: "This file is not a valid hooks file, so nothing fires.",
    none: "",
    unapproved: "Not approved. Nothing fires until you approve this file.",
};

const hookWhen = (hook: HooksView["hooks"][number]): string => hook.event === "manual" ? "Run by a button" : `When a file matching ${hook.glob ?? ""} is ${hook.event}`;

const hookLine = (view: HooksView, sessionId: string, hook: HooksView["hooks"][number]): HTMLLIElement => {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    const when = document.createElement("span");
    const prompt = document.createElement("pre");

    title.textContent = hook.name;
    when.className = "muted";
    when.textContent = ` — ${hookWhen(hook)}. Sends:`;
    prompt.textContent = hook.prompt;
    li.append(title, when, prompt);

    if (hook.event === "manual" && view.state === "approved" && view.hash !== undefined) {
        const { hash } = view;

        li.append(button("Run", `Run the hook ${hook.name}`, () => guarded(async () => {
            await globalThis.neoreDevice.acpHookRun(sessionId, hook.id, hash);
            $("acp-notice").textContent = `${hook.name} sent to the agent.`;
        })));
    }

    return li;
};

/** Streamed text re-renders the session many times a second; the file is read again at most this often unless the session or its status changed. */
const HOOKS_REFRESH_MS = 1500;
const hooksPanel: { read?: { at: number; id: string; status: string }; serial: number; trailing?: ReturnType<typeof setTimeout> } = { serial: 0 };

const renderHooks = async (snapshot: SessionSnapshot, force = false): Promise<void> => {
    const now = Date.now();

    if (!force && hooksPanel.read?.id === snapshot.id && hooksPanel.read.status === snapshot.status && now - hooksPanel.read.at < HOOKS_REFRESH_MS) {
        // A change that arrives inside the window (the file itself being edited, say) is still read once the window is over.
        hooksPanel.trailing ??= setTimeout(() => {
            hooksPanel.trailing = undefined;

            if (state.selected === snapshot.id) {
                renderHooks(snapshot, true);
            }
        }, HOOKS_REFRESH_MS);

        return;
    }

    hooksPanel.read = { at: now, id: snapshot.id, status: snapshot.status };
    hooksPanel.serial += 1;

    const mine = hooksPanel.serial;
    let view: HooksView;

    try {
        view = snapshot.status === "ended" ? { hooks: [], state: "none", watching: false } : await globalThis.neoreDevice.acpHooks(snapshot.id);
    } catch {
        view = { hooks: [], state: "none", watching: false };
    }

    // The session on show changed while the file was read.
    if (mine !== hooksPanel.serial) {
        return;
    }

    const panel = $("acp-hooks");

    panel.hidden = view.state === "none";
    const unwatched = view.state !== "invalid" && !view.watching ? " The folder is not being watched, so file hooks cannot fire; manual hooks still work." : "";

    $("acp-hooks-state").textContent = `${view.state === "invalid" ? `${HOOK_STATE_TEXT.invalid} ${view.error ?? ""}` : HOOK_STATE_TEXT[view.state]}${unwatched}`;
    $("acp-hooks-list").replaceChildren(...view.hooks.map((hook) => hookLine(view, snapshot.id, hook)));

    const actions: HTMLElement[] = [];
    const { hash } = view;

    if (hash !== undefined && (view.state === "unapproved" || view.state === "changed")) {
        actions.push(button("Approve these hooks", "Approve the hooks file shown above", () => guarded(async () => {
            await globalThis.neoreDevice.acpHooksApprove(snapshot.id, hash);
            await renderHooks(snapshot, true);
        })));
    }

    if (view.state === "approved" || view.state === "changed") {
        actions.push(button("Revoke approval", "Revoke the approval of this hooks file", () => guarded(async () => {
            await globalThis.neoreDevice.acpHooksRevoke(snapshot.id);
            await renderHooks(snapshot, true);
        })));
    }

    $("acp-hooks-actions").replaceChildren(...actions);
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

    const snapshot = state.selected === undefined ? undefined : await globalThis.neoreDevice.acpSession(state.selected);

    renderSession(snapshot);

    if (snapshot !== undefined) {
        await renderHooks(snapshot);
    }
};

const selectedId = (): string => {
    if (state.selected === undefined) {
        throw new Error("open a session first");
    }

    return state.selected;
};

/** What the native confirmation shows whole; it refuses anything longer. */
const MAX_CONFIRM_CHARS = 1000;

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
            const question = `Add “${label}”? This computer will run:\n\n${[command, ...args].join(" ")}`;

            if (question.length > MAX_CONFIRM_CHARS) {
                throw new Error("The command line is too long to confirm. Shorten the name, command or arguments.");
            }

            if (!await globalThis.neoreDevice.confirm(question)) {
                return;
            }

            state.view = await globalThis.neoreDevice.acpUpdate({ args, command, key: slug(label), label, op: "saveAgent" });
            ($("acp-agent-form") as HTMLFormElement).reset();
            renderAgents();
        });
    });

    $("acp-registry-form").addEventListener("submit", (event) => {
        event.preventDefault();
        guarded(async () => {
            state.searchSerial += 1;

            const mine = state.searchSerial;
            const found = await globalThis.neoreDevice.acpRegistrySearch(field("acp-registry-query"));

            // A newer search was submitted meanwhile: its answer is the one to show.
            if (mine !== state.searchSerial) {
                return;
            }

            renderRegistry(found);
            // The notice is the page's live region: a list that changes silently is invisible to a screen reader.
            $("acp-notice").textContent = `${String(found.length)} ${found.length === 1 ? "agent" : "agents"} found.`;
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

    $("acp-import-close").addEventListener("click", () => {
        state.importing = undefined;
        renderImport();
    });

    globalThis.neoreDevice.onAcpChanged(async () => {
        try {
            await Promise.all([refreshRequests(), refreshSessions(), refreshReports()]);
        } catch (error) {
            showError(error);
        }
    });

    await guarded(async () => {
        state.view = await globalThis.neoreDevice.acpView();
        renderAgents();
        await Promise.all([refreshRequests(), refreshSessions(), refreshReports()]);
    });
};
