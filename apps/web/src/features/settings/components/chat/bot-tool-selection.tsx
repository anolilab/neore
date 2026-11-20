"use client";

import { useLingui } from "@lingui/react/macro";
import type { BotToolSelection } from "@neore/backend/bots/tool-selectors";
import {
    BOT_TOOL_SELECTION_MAX_LIST_CHARS,
    BOT_TOOL_SELECTOR_MAX_COUNT,
    BOT_TOOL_SELECTOR_MAX_LENGTH,
    connectorServerKey,
    deviceServerKey,
    mcpServerKey,
    parseServerSelector,
} from "@neore/backend/bots/tool-selectors";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@neore/ui/components/radio-group";
import { Switch } from "@neore/ui/components/switch";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { FC, FormEvent } from "react";
import { useId, useRef, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

/** A server the user can name in a selector: its display name, and the stable key the selector stores. */
export interface KnownToolServer {
    /**
     * A connector the user has not connected, or whose connection a run cannot use: its selectors stay valid (the run
     * matches a connector by its slug, so an exclusion keeps excluding once it is connected again), but it has no tools now.
     */
    disconnected?: boolean;
    key: string;
    name: string;
}

/**
 * Whether a run can use a connection: the statuses `listConnectorGrants` (`connectors/store.ts`) gives a run, where an
 * `error` is retried and an `expired` one is refreshed when it can be.
 */
const isUsableConnection = (connection: { hasRefreshToken: boolean; status: string }): boolean =>
    connection.status === "connected" || connection.status === "error" || (connection.status === "expired" && connection.hasRefreshToken);

/** What the lists offer and resolve against: every available built-in, and the user's servers, connectors and computers. */
export interface ToolCatalog {
    /** Every built-in tool's name, available or not, as the server checks a save against; `undefined` until it is read. */
    builtInNames?: ReadonlySet<string>;
    /** The built-in tools could not be read, so a bare name cannot be checked. */
    builtInNamesFailed?: boolean;
    builtIns: string[];
    /** Reads again whichever server lists failed. */
    retryServers?: () => void;
    servers: KnownToolServer[];
    /** Whether `servers` is complete: until every list is read, a selector naming an unlisted server is not known to be removed. */
    serversState: "error" | "loading" | "ready";
}

export const useToolCatalog = (): ToolCatalog => {
    const crpc = useCRPC();
    const { data: settings, isError: settingsFailed } = useQuery(crpc.chat.tool_permissions.getToolPermissionSettings.queryOptions({}));
    const preferencesQuery = useQuery(crpc.auth.functions.getAIUserPreferences.queryOptions({}));
    const connectorsQuery = useQuery(crpc.connectors.user_connectors.listConnectorCatalog.queryOptions({}));
    const devicesQuery = useQuery(crpc.devices.functions.listDevices.queryOptions({}));
    const { data: preferences } = preferencesQuery;
    const { data: connectors } = connectorsQuery;
    const { data: devices } = devicesQuery;
    const serverQueries = [preferencesQuery, connectorsQuery, devicesQuery];
    const failed = serverQueries.filter((query) => query.data === undefined && query.isError);
    const loading = serverQueries.some((query) => query.data === undefined && !query.isError);
    // A failed list counts over one still loading: its retry is what the person can do.
    let serversState: ToolCatalog["serversState"] = loading ? "loading" : "ready";

    if (failed.length > 0) {
        serversState = "error";
    }

    return {
        builtIns: (settings?.builtIn ?? []).flatMap((tool) => (tool.available ? [tool.name] : [])),
        builtInNames: settings && new Set(settings.builtIn.map((tool) => tool.name)),
        builtInNamesFailed: settings === undefined && settingsFailed,
        servers: [
            ...(preferences?.mcpServers ?? []).map((server) => {
                return { key: mcpServerKey(server.url), name: server.name };
            }),
            // Every connector, connected or not: a selector naming one that is disconnected is not a removed server.
            ...(connectors ?? []).map((connector) => {
                const disconnected = connector.connection === null || !isUsableConnection(connector.connection);

                return { key: connectorServerKey(connector.slug), name: connector.name, ...(disconnected && { disconnected }) };
            }),
            ...(devices ?? []).map((device) => {
                return { key: deviceServerKey(device._id), name: device.name };
            }),
        ].flatMap(({ key, ...server }) => (key === undefined ? [] : [{ key, ...server }])),
        retryServers: () => {
            for (const query of failed) {
                void query.refetch();
            }
        },
        serversState,
    };
};

/**
 * The stored selectors for what was typed: a built-in's name as is, and `name:tool` with the server's name swapped for its
 * stable key, so renaming the server later keeps the selector matching. Every server of that name is named, a disconnected
 * connector only when nothing the user can use now has the same name. `null` = no server of that name.
 */
export const resolveTypedSelector = (typed: string, servers: ReadonlyArray<KnownToolServer>): string[] | null => {
    const parsed = parseServerSelector(typed);

    if (parsed === undefined || servers.some((server) => server.key === parsed.server)) {
        return [typed];
    }

    // The longest name that the text starts with, so a server name may hold a colon.
    const named = servers
        .filter((server) => typed.startsWith(`${server.name}:`) && typed.length > server.name.length + 1)
        .toSorted((a, b) => b.name.length - a.name.length);
    const longest = named[0]?.name.length;
    const matches = named.filter((server) => server.name.length === longest);
    const usable = matches.filter((server) => server.disconnected !== true);

    if (usable.length > 0) {
        return usable.map((server) => `${server.key}:${typed.slice(server.name.length + 1)}`);
    }

    return matches.length === 0 ? null : matches.map((server) => `${server.key}:${typed.slice(server.name.length + 1)}`);
};

interface SelectorListProps {
    catalog: ToolCatalog;
    description: string;
    disabled?: boolean;
    label: string;
    onChange: (selectors: string[]) => void;
    /** Whether the field holds text that is not in the list: a save then refuses, so a typed name is never silently dropped. */
    onPendingChange: (pending: boolean) => void;
    /** Shown when the list names one of the user's own servers that no longer exists (`selectionServerKey` on the server). */
    removedServerWarning?: string;
    values: string[];
}

/** One list of selectors: a field to add one (with the known names offered) and a remove button per entry. */
const SelectorList: FC<SelectorListProps> = ({ catalog, description, disabled, label, onChange, onPendingChange, removedServerWarning, values }) => {
    const { t } = useLingui();
    const inputId = useId();
    const descriptionId = useId();
    const errorId = useId();
    const listId = useId();
    const [entry, setEntry] = useState("");
    const [unknownServer, setUnknownServer] = useState<string | null>(null);
    const [unknownBuiltIn, setUnknownBuiltIn] = useState<string | null>(null);
    const [overCap, setOverCap] = useState(false);
    const full = values.length >= BOT_TOOL_SELECTOR_MAX_COUNT;
    // A name refused while the lists were not read was refused for that reason only: once they load (or fail), the reason is
    // dropped and the text waits in the field, still pending, to be added again.
    const readiness = `${catalog.serversState}:${catalog.builtInNames === undefined ? String(catalog.builtInNamesFailed === true) : "ready"}`;
    const [readinessSeen, setReadinessSeen] = useState(readiness);

    if (readinessSeen !== readiness) {
        setReadinessSeen(readiness);
        setUnknownServer(null);
        setUnknownBuiltIn(null);
    }

    const staleId = useId();
    // A stored built-in that is no longer one: the server refuses the save until it is removed.
    const stale =
        catalog.builtInNames !== undefined &&
        values.some((selector) => parseServerSelector(selector) === undefined && catalog.builtInNames?.has(selector) !== true);
    // What was typed could not be added.
    const entryRefused = unknownServer !== null || unknownBuiltIn !== null || overCap;
    const describedBy = [descriptionId, entryRefused && errorId, stale && staleId].filter(Boolean).join(" ");

    /** Why a bare name was not added: not a built-in, or the built-ins are not read (yet, or at all). */
    const unknownBuiltInMessage = (): string => {
        if (catalog.builtInNamesFailed) {
            return t`The built-in tools could not be loaded. Reload the page to add one.`;
        }

        return catalog.builtInNames === undefined
            ? t`The built-in tools are still loading. Try again in a moment.`
            : t`No built-in tool is named ${unknownBuiltIn}.`;
    };
    /** Why a server's name matched nothing: no such server, or the servers are not read (yet, or at all). */
    const unknownServerMessage = (): string => {
        if (catalog.serversState === "error") {
            return t`Your servers, connectors and computers could not be loaded. Retry above to add one by name.`;
        }

        return catalog.serversState === "loading"
            ? t`Your servers, connectors and computers are still loading. Try again in a moment.`
            : t`No server, connector or computer matches ${unknownServer}.`;
    };
    // A connector that is not connected is not offered, but its name can still be typed.
    const suggestions = [...catalog.builtIns, ...catalog.servers.flatMap((server) => (server.disconnected ? [] : [`${server.name}:*`]))];

    /** A selector as the user reads it: a server's current name in place of its key. */
    const labelOf = (selector: string): string => {
        const parsed = parseServerSelector(selector);

        if (parsed === undefined) {
            return selector;
        }

        const name = catalog.servers.find((server) => server.key === parsed.server)?.name;

        if (name !== undefined) {
            return `${name}:${parsed.tool}`;
        }

        // Unlisted only means removed once every list was read; until then the stored key is all that is known.
        if (catalog.serversState !== "ready") {
            return selector;
        }

        const removed = t`Removed server`;

        return `${removed}:${parsed.tool}`;
    };

    // Typed text counts once the field is left too. Text that cannot be added stays in the field, reported as pending, so a
    // save never drops a name that was typed but not added.
    const commit = () => {
        const typed = entry.trim();

        if (typed === "") {
            return;
        }

        // A mistyped built-in would select nothing: in the exclude list the bot would keep the tool meant to go. Until the names
        // are read, a bare name waits in the field.
        if (parseServerSelector(typed) === undefined && catalog.builtInNames?.has(typed) !== true) {
            setUnknownBuiltIn(typed);

            return;
        }

        const resolved = resolveTypedSelector(typed, catalog.servers);

        // Kept in the field with the reason, never saved by name: a name stops matching when the server is renamed.
        if (resolved === null) {
            setUnknownServer(typed);

            return;
        }

        const added = resolved.filter((selector) => !values.includes(selector));

        // The server's caps: how many selectors, and how many characters they take together (a server's key holds its address).
        if (
            values.length + added.length > BOT_TOOL_SELECTOR_MAX_COUNT ||
            [...values, ...added].reduce((total, selector) => total + selector.length, 0) > BOT_TOOL_SELECTION_MAX_LIST_CHARS
        ) {
            setOverCap(true);

            return;
        }

        if (added.length > 0) {
            onChange([...values, ...added]);
        }

        setUnknownServer(null);
        setUnknownBuiltIn(null);
        setOverCap(false);
        setEntry("");
        onPendingChange(false);
    };

    const add = (event: FormEvent) => {
        event.preventDefault();
        commit();
    };

    return (
        <div className="space-y-2">
            <Label htmlFor={inputId}>{label}</Label>
            <p className="text-muted-foreground text-xs" id={descriptionId}>
                {description}
            </p>
            <div className="flex gap-2">
                <Input
                    aria-describedby={describedBy}
                    aria-invalid={entryRefused || stale}
                    disabled={disabled || (full && entry === "")}
                    id={inputId}
                    list={listId}
                    maxLength={BOT_TOOL_SELECTOR_MAX_LENGTH}
                    onBlur={commit}
                    onChange={(event) => {
                        setEntry(event.target.value);
                        setUnknownServer(null);
                        setUnknownBuiltIn(null);
                        setOverCap(false);
                        onPendingChange(event.target.value.trim() !== "");
                    }}
                    onKeyDown={(event) => {
                        // Enter while an input method composes a word picks the word, not the entry.
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                            add(event);
                        }
                    }}
                    placeholder={t`webSearch or server:tool`}
                    value={entry}
                />
                <datalist id={listId}>
                    {suggestions
                        .filter((name) => values.every((selector) => labelOf(selector) !== name))
                        .map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                </datalist>
                <Button disabled={disabled || full || entry.trim() === ""} onClick={add} type="button" variant="outline">
                    {t`Add`}
                </Button>
            </div>
            <p aria-live="polite" className="text-destructive text-xs" id={errorId}>
                {unknownServer !== null && unknownServerMessage()}
                {unknownBuiltIn !== null && unknownBuiltInMessage()}
                {overCap && t`This list is full: remove a tool before adding another.`}
            </p>
            <p aria-live="polite" className="text-destructive text-xs" id={staleId}>
                {stale && t`A listed built-in tool no longer exists. Remove it before saving.`}
            </p>
            {removedServerWarning !== undefined &&
                catalog.serversState === "ready" &&
                values.some((selector) => {
                    const server = parseServerSelector(selector)?.server;

                    return server?.startsWith("mcp=") === true && catalog.servers.every((known) => known.key !== server);
                }) && <p className="text-muted-foreground text-xs">{removedServerWarning}</p>}
            {values.length > 0 && (
                <ul aria-label={label} className="flex flex-wrap gap-2">
                    {values.map((selector) => {
                        const shown = labelOf(selector);
                        const server = parseServerSelector(selector)?.server;
                        const disconnected = server !== undefined && catalog.servers.some((known) => known.key === server && known.disconnected === true);

                        return (
                            <li className="bg-muted flex items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 font-mono text-xs" key={selector}>
                                {shown}
                                {disconnected && <span className="text-muted-foreground font-sans">{t`(disconnected)`}</span>}
                                <Button
                                    aria-label={t`Remove ${shown}`}
                                    className="pointer-coarse:size-11"
                                    disabled={disabled}
                                    onClick={() => onChange(values.filter((value) => value !== selector))}
                                    size="icon-xs"
                                    type="button"
                                    variant="ghost"
                                >
                                    <X aria-hidden="true" />
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

interface BotToolSelectionFieldsProps {
    catalog: ToolCatalog;
    disabled?: boolean;
    onChange: (selection: BotToolSelection | null) => void;
    /** Whether a list holds typed text it has not added (`SelectorList`): the caller refuses to save meanwhile. */
    onPendingChange: (pending: boolean) => void;
    value: BotToolSelection | null;
}

/** All tools, or a custom pick: an optional allow list ("only listed tools") and an exclude list, which always wins. */
export const BotToolSelectionFields: FC<BotToolSelectionFieldsProps> = ({ catalog, disabled, onChange, onPendingChange, value }) => {
    const { t } = useLingui();
    const groupLabelId = useId();
    const allId = useId();
    const customId = useId();
    const onlyListedId = useId();
    const onlyListedDescriptionId = useId();
    // What a toggle switched off held, so switching it on again within the dialog brings the lists back rather than empty ones.
    const lastCustom = useRef<BotToolSelection>(value ?? { exclude: [] });
    const lastAllow = useRef<string[]>(value?.allow ?? []);
    // Typed text not yet added, per list. A list that is hidden takes its text with it, so it stops counting.
    const [pending, setPending] = useState({ allow: false, exclude: false });

    const reportPending = (next: { allow: boolean; exclude: boolean }): void => {
        setPending(next);
        onPendingChange(next.allow || next.exclude);
    };

    const pickAll = (all: boolean): void => {
        if (all) {
            if (value !== null) {
                lastCustom.current = value;
            }

            reportPending({ allow: false, exclude: false });
            onChange(null);
        } else {
            onChange(value ?? lastCustom.current);
        }
    };

    const listOnly = (on: boolean): void => {
        if (value === null) {
            return;
        }

        if (on) {
            onChange({ ...value, allow: value.allow ?? lastAllow.current });
        } else {
            lastAllow.current = value.allow ?? lastAllow.current;
            reportPending({ ...pending, allow: false });
            onChange({ exclude: value.exclude });
        }
    };

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <Label id={groupLabelId}>{t`Tools`}</Label>
                <RadioGroup
                    aria-labelledby={groupLabelId}
                    disabled={disabled}
                    onValueChange={(next: unknown) => pickAll(next !== "custom")}
                    value={value === null ? "all" : "custom"}
                >
                    <div className="flex items-center gap-2">
                        <RadioGroupItem id={allId} value="all" />
                        <Label htmlFor={allId}>{t`All tools`}</Label>
                    </div>
                    <div className="flex items-center gap-2">
                        <RadioGroupItem id={customId} value="custom" />
                        <Label htmlFor={customId}>{t`Custom`}</Label>
                    </div>
                </RadioGroup>
            </div>
            {value !== null && (
                <div className="border-border space-y-4 border-l-2 pl-4">
                    {catalog.serversState === "loading" && (
                        <p className="text-muted-foreground text-xs" role="status">
                            {t`Loading your servers, connectors and computers…`}
                        </p>
                    )}
                    {catalog.serversState === "error" && (
                        <div className="flex flex-wrap items-center gap-2" role="alert">
                            <p className="text-destructive text-xs">{t`Your servers, connectors and computers could not be loaded.`}</p>
                            <Button onClick={catalog.retryServers} size="sm" type="button" variant="outline">
                                {t`Retry`}
                            </Button>
                        </div>
                    )}
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <Label htmlFor={onlyListedId}>{t`Only listed tools`}</Label>
                            <p className="text-muted-foreground text-xs" id={onlyListedDescriptionId}>
                                {t`The bot gets only the tools you allow. With none allowed, it gets no tools.`}
                            </p>
                        </div>
                        <Switch
                            aria-describedby={onlyListedDescriptionId}
                            checked={value.allow !== undefined}
                            disabled={disabled}
                            id={onlyListedId}
                            onCheckedChange={listOnly}
                        />
                    </div>
                    {value.allow !== undefined && (
                        <SelectorList
                            catalog={catalog}
                            description={t`A built-in tool by its name, a server's tool as server:tool, or a whole server as server:*.`}
                            disabled={disabled}
                            label={t`Allowed tools`}
                            onChange={(allow) => onChange({ ...value, allow })}
                            onPendingChange={(allow) => reportPending({ ...pending, allow })}
                            values={value.allow}
                        />
                    )}
                    <SelectorList
                        catalog={catalog}
                        description={t`Never given to the bot, even when allowed above.`}
                        disabled={disabled}
                        label={t`Excluded tools`}
                        onChange={(exclude) => onChange({ ...value, exclude })}
                        onPendingChange={(exclude) => reportPending({ ...pending, exclude })}
                        removedServerWarning={t`An excluded server was removed or its address changed. Until you remove it here, the bot gets none of your own servers' tools.`}
                        values={value.exclude}
                    />
                </div>
            )}
        </div>
    );
};
