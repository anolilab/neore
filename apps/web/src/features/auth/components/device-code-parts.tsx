import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import type { ChangeEvent, FormEvent } from "react";
import { useState } from "react";

/** The server ignores case, spaces and dashes; so does the form. */
export const normalizeCode = (value: string): string => value.replaceAll(/[^a-z0-9]/giu, "").toUpperCase();

/**
 * The code field of the CLI approval page: required (so Continue stays usable and native validation names the
 * field) and described by the instruction that says what to type and where it comes from.
 */
export const DeviceCodeField = ({ isInvalid = false, onChange, value }: { isInvalid?: boolean; onChange: (value: string) => void; value: string }) => {
    const { t } = useLingui();

    return (
        <div className="flex flex-col gap-2">
            <p className="text-center text-sm text-gray-700" id="device-code-hint">
                {t`Enter the code that \`neore login --device\` shows in your terminal, then choose Continue.`}
            </p>
            <Label htmlFor="device-code">{t`Code`}</Label>
            <Input
                aria-describedby={isInvalid ? "device-code-hint device-code-error" : "device-code-hint"}
                aria-invalid={isInvalid}
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                id="device-code"
                maxLength={16}
                onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
                required
                spellCheck={false}
                value={value}
            />
        </div>
    );
};

/**
 * What the person is asked to check before approving: the computer and the code, in a named list the screen
 * reader reads out, described by the instruction to compare the code with the one in the terminal.
 */
export const DeviceCodeDetails = ({ code, hostname }: { code: string; hostname: string | undefined }) => {
    const { t } = useLingui();

    return (
        <>
            <dl aria-describedby="device-code-check" aria-label={t`Sign-in request`} className="flex flex-col gap-1 rounded-md bg-gray-100 p-3 text-sm">
                <div className="flex justify-between gap-4">
                    <dt className="text-gray-600">{t`Computer`}</dt>
                    <dd className="font-medium break-all">{hostname ?? t`unknown`}</dd>
                </div>
                <div className="flex justify-between gap-4">
                    <dt className="text-gray-600">{t`Code`}</dt>
                    <dd className="font-mono font-medium">{code}</dd>
                </div>
            </dl>
            <p className="text-center text-sm text-gray-700" id="device-code-check">
                {t`Only continue if you started this just now by running \`neore login --device\`, and the code above matches the one in your terminal.`}
            </p>
        </>
    );
};

/**
 * The code form: normalises what was typed and hands the code on. A value with no letters or digits in it is
 * not sent anywhere; it gets an inline alert instead of a silent no-op.
 */
export const DeviceCodeForm = ({ onCode }: { onCode: (code: string) => void }) => {
    const { t } = useLingui();
    const [typed, setTyped] = useState("");
    const [hasError, setHasError] = useState(false);

    const submit = (event: FormEvent) => {
        event.preventDefault();

        const code = normalizeCode(typed);

        if (code.length === 0) {
            setHasError(true);

            return;
        }

        setHasError(false);
        onCode(code);
    };

    return (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
            <h1 className="text-center text-xl font-semibold">{t`Sign in the command line`}</h1>
            <DeviceCodeField
                isInvalid={hasError}
                onChange={(value) => {
                    setTyped(value);
                    setHasError(false);
                }}
                value={typed}
            />
            {hasError && (
                <p className="text-center text-sm text-red-600" id="device-code-error" role="alert">
                    {t`The code must contain the letters and digits shown in your terminal.`}
                </p>
            )}
            <Button type="submit">{t`Continue`}</Button>
        </form>
    );
};
