/**
 * The four utilities this module used to pull from the old helpers package.
 *
 * They were the last thing keeping the old packages in the web
 * app's dependency tree — no code imported the old package itself. All
 * four are generic TypeScript plumbing with nothing backend-specific in them,
 * so they are reproduced here rather than carrying two packages for them.
 */

declare const errorBrand: unique symbol;

/**
 * A string type that only unifies with itself, so an unmet constraint surfaces
 * as the message text instead of as a structural mismatch.
 */
export type ErrorMessage<Reason extends string> = Reason & { [errorBrand]: true };

/**
 * `Omit&lt;>` that distributes over a union and preserves an index signature.
 * The built-in `Omit` collapses both.
 */
export type BetterOmit<T, K extends keyof T> = {
    [Property in keyof T as Property extends K ? never : Property]: T[Property];
};

/**
 * Identity for object types, but it makes TypeScript render `A & B` as a single
 * flattened object in hovers and errors.
 */
export type Expand<ObjectType extends Record<any, any>> = ObjectType extends Record<any, any> ? { [Key in keyof ObjectType]: ObjectType[Key] } : never;

/**
 * Throw if `value` is falsy, and narrow it for the rest of the scope.
 *
 * `message` may be a thunk so an expensive string is only built on failure.
 */
export function assert(value: unknown, message?: (() => string) | string): asserts value {
    if (!value) {
        throw new Error(typeof message === "function" ? message() : message);
    }
}
