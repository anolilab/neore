/**
 * The open thread's find bar, as the Find in Thread shortcut reaches it. The thread marks its
 * message area with this attribute while it can be searched; on any other page nothing carries it
 * and the shortcut falls back to the thread list's search, or to the browser's find.
 */
export const FIND_IN_THREAD_HOST_ATTRIBUTE = "data-find-in-thread-host";

/** Window event the thread's find bar listens for. */
export const FIND_IN_THREAD_EVENT = "findInThread";

export const hasFindInThreadTarget = (): boolean => document.querySelector(`[${CSS.escape(FIND_IN_THREAD_HOST_ATTRIBUTE)}]`) !== null;
