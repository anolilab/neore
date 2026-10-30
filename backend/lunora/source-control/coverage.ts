/** How many of `total` a host will never list because it caps the list at `limit`. */
export const leftOutPast = (total: number, limit: number): number => Math.max(0, total - limit);
