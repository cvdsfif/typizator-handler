import { InferTargetFromSchema, apiS, arrayS, bigintS, objectS, stringS } from "typizator";
import { HandlerEvent, HandlerProps, PING, SECURITY_TOKEN_COOKIE_NAME, TOKEN_FROM_COOKIE, lambdaConnector } from "../src";
import { SpecialHeders } from "../src/handler-objects";

describe("Testing the type conversion facade for AWS lambdas", () => {
    const simpleRecordS = objectS({
        id: bigintS.notNull,
        name: stringS.notNull
    }).notNull
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
    })

    jest.spyOn(process, 'on').mockImplementation((() => { }) as any)

    let externalEnvironment

    beforeEach(async () => {
        externalEnvironment = {} as any
        for (const key in process.env) externalEnvironment[key] = process.env[key]
    })

    afterEach(async () => process.env = externalEnvironment!)

    const meowHandler =
        lambdaConnector(
            simpleApiS.metadata.implementation.meow,
            () => Promise.resolve("Miaou")
        )

    const meowHandlerDirect =
        lambdaConnector(
            simpleApiS.metadata.implementation.meow,
            () => Promise.resolve("Miaou"),
            { directReturn: true }
        )
    const noMeowHandler =
        lambdaConnector(
            simpleApiS.metadata.implementation.noMeow,
            () => Promise.resolve()
        )

    type SimpleType = InferTargetFromSchema<typeof simpleRecordS>
    const incrementHandler =
        lambdaConnector(
            simpleApiS.metadata.implementation.increment,
            (_: HandlerProps, check: SimpleType) => Promise.resolve({ id: check.id + 1n, name: `Incremented ${check.name}` })
        )
    const incrementHandlerDirect =
        lambdaConnector(
            simpleApiS.metadata.implementation.increment,
            (_: HandlerProps, check: SimpleType) => Promise.resolve({ id: check.id + 1n, name: `Incremented ${check.name}` }),
            { directReturn: true }
        )
    const helloWorldImpl = (_: HandlerProps, name: string, num: bigint) => Promise.resolve(`${num} greetings to ${name}`)
    const helloWorldHandler =
        lambdaConnector(
            simpleApiS.metadata.implementation.helloWorld,
            helloWorldImpl
        )
    const doubleArrayHandler =
        lambdaConnector(
            simpleApiS.metadata.implementation.doubleArray,
            (_: HandlerProps, source: string[]) => Promise.resolve([...source, ...source])
        )
    const errorGeneratorHandler =
        lambdaConnector(
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
    })

    test("Should check the handlers implementations with direct return", async () => {
        expect(await meowHandlerDirect({ body: "" })).toEqual({ "statusCode": 200, "body": "Miaou" });
        expect(await incrementHandlerDirect({ body: `[{"id":"12345678901234567890","name":"Thing"}]` }))
            .toEqual({ "statusCode": 200, "body": { "id": 12345678901234567891n, "name": "Incremented Thing" } });
    })

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
            lambdaConnector(
                simpleApiS.metadata.implementation.errorGenerator,
                () => Promise.reject("Custom error"),
                { databaseConnected: false, errorHandler }
            )
        await reportingErrorHandler({ body: `["mandatory","nullable"]` })
        expect(errorHandler).toHaveBeenCalledWith("Custom error", expect.any(Object), { name: "errorGenerator", path: "/errorGenerator" })
    })

    test("Should authorize the handler access if the access rights match", async () => {
        // GIVEN the access mask set for the handler and the security token
        const ACCESS_MASK = 0b1
        process.env.ACCESS_MASK = `${ACCESS_MASK}`
        const SECURITY_TOKEN = "Tiktok"

        // AND the authenticator returns true
        const authenticator = jest.fn().mockReturnValue(true)

        // AND a handler is set up
        const meowFn = jest.fn().mockReturnValue("Ok")
        const meowHandler =
            lambdaConnector(
                simpleApiS.metadata.implementation.meow,
                meowFn,
                { databaseConnected: false, authenticator }
            )

        // WHEN calling the handler
        const result = await meowHandler({ body: "Any body", headers: { "x-security-token": SECURITY_TOKEN } })

        // THEN the authenticator function is called with the right parameters
        expect(authenticator).toHaveBeenCalledWith(expect.any(Object), "", { mask: ACCESS_MASK })

        // AND the underlying function is called
        expect(meowFn).toHaveBeenCalled()

        // AND the result of the call returns the correct value
        expect(result).toEqual({ "data": "\"Ok\"" })
    })

    test("Should not authorize the handler access if the access is forbidden", async () => {
        // GIVEN the access mask set for the handler and the security token
        const ACCESS_MASK = 0b1
        process.env.ACCESS_MASK = `${ACCESS_MASK}`
        const SECURITY_TOKEN = "Tiktok"

        // AND the authenticator returns false (unauthorized)
        const authenticator = jest.fn().mockReturnValue(false)

        // AND a handler is set up
        const meowFn = jest.fn()
        const meowHandler =
            lambdaConnector(
                simpleApiS.metadata.implementation.meow,
                meowFn,
                { databaseConnected: false, authenticator }
            )

        // WHEN calling the handler
        const result = await meowHandler({ body: "Any body", headers: { "x-security-token": SECURITY_TOKEN } })

        // THEN the authenticator function is called with the right parameters
        expect(authenticator).toHaveBeenCalledWith(expect.any(Object), "", { mask: ACCESS_MASK })

        // AND the underlying function is not called
        expect(meowFn).not.toHaveBeenCalled()

        // AND the result of the call reflects the authorization error
        expect(result).toEqual({
            statusCode: 401,
            body: "Unauthorized",
            data: ""
        })
    })

    test("Should not authorize the handler access if the IP addresses list doesn't match the client's address", async () => {
        // GIVEN the IP addresses list
        const IP_LIST = ["10.0.0.1"]
        process.env.IP_LIST = `${JSON.stringify(IP_LIST)}`

        // AND a handler is set up
        const meowFn = jest.fn()
        const meowHandler =
            lambdaConnector(
                simpleApiS.metadata.implementation.meow,
                meowFn
            )

        // WHEN calling the handler
        const result = await meowHandler({ body: "Any body", headers: { "x-forwarded-for": "10.0.0.2" } })

        // THEN the underlying function is not called
        expect(meowFn).not.toHaveBeenCalled()

        // AND the result of the call reflects the authorization error
        expect(result).toEqual({
            statusCode: 401,
            body: "Unauthorized",
            data: ""
        })
    })

    test("Should authorize the handler access if the IP addresses list matches the client's address", async () => {
        // GIVEN the IP addresses list
        const IP_LIST = ["10.0.0.1"]
        process.env.IP_LIST = `${JSON.stringify(IP_LIST)}`

        // AND a handler is set up
        const meowFn = jest.fn().mockReturnValue("Ok")
        const meowHandler =
            lambdaConnector(
                simpleApiS.metadata.implementation.meow,
                meowFn
            )

        // WHEN calling the handler
        const result = await meowHandler({ body: "Any body", headers: { "x-forwarded-for": "10.0.0.1" } })

        // THEN the underlying function is called
        expect(meowFn).toHaveBeenCalled()

        // AND the result of the call returns the correct value
        expect(result).toEqual({ "data": "\"Ok\"" })
    })

    test("Should forward handler to the underlying implementartion", async () => {
        // GIVEN a handler is set up
        const headers = {} as SpecialHeders
        const sourceEvent = { body: "[]", headers } satisfies HandlerEvent
        let eventReceived: HandlerEvent | undefined
        const handler =
            lambdaConnector(
                simpleApiS.metadata.implementation.noMeow,
                async (props: HandlerProps) => { eventReceived = props.event }
            )

        // WHEN invoking the handler
        await handler(sourceEvent)


        // THEN the underlying event is forwarede as it is
        expect(sourceEvent === eventReceived!).toBeTruthy()
    })
})