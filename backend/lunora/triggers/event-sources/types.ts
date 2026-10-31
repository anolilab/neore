/**
 * The contract between the event scheduler (`triggers/events.ts`) and the things it watches.
 *
 * A source decides, from its configuration and what the previous check left behind, whether its
 * condition just became true. It never calls a model, writes a row or schedules anything: the
 * scheduler owns arming, the fire claim, the failure streak and the run. A new source is one more
 * entry in `index.ts` and one more member of `vEventSource`.
 */
import type { EventSourceConfig, EventState } from "../validators";

/** A page is checked at most this often; also the floor for every watcher's interval. */
export const EVENT_MIN_INTERVAL_MINUTES = 5;
export const EVENT_DEFAULT_INTERVAL_MINUTES = 15;
/** A week: a slower watcher is a task, not a trigger. */
export const EVENT_MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const EVENT_DEFAULT_COOLDOWN_MINUTES = 60;
export const EVENT_MAX_COOLDOWN_MINUTES = 7 * 24 * 60;
/** Enabled event triggers one user may have; each costs a check every few minutes. */
export const MAX_ACTIVE_EVENT_WATCHERS = 10;
/** A time watcher may be set at most this far ahead. */
export const EVENT_MAX_TIME_AHEAD_MS = 5 * 365 * 24 * 60 * 60 * 1000;
export const MINUTE_MS = 60_000;

/** What the page source fetches, behind a port so a test never touches the network. */
export interface FetchedPage {
    /** The response body, cut at `PAGE_MAX_BYTES`. */
    text: string;
    truncated: boolean;
}

/** The newest settled rows of a thread past a baseline, as the owner's shard reports them. */
export interface ThreadScan {
    /** The newest row that can no longer change: the next scan starts after it. Absent for an empty thread. */
    baseline?: { order: number; stepOrder: number };
    /** The newest reply past the baseline the caller passed; absent when nothing new landed (and on a first look). */
    reply?: { id: string; text: string };
}

export interface EventCheckContext {
    /** The page at `url`, redirects followed through the SSRF guard. Throws when it cannot be read. */
    fetchPage: (url: string) => Promise<FetchedPage>;
    now: number;
    /** What landed in `threadId` after `after` (the whole tip when `after` is absent). Throws when the owner can no longer read it. */
    scanThread: (threadId: string, after: { order: number; stepOrder: number } | undefined) => Promise<ThreadScan>;
}

export type EventCheckResult =
    | { fired: false; state: EventState }
    | {
          /** Untrusted text from the thing watched, given to the run as data. */
          excerpt?: string;
          fired: true;
          /** Short, stable per occurrence: two checks that saw the same event must give the same key (`claimOnce`). */
          fireKey: string;
          state: EventState;
          /** One line saying what fired ("The page changed: <url>"), the heading of the run's input. */
          summary: string;
      };

export interface EventSource<C extends EventSourceConfig = EventSourceConfig> {
    check: (ctx: EventCheckContext, config: C, state: EventState) => Promise<EventCheckResult>;
}
