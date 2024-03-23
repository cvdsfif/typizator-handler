import { InferTargetFromSchema, apiS, arrayS, bigintS, objectS, stringS } from "typizator";
import { HandlerProps, PING, handlerImpl } from "../src";

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
    const noMeowHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.noMeow,
            () => Promise.resolve()
        );

    type SimpleType = InferTargetFromSchema<typeof simpleRecordS>;
    const incrementHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.increment,
            (check: SimpleType) => Promise.resolve({ id: check.id + 1n, name: `Incremented ${check.name}` })
        );
    const helloWorldImpl = (name: string, num: bigint) => Promise.resolve(`${num} greetings to ${name}`)
    const helloWorldHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.helloWorld,
            helloWorldImpl
        );
    const doubleArrayHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.doubleArray,
            (source: string[]) => Promise.resolve([...source, ...source])
        );
    const errorGeneratorHandler =
        handlerImpl(
            simpleApiS.metadata.implementation.errorGenerator,
            () => Promise.reject("Custom error")
        )

    test("Should check the responsiveness of the handler", async () => {
        expect(await meowHandler({ body: PING })).toEqual({ data: `{"args":[],"retVal":"string"}` });
        expect(await noMeowHandler({ body: PING })).toEqual({ data: `{"args":[],"retVal":"void"}` });
        expect(await incrementHandler({ body: PING })).toEqual({ data: `{"args":[{"id":"bigint","name":"string"}],"retVal":{"id":"bigint","name":"string"}}` });
        expect(await doubleArrayHandler({ body: PING })).toEqual({ data: `{"args":["string[]"],"retVal":"string[]"}` });
        expect(await doubleArrayHandler({ body: PING })).toEqual({ data: `{"args":["string[]"],"retVal":"string[]"}` });
    });

    test("Should check the handlers implementations", async () => {
        expect(await meowHandler({ body: "" })).toEqual({ data: `"Miaou"` });
        expect(await incrementHandler({ body: `[{"id":"12345678901234567890","name":"Thing"}]` }))
            .toEqual({ data: `{"id":12345678901234567891,"name":"Incremented Thing"}` });
        expect(await helloWorldHandler({ body: `["me",1000]` })).toEqual({ data: `"1000 greetings to me"` });
        expect(await doubleArrayHandler({ body: `[["a","b"]]` })).toEqual({ data: `["a","b","a","b"]` });
    });

    test("Should empty connected resources for the appropriate handlers", () => {
        expect((meowHandler as any).connectedResources).toEqual([]);
    });

    test("Should correctly treat errors", async () => {
        expect(JSON.parse(await errorGeneratorHandler({ body: `["mandatory","nullable","optional"]` }) as string))
            .toEqual({ errorMessage: `Handler error: Custom error` });
        expect(JSON.parse(await errorGeneratorHandler({ body: `["mandatory","nullable"]` }) as string))
            .toEqual({ errorMessage: `Handler error: Custom error` });
        expect(JSON.parse((await errorGeneratorHandler({ body: `[null]` }) as string)).errorMessage)
            .toMatch(/is null/);
        expect(JSON.parse((await errorGeneratorHandler({ body: `["mandatory"]` }) as string)).errorMessage)
            .toMatch(/is undefined/);
        expect(JSON.parse((await errorGeneratorHandler({ body: `[]` }) as string)).errorMessage)
            .toMatch(/is undefined/);
        expect(JSON.parse((await errorGeneratorHandler({ body: `{}` }) as string)).errorMessage)
            .toMatch(/must be an array/);
        expect(JSON.parse((await errorGeneratorHandler({ body: `Wrong body` }) as string)).errorMessage)
            .toMatch(/Unexpected/);
    })

    test("Should forward errors report to an error callback", async () => {
        const errorHandler = jest.fn() as (error: any, props: HandlerProps) => Promise<void>
        const reportingErrorHandler =
            handlerImpl(
                simpleApiS.metadata.implementation.errorGenerator,
                () => Promise.reject("Custom error"),
                errorHandler
            )
        await reportingErrorHandler({ body: `["mandatory","nullable"]` })
        expect(errorHandler).toHaveBeenCalledWith("Custom error", {})
    })
});