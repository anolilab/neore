/** Desktop app versions the backend keeps: a reported value is stored only when it is shaped like one. */

import { MAX_APP_VERSION_LENGTH } from "./constants";

const VERSION_SHAPE = /^\d+(?:\.\d+){0,3}(?:-[a-z0-9][a-z0-9.-]*)?$/i;

/** `1.2`, `1.2.3.4` and `1.2.3-beta.1` are versions; `+build` metadata, a leading `v` and free text are not. */
export const isAppVersion = (version: string): boolean => version.length <= MAX_APP_VERSION_LENGTH && VERSION_SHAPE.test(version);
