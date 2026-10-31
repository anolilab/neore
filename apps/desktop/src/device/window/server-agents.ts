/**
 * The coding agents of one server, in the local window (plans/ssh-environments.md §7, S7). The agent's command is a path ON
 * the server and a folder is one of the folders shared for it; both are decided here, by the person, and nowhere else.
 * Pure text helpers first, so what the person is asked to confirm is tested; the DOM follows.
 */
import type { AcpUpdate } from "../../acp/types";
import type { HostView } from "../types";

/** The native confirmation shows at most this much (`LOCAL_CHANNEL.confirm`). */
const MAX_CONFIRM_CHARS = 1000;

type Agent = HostView["acpAgents"][number];

const NON_KEY = /[^a-z0-9]+/u;
const TRAILING_DASH = /-$/u;

/** The key for an agent: its name in `a-z0-9-`, unique among the server's agents. */
export const agentKeyFor = (name: string, taken: string[]): string => {
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

    while (taken.includes(key)) {
        key = `${root}-${String(n)}`;
        n += 1;
    }

    return key;
};

export const agentLine = (agent: Agent): string => `${agent.label}: ${[agent.command, ...agent.args].join(" ")}`;

/** What the person confirms before an agent is added for a server: the exact command line it will run there. */
export const addAgentQuestion = (server: string, label: string, command: string, args: string[]): string => {
    const question = `Add “${label}” for ${server}? ${server} will run:\n\n${[command, ...args].join(" ")}`;

    if (question.length > MAX_CONFIRM_CHARS) {
        throw new Error("The command line is too long to confirm. Shorten the name, command or arguments.");
    }

    return question;
};

/** What the person confirms before approving an agent for a folder: it runs with their rights, beside the sandbox. */
export const approveQuestion = (server: string, agent: string, folder: string): string => {
    const question = `Let ${agent} work in ${folder} on ${server}? It runs with your rights on ${server}, beside the shell sandbox, and asks before each action.`;

    if (question.length > MAX_CONFIRM_CHARS) {
        throw new Error("The folder name is too long to confirm.");
    }

    return question;
};

export const approvalLine = (host: Pick<HostView, "acpAgents">, consent: HostView["acpConsents"][number]): string =>
    `${host.acpAgents.find((agent) => agent.key === consent.agentKey)?.label ?? consent.agentKey} in ${consent.folderPath}`;

/** Why the server cannot run agents yet, or `null` when it can (or is not connected, so nothing is known). */
export const unsupportedNote = (host: Pick<HostView, "agentsSupported" | "name">): string | null =>
    host.agentsSupported === false
        ? `The host software on ${host.name} does not run coding agents yet. Choose “Install host software” while it is disconnected.`
        : null;

export interface SectionHelpers {
    button: (label: string, onClick: () => void, description?: string) => HTMLButtonElement;
    listItem: (label: string, action?: string, onAction?: () => void) => HTMLLIElement;
    /** Runs a change and shows how it went. */
    run: (work: () => Promise<unknown>, done: string) => Promise<void>;
    /** Shows a message in the window's status line. */
    status: (text: string) => void;
}

/** A label and its control in a row. The control must already carry `id`. */
const labelled = (id: string, text: string, control: HTMLElement): HTMLElement => {
    const label = document.createElement("label");

    label.htmlFor = id;
    label.textContent = text;

    const wrapper = document.createElement("div");

    wrapper.className = "row";
    wrapper.append(label, control);

    return wrapper;
};

export const serverAgentsSection = (host: HostView, helpers: SectionHelpers): HTMLElement => {
    const section = document.createElement("div");
    const heading = document.createElement("h4");
    const note = document.createElement("p");
    const agents = document.createElement("ul");
    const approvals = document.createElement("ul");
    const id = (name: string): string => `host-${name}-${host.deviceId}`;
    const update = (change: AcpUpdate, done: string): Promise<void> =>
        helpers.run(() => globalThis.neoreDevice.hostAcpUpdate(host.deviceId, change), done);

    section.setAttribute("role", "group");
    heading.id = id("agents-heading");
    section.setAttribute("aria-labelledby", heading.id);
    heading.textContent = `Coding agents on ${host.name}`;
    note.className = "muted";
    note.textContent = `An approved agent runs on ${host.name} with your rights, beside the shell sandbox, and asks before each action. It starts only in a folder you approve here.`;

    agents.replaceChildren(
        ...host.acpAgents.length === 0
            ? [helpers.listItem("No agents yet.")]
            : host.acpAgents.map((agent) => helpers.listItem(agentLine(agent), "Remove", () => {
                update({ key: agent.key, op: "removeAgent" }, "Agent removed.");
            })),
    );
    approvals.replaceChildren(
        ...host.acpConsents.length === 0
            ? [helpers.listItem("No approvals: no agent can start on this server.")]
            : host.acpConsents.map((consent) => helpers.listItem(approvalLine(host, consent), "Revoke", () => {
                update({ agentKey: consent.agentKey, folderId: consent.folderId, op: "revoke" }, "Approval revoked.");
            })),
    );

    const name = document.createElement("input");
    const command = document.createElement("input");
    const args = document.createElement("textarea");

    name.id = id("agent-name");
    command.id = id("agent-command");
    args.id = id("agent-args");

    for (const input of [name, command]) {
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
    }

    command.placeholder = "/path/on/the/server/agent";
    args.rows = 2;
    args.spellcheck = false;

    const addAgent = helpers.button("Add agent", async () => {
        try {
            const label = name.value.trim();
            const program = command.value.trim();

            if (label === "" || program === "") {
                throw new Error("A name and a command are required.");
            }

            const lines = args.value.split("\n").map((line) => line.trim()).filter(Boolean);

            if (!await globalThis.neoreDevice.confirm(addAgentQuestion(host.name, label, program, lines))) {
                return;
            }

            await update({ args: lines, command: program, key: agentKeyFor(label, host.acpAgents.map((agent) => agent.key)), label, op: "saveAgent" }, "Agent added.");
        } catch (error) {
            helpers.status(String(error));
        }
    }, host.name);

    const agent = document.createElement("select");
    const folder = document.createElement("input");
    const folders = document.createElement("datalist");

    agent.id = id("approve-agent");

    for (const registered of host.acpAgents) {
        const option = document.createElement("option");

        option.value = registered.key;
        option.textContent = registered.label;
        agent.append(option);
    }

    folder.id = id("approve-folder");
    folder.type = "text";
    folder.autocomplete = "off";
    folder.spellcheck = false;
    folder.placeholder = "/folder/on/the/server";
    folders.id = id("folders");
    folder.setAttribute("list", folders.id);
    folders.replaceChildren(...host.roots.map((root) => {
        const option = document.createElement("option");

        option.value = root;

        return option;
    }));

    const approve = helpers.button("Approve", async () => {
        try {
            const chosen = host.acpAgents.find((candidate) => candidate.key === agent.value);
            const path = folder.value.trim();

            if (chosen === undefined || path === "") {
                throw new Error("Choose an agent and a folder on the server.");
            }

            if (!await globalThis.neoreDevice.confirm(approveQuestion(host.name, chosen.label, path))) {
                return;
            }

            await update({ agentKey: chosen.key, folder: path, op: "grant" }, "Approved.");
        } catch (error) {
            helpers.status(String(error));
        }
    }, host.name);

    const unsupported = unsupportedNote(host);
    const warning = document.createElement("p");

    warning.className = "muted";
    warning.textContent = unsupported ?? "";
    warning.hidden = unsupported === null;

    const approveRow = document.createElement("div");

    approveRow.className = "row";
    approveRow.append(labelled(id("approve-agent"), "Agent", agent), labelled(id("approve-folder"), "Folder", folder), folders, approve);
    section.append(
        heading,
        note,
        warning,
        agents,
        labelled(id("agent-name"), "Name", name),
        labelled(id("agent-command"), "Command on the server", command),
        labelled(id("agent-args"), "Arguments, one per line", args),
        addAgent,
        approvals,
        approveRow,
    );

    return section;
};
