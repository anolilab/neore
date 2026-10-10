/**
 * A document outline for components that are rendered at different depths.
 *
 * A settings card is a section on the settings page (an `h2` under the page's
 * `h1`), a sub-section inside the settings dialog (under the dialog's own
 * headings), and a plain box everywhere else. Hard-coding a level in the card
 * would be wrong in at least two of those places, so the level comes from the
 * nearest {@link HeadingLevelProvider} instead.
 *
 * Outside any provider nothing changes: `CardTitle` stays a `div` and
 * {@link Heading} renders its `fallbackLevel`, so pages that never opted in
 * keep the outline they had.
 */
import type { ComponentProps, ReactNode } from "react";

import type { HeadingLevel } from "./heading-context";
import { HeadingLevelContext, nextHeadingLevel, useHeadingLevel } from "./heading-context";

/** Starts an outline: headings (and card titles) below it take `level`. */
export const HeadingLevelProvider = ({ children, level }: { children?: ReactNode; level: HeadingLevel | undefined }) => (
    <HeadingLevelContext value={level}>{children}</HeadingLevelContext>
);

/**
 * Content that belongs UNDER the heading before it: headings inside it are one
 * level deeper. Outside an outline it changes nothing.
 */
export const HeadingSection = ({ children }: { children?: ReactNode }) => {
    const level = useHeadingLevel();
    const inner = level === undefined ? undefined : nextHeadingLevel(level);

    return <HeadingLevelProvider level={inner}>{children}</HeadingLevelProvider>;
};

export type HeadingProperties = ComponentProps<"h2"> & {
    /** The level rendered outside any {@link HeadingLevelProvider}. */
    fallbackLevel?: HeadingLevel;
};

/** A heading at the outline's current level — `fallbackLevel` (h2) outside one. */
export const Heading = ({ fallbackLevel, ...properties }: HeadingProperties) => {
    const level = useHeadingLevel() ?? fallbackLevel ?? 2;
    const Tag = `h${level}` as const;

    return <Tag {...properties} />;
};
