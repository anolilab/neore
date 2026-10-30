import type { HostCapabilityReportInput } from "@neore/backend/source-control/capabilities";

/** What the page needs to know about the host it reads, as `getDevelopHost` returns it. */
export interface HostInfo {
    capabilities: HostCapabilityReportInput;
    label: string;
    limits: { commits: number; files: number };
    requestNoun: "merge request" | "pull request";
}
