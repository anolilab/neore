import type { HostDriver } from "./driver";
import { githubDriver } from "./drivers/github";

/** The one host Develop serves for now; the procedures reach a host only through this. */
export const DEVELOP_DRIVER: HostDriver = githubDriver;
