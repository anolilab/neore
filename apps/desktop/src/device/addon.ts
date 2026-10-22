import type { DeviceCoreConstructor } from "./types";

/**
 * Loads `@neore/device-core-node` at runtime. The name is assembled at run time so
 * esbuild does not try to bundle the `.node` binary into `main.cjs`; the package
 * resolves from `apps/desktop/node_modules`.
 */
export const loadDeviceCore = (): DeviceCoreConstructor => {
    const name = ["@neore", "device-core-node"].join("/");
    // eslint-disable-next-line global-require, import/no-dynamic-require, @typescript-eslint/no-require-imports -- the addon is a native module resolved by name at runtime
    const addon = require(name) as { DeviceCore: DeviceCoreConstructor };

    return addon.DeviceCore;
};
