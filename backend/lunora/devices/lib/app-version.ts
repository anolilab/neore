/** Desktop app versions the backend keeps: a reported value is stored only when it is shaped like one. */

import { MAX_APP_VERSION_LENGTH } from "./constants";

const VERSION_SHAPE = /^\d{1,9}(?:\.\d{1,9}){0,3}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

/** `1.2`, `1.2.3.4` and `1.2.3-beta.1` are versions; `+build` metadata, a leading `v` and free text are not. */
export const isAppVersion = (version: string): boolean => version.length <= MAX_APP_VERSION_LENGTH && VERSION_SHAPE.test(version);
