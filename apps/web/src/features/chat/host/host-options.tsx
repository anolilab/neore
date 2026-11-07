import { useLingui } from "@lingui/react/macro";
import type { ReturnOf } from "@lunora/react";
import type { api } from "@neore/backend/api";
import type { FC } from "react";

export type HostAgentOptions = NonNullable<NonNullable<ReturnOf<typeof api.acp.functions.getHostSession>>["agentOptions"]>;

interface OptionRow {
    id: string;
    name: string;
    value: string;
}

/** Each option with the name of its current value; for an agent with only the legacy mode list, its mode. */
export const optionRows = (options: HostAgentOptions | undefined, modeLabel: string): OptionRow[] => {
    const rows = (options?.configOptions ?? []).map((option) => {
        return { id: option.id, name: option.name, value: option.choices.find((choice) => choice.value === option.currentValue)?.name ?? option.currentValue };
    });

    if (rows.length === 0 && options?.modes !== undefined) {
        const { available, current } = options.modes;

        rows.push({ id: "mode", name: modeLabel, value: available.find((mode) => mode.value === current)?.name ?? current });
    }

    return rows;
};

/** The options the agent on the computer offers for this session (model, reasoning effort, mode ...), as it last reported them. */
const HostOptions: FC<{ options: HostAgentOptions | undefined }> = ({ options }) => {
    const { t } = useLingui();
    const rows = optionRows(options, t`Mode`);

    if (rows.length === 0) {
        return null;
    }

    return (
        <ul aria-label={t`Agent options`} className="text-muted-foreground flex flex-wrap gap-1 text-xs">
            {rows.map((row) => (
                <li className="bg-muted max-w-full rounded-md px-2 py-1 break-all" key={row.id}>
                    {row.name}: <span className="text-foreground">{row.value}</span>
                </li>
            ))}
        </ul>
    );
};

export default HostOptions;
