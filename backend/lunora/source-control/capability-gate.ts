/**
 * The gate every host write runs first: the driver must DECLARE the capability, or the
 * procedure refuses before any token is read. A client that skips the UI's gating still
 * cannot reach a host call the driver never offered.
 */
import { LunoraError } from "lunorash/server";

import type { HostCapabilityKey } from "./capabilities";
import { isHostCapabilityAvailable } from "./capabilities";
import { DEVELOP_DRIVER } from "./develop-driver";

export const requireCapability = (key: HostCapabilityKey): void => {
    if (!isHostCapabilityAvailable(DEVELOP_DRIVER.view.capabilities, key)) {
        throw new LunoraError("BAD_REQUEST", "This host does not offer that");
    }
};
