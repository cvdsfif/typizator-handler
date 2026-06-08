import { normalizeElastiCacheId } from "../src/ts-api-construct";

describe("normalizeElastiCacheId", () => {
    test("should keep a valid id starting with a letter", () => {
        expect(normalizeElastiCacheId("serverless-cache-test")).toBe("serverless-cache-test")
    })

    test("should prefix ids that do not start with a letter", () => {
        expect(normalizeElastiCacheId("9abc")).toBe("u-9abc")
    })

    test("should prefix ids that normalize to empty", () => {
        expect(normalizeElastiCacheId("---")).toBe("u-u")
    })
})
