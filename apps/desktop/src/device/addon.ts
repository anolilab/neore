import type { DeviceCoreConstructor } from "./types";

interface Addon {
    DeviceCore: DeviceCoreConstructor;
    toolIdentity: (path: string) => string | null;
}

/**
 * Loads `@neore/device-core-node` at runtime. The name is assembled at run time so
 * esbuild does not try to bundle the `.node` binary into `main.cjs`; the package
 * resolves from `apps/desktop/node_modules`.
 */
const loadAddon = (): Addon => {
    const name = ["@neore", "device-core-node"].join("/");

    // eslint-disable-next-line n/global-require, import/no-dynamic-require, @typescript-eslint/no-require-imports -- the addon is a native module resolved by name at runtime
    return require(name) as Addon;
};

export const loadDeviceCore = (): DeviceCoreConstructor => loadAddon().DeviceCore;

/** The core's `toolIdentity`: what a tool file is now, for the npm install to check it is still that file. */
export const loadToolIdentity = (): Addon["toolIdentity"] => loadAddon().toolIdentity;
