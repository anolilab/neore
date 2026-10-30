export type WorkspaceMode = "chat" | "code";

const STORAGE_KEY = "workspace-last-route";
const ROOTS: Record<WorkspaceMode, string> = { chat: "/chat", code: "/code" };

type Memory = Partial<Record<WorkspaceMode, string>>;
type Store = Pick<Storage, "getItem" | "setItem">;

/** Which workspace a pathname belongs to; `undefined` for any other page. */
export const workspaceOf = (pathname: string): WorkspaceMode | undefined => {
    for (const mode of Object.keys(ROOTS) as WorkspaceMode[]) {
        const root = ROOTS[mode];

        if (pathname === root || pathname.startsWith(`${root}/`)) {
            return mode;
        }
    }

    return undefined;
};

const read = (store: Store): Memory => {
    try {
        const parsed: unknown = JSON.parse(store.getItem(STORAGE_KEY) ?? "{}");

        return parsed && typeof parsed === "object" ? (parsed as Memory) : {};
    } catch {
        return {};
    }
};

/** Remembers the page the user was last on inside a workspace. A path outside that workspace is ignored. */
export const rememberWorkspaceRoute = (store: Store, pathname: string): void => {
    const mode = workspaceOf(pathname);

    if (!mode) {
        return;
    }

    try {
        store.setItem(STORAGE_KEY, JSON.stringify({ ...read(store), [mode]: pathname }));
    } catch {
        // Storage can be full or blocked; the switch then falls back to the workspace root.
    }
};

/** Where the switch sends the user: the workspace's last page, else its root. */
export const workspaceTarget = (store: Store | undefined, mode: WorkspaceMode): string => {
    const remembered = store ? read(store)[mode] : undefined;

    return remembered && workspaceOf(remembered) === mode ? remembered : ROOTS[mode];
};
