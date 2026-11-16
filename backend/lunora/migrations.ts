import { defineMigration } from "lunorash/server";

/**
 * The agent's options moved to the state the session row holds now (`agentState`, `optionResult`). The `agentOptions` and
 * `agentOptionsAt` fields are gone from the schema, so a row written with them drops them, and no stored row keeps a field the
 * schema does not declare.
 */
export const dropAgentOptionFields = defineMigration({
    id: "drop-agent-option-fields",
    table: "acpSessions",
    up: (document) => {
        const row: Record<string, unknown> = { ...document };

        delete row.agentOptions;
        delete row.agentOptionsAt;

        return row as typeof document;
    },
});

/** The event #580 posted for a session's options (`session_options`), as a stored chunk still holds it. */
type LegacySessionOptions = {
    kind: "session_options";
    options?: {
        configOptions?: unknown[];
        modes?: { available: { name: string; value: string }[]; current: string };
    };
};

/**
 * A stored `session_options` chunk becomes the `session_state` event that carries the same options now. Its option lists keep
 * their shape. A mode's identifier is `id` in `session_state` (`value` in the old list). The old event held no time, so the
 * chunk's creation time stands in for it. Chunks of other events are left as they are.
 */
export const sessionOptionsToSessionState = defineMigration({
    id: "session-options-to-session-state",
    table: "persistentChunks",
    up: (document) => {
        const { _creationTime: created, event } = document as unknown as { _creationTime?: number; event?: LegacySessionOptions | { kind: string } };

        if (event === undefined || event.kind !== "session_options") {
            return undefined;
        }

        const { options = {} } = event as LegacySessionOptions;
        const { modes } = options;
        const converted = {
            at: typeof created === "number" ? created : 0,
            kind: "session_state",
            ...(options.configOptions !== undefined && { configOptions: options.configOptions }),
            ...(modes !== undefined && {
                modes: {
                    available: modes.available.map((mode) => {
                        return { id: mode.value, name: mode.name };
                    }),
                    current: modes.current,
                },
            }),
        };

        return { ...document, event: converted } as typeof document;
    },
});
