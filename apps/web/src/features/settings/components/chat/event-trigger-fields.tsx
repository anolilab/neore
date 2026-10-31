"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
    EVENT_DEFAULT_COOLDOWN_MINUTES,
    EVENT_DEFAULT_INTERVAL_MINUTES,
    EVENT_MIN_INTERVAL_MINUTES,
    MAX_ACTIVE_EVENT_WATCHERS,
} from "@neore/backend/triggers/event-limits";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Clock, FileText, MessageSquare } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

/** What an event trigger watches, as the server stores it (`vEventSource`). */
export type EventSource =
    | { contains?: string; cooldownMinutes?: number; intervalMinutes?: number; kind: "page"; selector?: string; url: string }
    | { at: number; kind: "time" }
    | { cooldownMinutes?: number; intervalMinutes?: number; kind: "thread"; threadId: string };

export type EventSourceKind = EventSource["kind"];

/** The form's text fields; numbers stay text until they are sent. */
export interface EventFormState {
    /** `datetime-local` value, in the browser's zone. */
    at: string;
    contains: string;
    cooldownMinutes: string;
    intervalMinutes: string;
    kind: EventSourceKind;
    selector: string;
    threadId: string;
    url: string;
}

export const EMPTY_EVENT: EventFormState = {
    at: "",
    contains: "",
    cooldownMinutes: String(EVENT_DEFAULT_COOLDOWN_MINUTES),
    intervalMinutes: String(EVENT_DEFAULT_INTERVAL_MINUTES),
    kind: "page",
    selector: "",
    threadId: "",
    url: "",
};

const EVENT_KIND_LABELS: Record<EventSourceKind, MessageDescriptor> = {
    page: msg`A page changes`,
    thread: msg`A thread gets a reply`,
    time: msg`A moment arrives`,
};

const KINDS: ReadonlyArray<EventSourceKind> = ["page", "time", "thread"];

const toLocalInput = (millis: number): string => {
    const date = new Date(millis - new Date(millis).getTimezoneOffset() * 60_000);

    return date.toISOString().slice(0, 16);
};

const wholeMinutes = (text: string): number | undefined => {
    const value = Number(text);

    return text.trim() !== "" && Number.isSafeInteger(value) ? value : undefined;
};

/** The form for a stored source; a trigger with none starts empty. */
export const eventFormFromSource = (source: EventSource | null): EventFormState => {
    if (!source) {
        return EMPTY_EVENT;
    }

    if (source.kind === "time") {
        return { ...EMPTY_EVENT, at: toLocalInput(source.at), kind: "time" };
    }

    const shared = {
        ...EMPTY_EVENT,
        cooldownMinutes: String(source.cooldownMinutes ?? EVENT_DEFAULT_COOLDOWN_MINUTES),
        intervalMinutes: String(source.intervalMinutes ?? EVENT_DEFAULT_INTERVAL_MINUTES),
        kind: source.kind,
    };

    return source.kind === "page"
        ? { ...shared, contains: source.contains ?? "", selector: source.selector ?? "", url: source.url }
        : { ...shared, threadId: source.threadId };
};

const pageSourceFromForm = (event: EventFormState): EventSource | undefined => {
    const interval = wholeMinutes(event.intervalMinutes);
    const cooldown = wholeMinutes(event.cooldownMinutes);

    return event.url.trim() === ""
        ? undefined
        : {
              ...(event.contains.trim() !== "" && { contains: event.contains.trim() }),
              ...(cooldown !== undefined && { cooldownMinutes: cooldown }),
              ...(interval !== undefined && { intervalMinutes: interval }),
              kind: "page",
              ...(event.selector.trim() !== "" && { selector: event.selector.trim() }),
              url: event.url.trim(),
          };
};

const threadSourceFromForm = (event: EventFormState): EventSource | undefined => {
    const interval = wholeMinutes(event.intervalMinutes);
    const cooldown = wholeMinutes(event.cooldownMinutes);

    return event.threadId === ""
        ? undefined
        : {
              ...(cooldown !== undefined && { cooldownMinutes: cooldown }),
              ...(interval !== undefined && { intervalMinutes: interval }),
              kind: "thread",
              threadId: event.threadId,
          };
};

/** The source to send, or `undefined` while the form is not a complete one. The server checks the rest. */
export const eventSourceFromForm = (event: EventFormState): EventSource | undefined => {
    if (event.kind === "page") {
        return pageSourceFromForm(event);
    }

    if (event.kind === "thread") {
        return threadSourceFromForm(event);
    }

    const at = event.at === "" ? NaN : new Date(event.at).getTime();

    return Number.isNaN(at) ? undefined : { at, kind: "time" };
};

/** Whether the form is missing what its source needs. */
export const eventIsIncomplete = (event: EventFormState): boolean => eventSourceFromForm(event) === undefined;

/** One line saying what a stored source watches, for the trigger list. */
export const useDescribeEventSource = (): ((source: EventSource) => string) => {
    const { i18n, t } = useLingui();

    return (source) => {
        if (source.kind === "page") {
            return t`Page: ${source.url}`;
        }

        if (source.kind === "thread") {
            return t`Replies in a thread`;
        }

        return t`At ${formatDateTime(source.at, i18n.locale)}`;
    };
};

interface EventTriggerFieldsProps {
    /** A saved trigger can change what it watches, not the kind of trigger it is. */
    event: EventFormState;
    onChange: (event: EventFormState) => void;
}

const THREAD_CHOICES = 30;

const EventTriggerFields: FC<EventTriggerFieldsProps> = ({ event, onChange }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const ids = { at: useId(), contains: useId(), cooldown: useId(), interval: useId(), selector: useId(), thread: useId(), url: useId() };
    // The thread list is the picker's: recent chats, fetched only when the thread source is chosen.
    const { data: threads } = useQuery(
        crpc.chat.functions.searchThreads.queryOptions(
            event.kind === "thread"
                ? { excludeTemporary: true, paginationOpts: { cursor: null, endCursor: null, numItems: THREAD_CHOICES }, searchQuery: "" }
                : skipToken,
            { live: false },
        ),
    );
    const choices = threads?.page ?? [];
    const set = (patch: Partial<EventFormState>) => onChange({ ...event, ...patch });
    const [minTime] = useState(() => toLocalInput(Date.now() + 60_000));

    return (
        <div className="space-y-3">
            <div aria-label={t`What to watch`} className="flex flex-wrap gap-2" role="group">
                {KINDS.map((kind) => (
                    <button
                        aria-pressed={event.kind === kind}
                        className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                            event.kind === kind ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/50"
                        }`}
                        key={kind}
                        onClick={() => set({ kind })}
                        type="button"
                    >
                        {kind === "page" && <FileText aria-hidden="true" className="size-4" />}
                        {kind === "time" && <Clock aria-hidden="true" className="size-4" />}
                        {kind === "thread" && <MessageSquare aria-hidden="true" className="size-4" />}
                        {i18n._(EVENT_KIND_LABELS[kind])}
                    </button>
                ))}
            </div>

            <p className="text-muted-foreground text-xs">
                {t`The condition is checked without asking a model; the agent runs only when it comes true. You can keep ${MAX_ACTIVE_EVENT_WATCHERS} event triggers switched on at a time.`}
            </p>

            {event.kind === "page" && (
                <>
                    <div className="space-y-1.5">
                        <Label htmlFor={ids.url}>{t`Page address`}</Label>
                        <Input
                            id={ids.url}
                            inputMode="url"
                            maxLength={2048}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ url: e.target.value })}
                            placeholder="https://example.com/pricing"
                            type="url"
                            value={event.url}
                        />
                        <p className="text-muted-foreground text-xs">{t`A public http or https address. The first check only records how the page looks. Only the first 1 MiB of a page is read.`}</p>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={ids.selector}>{t`Watch only this part (optional)`}</Label>
                        <Input
                            id={ids.selector}
                            maxLength={200}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ selector: e.target.value })}
                            placeholder="#price"
                            value={event.selector}
                        />
                        <p className="text-muted-foreground text-xs">{t`A tag, #id, .class, tag.class or tag#id. Leave it empty to watch the whole page.`}</p>
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={ids.contains}>{t`Only when it contains (optional)`}</Label>
                        <Input
                            id={ids.contains}
                            maxLength={500}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ contains: e.target.value })}
                            placeholder={t`In stock`}
                            value={event.contains}
                        />
                        <p className="text-muted-foreground text-xs">{t`With this, it fires when the text starts to contain the phrase, not on every change.`}</p>
                    </div>
                </>
            )}

            {event.kind === "time" && (
                <div className="space-y-1.5">
                    <Label htmlFor={ids.at}>{t`When`}</Label>
                    <Input
                        id={ids.at}
                        min={minTime}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ at: e.target.value })}
                        type="datetime-local"
                        value={event.at}
                    />
                    <p className="text-muted-foreground text-xs">{t`Runs once, then switches itself off. For a repeating time, use a schedule.`}</p>
                </div>
            )}

            {event.kind === "thread" && (
                <div className="space-y-1.5">
                    <Label htmlFor={ids.thread}>{t`Thread`}</Label>
                    <Select onValueChange={(value) => set({ threadId: value ?? "" })} value={event.threadId}>
                        <SelectTrigger id={ids.thread}>
                            <SelectValue placeholder={t`Pick a thread`} />
                        </SelectTrigger>
                        <SelectContent>
                            {event.threadId !== "" && choices.every((thread) => thread._id !== event.threadId) && (
                                <SelectItem value={event.threadId}>{t`Selected thread`}</SelectItem>
                            )}
                            {choices.map((thread) => (
                                <SelectItem key={thread._id} value={thread._id}>
                                    {thread.title || t`Untitled`}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <p className="text-muted-foreground text-xs">{t`Fires when a message lands in it from a sub-agent, a model or another person. Your own messages do not count.`}</p>
                </div>
            )}

            {event.kind !== "time" && (
                <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                        <Label htmlFor={ids.interval}>{t`Check every (minutes)`}</Label>
                        <Input
                            id={ids.interval}
                            inputMode="numeric"
                            min={EVENT_MIN_INTERVAL_MINUTES}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ intervalMinutes: e.target.value })}
                            type="number"
                            value={event.intervalMinutes}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor={ids.cooldown}>{t`Wait after it fires (minutes)`}</Label>
                        <Input
                            id={ids.cooldown}
                            inputMode="numeric"
                            min={0}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set({ cooldownMinutes: e.target.value })}
                            type="number"
                            value={event.cooldownMinutes}
                        />
                    </div>
                    <p className="text-muted-foreground col-span-2 text-xs">{t`At least ${EVENT_MIN_INTERVAL_MINUTES} minutes between checks.`}</p>
                    {event.kind === "thread" && (
                        <p className="text-muted-foreground col-span-2 text-xs">{t`A model's answer to your own message counts as a reply. In a thread you are chatting in, the wait after it fires is what keeps this to one run per wait.`}</p>
                    )}
                </div>
            )}
        </div>
    );
};

export default EventTriggerFields;
