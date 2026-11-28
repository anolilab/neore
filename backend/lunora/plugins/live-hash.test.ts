import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { liveHashOf } from "./live-hash";
import type { SkillKeyCache } from "./live-hash";
import { markerFor } from "./logic";

const OWNER = "owner-a";
const INSTALL = "install-1";

describe("the live hash of group chats that share skills", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("reads each participant skill once across nine groups over eight skills, and hashes the same as without the cache", async () => {
        const reads = await harness.run(async (context: any) => {
            const skillIds: string[] = [];

            for (let index = 0; index < 8; index += 1) {
                skillIds.push(
                    await context.db.insert("skills", {
                        description: "d",
                        enabled: true,
                        instructions: "i",
                        name: `s${String(index)}`,
                        pluginInstallId: INSTALL,
                        pluginMarker: markerFor(INSTALL, `skill:s${String(index)}`),
                        slug: `s${String(index)}`,
                        source: { type: "editor" },
                        userId: OWNER,
                        visibility: "private",
                    }),
                );
            }

            for (let index = 0; index < 9; index += 1) {
                await context.db.insert("threads", {
                    groupChat: {
                        mode: "round-robin",
                        participants: skillIds.map((skillId) => {
                            return { addedAt: 1, skillId };
                        }),
                    },
                    pluginInstallId: INSTALL,
                    pluginMarker: markerFor(INSTALL, `group:g${String(index)}`),
                    status: "active",
                    title: `g${String(index)}`,
                    userId: OWNER,
                });
            }

            let count = 0;
            const counted = {
                ...context,
                db: new Proxy(context.db, {
                    get: (target, property) => {
                        if (property !== "skills") {
                            return target[property as never];
                        }

                        return {
                            ...target.skills,
                            findFirst: async (query: never) => {
                                count += 1;

                                return await target.skills.findFirst(query);
                            },
                        };
                    },
                }),
            };
            const cache: SkillKeyCache = new Map();
            const cached: string[] = [];
            const plain: string[] = [];

            for (let index = 0; index < 9; index += 1) {
                cached.push(await liveHashOf(counted as never, INSTALL, { entryKey: `group:g${String(index)}`, kind: "group" }, cache));
            }

            const withCache = count;

            for (let index = 0; index < 9; index += 1) {
                plain.push(await liveHashOf(context, INSTALL, { entryKey: `group:g${String(index)}`, kind: "group" }));
            }

            return { cached, plain, withCache };
        });

        // A group whose participants were never read would hash as "missing" both ways and still match.
        expect(reads.cached.every((hash) => hash !== "missing")).toBe(true);
        expect(reads.withCache).toBeGreaterThan(0);
        expect(reads.withCache).toBeLessThanOrEqual(8);
        expect(reads.cached).toStrictEqual(reads.plain);
    });
});
