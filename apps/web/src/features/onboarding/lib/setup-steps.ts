export const SETUP_STEP_IDS = ["pair", "ssh", "agent"] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export type SetupStepStatus = "done" | "skipped" | "todo";

export interface SetupDevice {
    acpOffers?: readonly unknown[];
    transport?: "ssh";
}

/** What the live device list says is already true. An agent offer counts on a computer or on an SSH server. */
export const detectSetupDone = (devices: readonly SetupDevice[] | undefined): Record<SetupStepId, boolean> => {
    const list = devices ?? [];
    const paired = list.filter((device) => device.transport !== "ssh");

    return {
        agent: list.some((device) => (device.acpOffers?.length ?? 0) > 0),
        pair: paired.length > 0,
        ssh: list.some((device) => device.transport === "ssh"),
    };
};

/** Done wins over skipped: a step the user skipped completes once its state appears. */
export const deriveSetupSteps = (
    devices: readonly SetupDevice[] | undefined,
    skipped: readonly string[] | undefined,
): { id: SetupStepId; status: SetupStepStatus }[] => {
    const done = detectSetupDone(devices);

    return SETUP_STEP_IDS.map((id) => {
        let status: SetupStepStatus = "todo";

        if (done[id]) {
            status = "done";
        } else if (skipped?.includes(id)) {
            status = "skipped";
        }

        return { id, status };
    });
};

/** The new skipped list for a skip or a resume; unknown ids already stored are kept. */
export const toggleSkipped = (skipped: readonly string[] | undefined, id: SetupStepId, skip: boolean): string[] => {
    const rest = (skipped ?? []).filter((entry) => entry !== id);

    return skip ? [...rest, id] : rest;
};
