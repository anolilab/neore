/**
 * The heading outline's context, apart from the components in `./heading` so
 * that file exports only components (fast refresh).
 */
import { createContext, use } from "react";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export const HeadingLevelContext = createContext<HeadingLevel | undefined>(undefined);

/** One level deeper, stopping at `h6`: HTML has nothing below it. */
export const nextHeadingLevel = (level: HeadingLevel): HeadingLevel => Math.min(level + 1, 6) as HeadingLevel;

/** The level the next heading at this depth takes, or `undefined` outside an outline. */
export const useHeadingLevel = (): HeadingLevel | undefined => use(HeadingLevelContext);
