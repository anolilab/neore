export type SqlParameter = number | string | null;

/** The slice of expo-sqlite's async database the cache uses. Tests hand it a `node:sqlite` one. */
export interface SqlDatabase {
    execAsync: (source: string) => Promise<void>;
    getAllAsync: <T>(source: string, params?: SqlParameter[]) => Promise<T[]>;
    runAsync: (source: string, params?: SqlParameter[]) => Promise<unknown>;
    withTransactionAsync: (task: () => Promise<void>) => Promise<void>;
}
