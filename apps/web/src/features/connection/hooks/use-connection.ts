import { createContext, useContext } from "react";

import type { ConnectionPresentation } from "../lib/connection-state";

export const ConnectionContext = createContext<ConnectionPresentation | null>(null);

/** The shared connection status. Must be used under `ConnectionProvider`. */
export const useConnection = (): ConnectionPresentation => {
    const presentation = useContext(ConnectionContext);

    if (presentation === null) {
        throw new Error("useConnection must be used within ConnectionProvider");
    }

    return presentation;
};
