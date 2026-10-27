"use client";

import { FetchableOriginsContext } from "@ui/hooks/use-fetchable-origins";
import type { FC, ReactNode } from "react";

/** Lets the file previews below fetch these origins as well as the page's own (see `isFetchableUrl`). */
export const FetchableOriginsProvider: FC<{ children: ReactNode; origins: ReadonlyArray<string> }> = ({ children, origins }) => (
    <FetchableOriginsContext value={origins}>{children}</FetchableOriginsContext>
);

FetchableOriginsProvider.displayName = "FetchableOriginsProvider";
