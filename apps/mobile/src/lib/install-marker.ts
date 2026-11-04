import { File, Paths } from "expo-file-system";

/**
 * A file in the document folder, which is deleted with the app. The Keychain that holds the saved crash-report
 * choice is not, so a launch without this file is a new install, and the saved choice is not trusted.
 */
const markerFile = (): File => new File(Paths.document, "crash-reports-install");

export const installMarker = {
    create: (): void => {
        const marker = markerFile();

        if (!marker.exists) {
            marker.create();
        }
    },
    exists: (): boolean => markerFile().exists,
};
