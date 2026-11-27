import { watchNativeSystemAccentColor } from "@/lib/native/system-accent";

import type { SystemAccentTokens } from "./native-appearance";
import { systemAccentTokens } from "./system-accent-tokens";

/**
 * Hands `paint` the OS accent's tokens, then those of each change (`null`: the OS has none); a failed read hands it
 * nothing, so what is painted stays. Loaded dynamically by `AppearanceSync` once the `system` accent applies, so only
 * the desktop shell downloads it; `paint` comes from the caller so this chunk shares no module with the first load.
 * Returns the function that stops following.
 */
export const followSystemAccent = (paint: (tokens: SystemAccentTokens | null) => void): (() => void) =>
    watchNativeSystemAccentColor((hex: string | null) => paint(hex === null ? null : systemAccentTokens(hex)));
