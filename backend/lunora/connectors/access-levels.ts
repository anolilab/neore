/**
 * What a teammate may do through one connection: read only, read and write (the default, as before this existed), or no
 * access. Set per teammate and per connection (`access.ts`), and enforced where a run's tools are offered
 * (`chat/lib/agent-tools.ts`). A pure module: the rules here are the whole decision.
 */

export const CONNECTOR_ACCESS_LEVELS = ["read_only", "read_write", "none"] as const;

export type ConnectorAccessLevel = (typeof CONNECTOR_ACCESS_LEVELS)[number];

/** What a connection gives a teammate that has no setting for it. */
export const DEFAULT_CONNECTOR_ACCESS: ConnectorAccessLevel = "read_write";

/** The hints an MCP server gives about one of its tools. A write tool carries no `readOnlyHint: true`. */
export interface ToolHints {
    readOnlyHint?: boolean;
}

/**
 * Whether a tool of a connection set to `level` is offered to the run. `none` offers nothing. `read_only` offers only the
 * tools the server marks read only, so a write tool, which carries no such mark, is never offered. `read_write` offers all.
 */
export const toolOfferedAt = (level: ConnectorAccessLevel, hints: ToolHints | undefined): boolean => {
    if (level === "none") {
        return false;
    }

    if (level === "read_only") {
        return hints?.readOnlyHint === true;
    }

    return true;
};

/** The level a teammate has on a connection: its setting, or the default when it has none. */
export const levelOfConnection = (
    settings: ReadonlyArray<{ connectorSlug: string; level: ConnectorAccessLevel }>,
    connectorSlug: string,
): ConnectorAccessLevel => settings.find((setting) => setting.connectorSlug === connectorSlug)?.level ?? DEFAULT_CONNECTOR_ACCESS;

/**
 * The most restrictive of several levels, for a call that names no thread and so no one teammate: `none` if any teammate has
 * none, else `read_only` if any has it, else read and write. No levels at all is the default.
 */
export const strictestLevel = (levels: ReadonlyArray<ConnectorAccessLevel>): ConnectorAccessLevel => {
    if (levels.includes("none")) {
        return "none";
    }

    if (levels.includes("read_only")) {
        return "read_only";
    }

    return DEFAULT_CONNECTOR_ACCESS;
};
