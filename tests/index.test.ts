import { InferTargetFromSchema, apiS, arrayS, bigintS, objectS, stringS } from "typizator";
import { PING, handlerImpl } from "../src";

describe("Testing the type conversion facade for AWS lambdas", () => {
    const simpleRecordS = objectS({
        id: bigintS.notNull,
        name: stringS.notNull
    }).notNull;
    const simpleApiS = apiS({
        meow: { args: [], retVal: stringS.notNull },
        noMeow: { args: [] },
        helloWorld: { args: [stringS.notNull, bigintS.notNull], retVal: stringS.notNull },
        cruel: {
            world: { args: [stringS.notNull], retVal: stringS.notNull }
        },
        increment: { args: [simpleRecordS], retVal: simpleRecordS },
        doubleArray: { args: [arrayS(stringS.notNull).notNull], retVal: arrayS(stringS.notNull).notNull },
        errorGenerator: { args: [stringS.notNull, stringS, stringS.optional] }
    });

    const meowHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.meow,
            () => Promise.resolve("Miaou")
        );
    type SimpleType = InferTargetFromSchema<typeof simpleRecordS>;
    const incrementHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.increment,
            (check: SimpleType) => Promise.resolve({ id: check.id + 1n, name: `Incremented ${check.name}` })
        );
    const helloWorldHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.helloWorld,
            (name: string, num: bigint) => Promise.resolve(`${num} greetings to ${name}`)
        );
    const doubleArrayHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.doubleArray,
            (source: string[]) => Promise.resolve([...source, ...source])
        );
    const errorGeneratorHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.errorGenerator,
            (mandatory: string, nullable: string | null, optional: string | null | undefined) => Promise.reject("Custom error")
        )

    test("Should check the responsiveness of the handler", async () => {
        expect(await meowHandler({ body: PING })).toEqual({ data: `{"args":[],"retVal":"string"}` });
        expect(await incrementHandler({ body: PING })).toEqual({ data: `{"args":[{"id":"bigint","name":"string"}],"retVal":{"id":"bigint","name":"string"}}` });
        expect(await doubleArrayHandler({ body: PING })).toEqual({ data: `{"args":["string[]"],"retVal":"string[]"}` });
    });

    test("Should check the handlers implementations", async () => {
        expect(await meowHandler({ body: "" })).toEqual({ data: `"Miaou"` });
        expect(await incrementHandler({ body: `[{"id":"12345678901234567890","name":"Thing"}]` }))
            .toEqual({ data: `{"id":12345678901234567891,"name":"Incremented Thing"}` });
        expect(await helloWorldHandler({ body: `["me",1000]` })).toEqual({ data: `"1000 greetings to me"` });
        expect(await doubleArrayHandler({ body: `[["a","b"]]` })).toEqual({ data: `["a","b","a","b"]` });
    });

    test("Should correctly treat errors", async () => {
        expect(await errorGeneratorHandler({ body: `["mandatory","nullable","optional"]` }))
            .toEqual({ errorMessage: `Handler error: Custom error` });
        expect(await errorGeneratorHandler({ body: `["mandatory","nullable"]` }))
            .toEqual({ errorMessage: `Handler error: Custom error` });
        expect((await errorGeneratorHandler({ body: `[null]` })).errorMessage)
            .toMatch(/is null/);
        expect((await errorGeneratorHandler({ body: `["mandatory"]` })).errorMessage)
            .toMatch(/is undefined/);
        expect((await errorGeneratorHandler({ body: `[]` })).errorMessage)
            .toMatch(/is undefined/);
        expect((await errorGeneratorHandler({ body: `{}` })).errorMessage)
            .toMatch(/must be an array/);
        expect((await errorGeneratorHandler({ body: `Wrong body` })).errorMessage)
            .toMatch(/Unexpected/);
    });
});