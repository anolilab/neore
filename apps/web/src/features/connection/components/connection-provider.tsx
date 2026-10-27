"use client";

import type { ReactNode } from "react";

import { ConnectionContext } from "../hooks/use-connection";
import { useConnectionStatus } from "../hooks/use-connection-status";

/** Subscribes to the connection once for the banner and the offline screen below it. */
const ConnectionProvider = ({ children }: { children: ReactNode }) => {
    const presentation = useConnectionStatus();

    return <ConnectionContext value={presentation}>{children}</ConnectionContext>;
};

export default ConnectionProvider;
