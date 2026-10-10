/**
 * Lunora row ids are lowercase UUIDs (`1d0e2944-748e-4cd8-b8f4-7cd88273786a`),
 * not the previous backend's 32-char base32 ids. Route guards that still expected
 * the old shape rejected every new thread and bounced it to `/chat?redirectReason=invalid-thread-id`.
 *
 * A regex SOURCE so path patterns can embed it with their own anchors.
 */
export const LUNORA_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const LUNORA_ID_RE = new RegExp(`^${LUNORA_ID_SOURCE}$`);

/** Whether a raw URL segment has the shape of a Lunora row id. */
export const isLunoraId = (value: string): boolean => LUNORA_ID_RE.test(value);
