import { File, Paths } from "expo-file-system";

/**
 * A file in the document folder that records an opt-out whose saved choice has not been written. The Keychain holds the
 * saved choice and survives the app, so a launch that finds this file must not trust the saved "on".
 */
const revocationFile = (): File => new File(Paths.document, "crash-reports-revoked");

export const revocationFlag = {
    create: (): void => {
        const flag = revocationFile();

        if (!flag.exists) {
            flag.create();
        }
    },
    exists: (): boolean => revocationFile().exists,
    remove: (): void => {
        const flag = revocationFile();

        if (flag.exists) {
            flag.delete();
        }
    },
};
