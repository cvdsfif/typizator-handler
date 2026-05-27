const processOnCallbacks: Record<string, any> = {}
jest.spyOn(process, 'on').mockImplementation((((event: string, cb: any) => {
    processOnCallbacks[event] = cb
}) as any))

jest.spyOn(process, "exit").mockImplementation((() => undefined) as any)

const getSecretValueMock = jest.fn()
const sendMock = jest.fn()
const valkeyCtorMock = jest.fn()
let valkeyQuitShouldThrow = false

jest.mock("@aws-sdk/client-secrets-manager", () => {
    return {
        SecretsManager: jest.fn().mockImplementation(() => ({
            getSecretValue: getSecretValueMock,
        })),
    }
})

jest.mock("@aws-sdk/client-s3", () => {
    class GetObjectCommand {
        public input: any
        constructor(input: any) { this.input = input }
    }
    class PutObjectCommand {
        public input: any
        constructor(input: any) { this.input = input }
    }
    class DeleteObjectCommand {
        public input: any
        constructor(input: any) { this.input = input }
    }

    return {
        S3Client: jest.fn().mockImplementation(() => ({
            send: sendMock,
        })),
        GetObjectCommand,
        PutObjectCommand,
        DeleteObjectCommand,
    }
})

jest.mock("iovalkey", () => {
    return {
        __esModule: true,
        default: jest.fn().mockImplementation((cfg: any) => {
            valkeyCtorMock(cfg)
            return {
                quit: jest.fn(() => {
                    if (valkeyQuitShouldThrow) throw new Error("quit-failed")
                })
            }
        })
    }
})

import { apiS, stringS } from "typizator"
import { HandlerProps, lambdaConnector } from "../src"

describe("index.ts cache + bucket integration", () => {
    let externalEnvironment: any

    beforeEach(() => {
        externalEnvironment = {} as any
        for (const key in process.env) externalEnvironment[key] = process.env[key]
        getSecretValueMock.mockReset()
        sendMock.mockReset()
        valkeyCtorMock.mockReset()
        valkeyQuitShouldThrow = false
        delete processOnCallbacks.SIGTERM
            ; (process.exit as any as jest.Mock).mockClear()
        delete process.env.CACHE_ENDPOINT_ADDRESS
        delete process.env.CACHE_ENDPOINT_PORT
        delete process.env.CACHE_SECRET_ARN
        delete process.env.REGION
    })

    afterEach(() => {
        process.env = externalEnvironment
    })

    test("GIVEN cacheConnected handler WHEN env is missing cache vars THEN it throws cache-not-configured error", async () => {
        // GIVEN: a handler that needs cache, but env is not configured
        const api = apiS({
            needsCache: { args: [], retVal: stringS.notNull },
        })
        const handler = lambdaConnector(
            api.metadata.implementation.needsCache,
            async (_: HandlerProps) => "ok",
            { cacheConnected: true }
        )

        // WHEN / THEN: invoking the handler rejects with config error
        await expect(handler({ body: "[]" } as any)).rejects.toThrow(
            /Cache access not configured/
        )
    })

    test("GIVEN cacheConnected handler WHEN secret has no SecretString THEN it throws cache-password-not-available", async () => {
        // GIVEN: env configured but secrets manager returns empty SecretString
        process.env.CACHE_ENDPOINT_ADDRESS = "cache.local"
        process.env.CACHE_ENDPOINT_PORT = "6379"
        process.env.CACHE_SECRET_ARN = "arn:secret"
        getSecretValueMock.mockResolvedValue({ SecretString: undefined })

        const api = apiS({
            needsCache: { args: [], retVal: stringS.notNull },
        })
        const handler = lambdaConnector(
            api.metadata.implementation.needsCache,
            async (_: HandlerProps) => "ok",
            { cacheConnected: true }
        )

        // WHEN / THEN
        await expect(handler({ body: "[]" } as any)).rejects.toThrow(
            /Cache password not available/
        )
    })

    test("GIVEN cacheConnected handler WHEN secret JSON has no password THEN it throws cache-password-not-found", async () => {
        // GIVEN
        process.env.CACHE_ENDPOINT_ADDRESS = "cache.local"
        process.env.CACHE_ENDPOINT_PORT = "6379"
        process.env.CACHE_SECRET_ARN = "arn:secret"
        getSecretValueMock.mockResolvedValue({ SecretString: JSON.stringify({ username: "u" }) })

        const api = apiS({
            needsCache: { args: [], retVal: stringS.notNull },
        })
        const handler = lambdaConnector(
            api.metadata.implementation.needsCache,
            async (_: HandlerProps) => "ok",
            { cacheConnected: true }
        )

        // WHEN / THEN
        await expect(handler({ body: "[]" } as any)).rejects.toThrow(
            /Cache password not found/
        )
    })

    test("GIVEN cacheConnected handler WHEN env+secret are correct THEN it creates Valkey client with expected config", async () => {
        // GIVEN
        process.env.CACHE_ENDPOINT_ADDRESS = "cache.local"
        process.env.CACHE_ENDPOINT_PORT = "6380"
        process.env.CACHE_SECRET_ARN = "arn:secret"
        getSecretValueMock.mockResolvedValue({ SecretString: JSON.stringify({ username: "u", password: "p" }) })

        const api = apiS({
            needsCache: { args: [], retVal: stringS.notNull },
        })
        const impl = jest.fn(async (_: HandlerProps) => "ok")
        const handler = lambdaConnector(
            api.metadata.implementation.needsCache,
            impl,
            { cacheConnected: true }
        )

        // WHEN
        const result = await handler({ body: "[]" } as any)

        // THEN
        expect(impl).toHaveBeenCalled()
        expect(result).toEqual({ data: "\"ok\"" })
        expect(valkeyCtorMock).toHaveBeenCalledWith({
            host: "cache.local",
            port: 6380,
            username: "u",
            password: "p",
            tls: {},
        })
    })

    test("GIVEN buckets are requested WHEN bucket secret env var is missing THEN it throws Bucket not configured", async () => {
        // GIVEN: a handler that requests bucket access but env var is missing
        const api = apiS({
            needsBucket: { args: [], retVal: stringS.notNull },
        })
        const handler = lambdaConnector(
            api.metadata.implementation.needsBucket,
            async (_: HandlerProps) => "ok",
            { buckets: ["my-bucket"] }
        )

        // WHEN / THEN
        await expect(handler({ body: "[]" } as any)).rejects.toThrow(
            /Bucket my-bucket not configured/
        )
    })

    test("GIVEN buckets are requested WHEN secret is not found THEN it throws Secret <arn> not found", async () => {
        // GIVEN
        process.env.BUCKET_MY__BUCKET_SECRET_ARN = "arn:bucket-secret"
        getSecretValueMock.mockResolvedValue({ SecretString: undefined })

        const api = apiS({
            needsBucket: { args: [], retVal: stringS.notNull },
        })
        const handler = lambdaConnector(
            api.metadata.implementation.needsBucket,
            async (_: HandlerProps) => "ok",
            { buckets: ["my-bucket"] }
        )

        // WHEN / THEN
        await expect(handler({ body: "[]" } as any)).rejects.toThrow(
            /Secret arn:bucket-secret not found/
        )
    })

    test("GIVEN a bucket accessor WHEN getStringContents gets unicode THEN it decodes utf16le", async () => {
        // GIVEN: bucket is configured and S3 returns a body
        process.env.REGION = "eu-west-2"
        process.env.BUCKET_MY__BUCKET_SECRET_ARN = "arn:bucket-secret"
        getSecretValueMock.mockResolvedValue({
            SecretString: JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "SECRET" }),
        })

        const bytes = Uint8Array.from(Buffer.from("A", "utf16le"))
        sendMock.mockResolvedValue({
            Body: {
                transformToByteArray: async () => bytes,
            },
        })

        const api = apiS({
            needsBucket: { args: [], retVal: stringS.notNull },
        })
        const impl = jest.fn(async (props: HandlerProps) => {
            const [err, text] = await props.buckets!["my-bucket"].getStringContents("key", "unicode")
            if (err) return err
            return text ?? ""
        })

        const handler = lambdaConnector(
            api.metadata.implementation.needsBucket,
            impl,
            { buckets: ["my-bucket"] }
        )

        // WHEN
        const result = await handler({ body: "[]" } as any)

        // THEN
        expect(result).toEqual({ data: "\"A\"" })
    })

    test("GIVEN a bucket accessor WHEN getStringContents has no body THEN it returns 'No body content found'", async () => {
        // GIVEN
        process.env.REGION = "eu-west-2"
        process.env.BUCKET_MY__BUCKET_SECRET_ARN = "arn:bucket-secret"
        getSecretValueMock.mockResolvedValue({
            SecretString: JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "SECRET" }),
        })

        sendMock.mockResolvedValue({ Body: undefined })

        const api = apiS({
            needsBucket: { args: [], retVal: stringS.notNull },
        })
        const impl = jest.fn(async (props: HandlerProps) => {
            const [err] = await props.buckets!["my-bucket"].getStringContents("key")
            return err ?? ""
        })

        const handler = lambdaConnector(
            api.metadata.implementation.needsBucket,
            impl,
            { buckets: ["my-bucket"] }
        )

        // WHEN
        const result = await handler({ body: "[]" } as any)

        // THEN
        expect(result).toEqual({ data: "\"No body content found\"" })
    })

    test("GIVEN a bucket accessor WHEN getStringContents throws THEN it returns the error message", async () => {
        // GIVEN
        process.env.REGION = "eu-west-2"
        process.env.BUCKET_MY__BUCKET_SECRET_ARN = "arn:bucket-secret"
        getSecretValueMock.mockResolvedValue({
            SecretString: JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "SECRET" }),
        })

        sendMock.mockRejectedValue(new Error("s3-down"))

        const api = apiS({
            needsBucket: { args: [], retVal: stringS.notNull },
        })
        const impl = jest.fn(async (props: HandlerProps) => {
            const [err] = await props.buckets!["my-bucket"].getStringContents("key")
            return err ?? ""
        })

        const handler = lambdaConnector(
            api.metadata.implementation.needsBucket,
            impl,
            { buckets: ["my-bucket"] }
        )

        // WHEN
        const result = await handler({ body: "[]" } as any)

        // THEN
        expect(result).toEqual({ data: "\"s3-down\"" })
    })

    test("GIVEN a bucket accessor WHEN putStringContents throws THEN it returns success=false and error message", async () => {
        // GIVEN
        process.env.REGION = "eu-west-2"
        process.env.BUCKET_MY__BUCKET_SECRET_ARN = "arn:bucket-secret"
        getSecretValueMock.mockResolvedValue({
            SecretString: JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "SECRET" }),
        })

        sendMock.mockRejectedValue(new Error("s3-down"))

        const api = apiS({
            needsBucket: { args: [], retVal: stringS.notNull },
        })
        const impl = jest.fn(async (props: HandlerProps) => {
            const res = await props.buckets!["my-bucket"].putStringContents("key", "X", "unicode")
            return JSON.stringify(res)
        })

        const handler = lambdaConnector(
            api.metadata.implementation.needsBucket,
            impl,
            { buckets: ["my-bucket"] }
        )

        // WHEN
        const result = await handler({ body: "[]" } as any)

        // THEN
        expect(result).toEqual({ data: "\"{\\\"success\\\":false,\\\"error\\\":\\\"s3-down\\\"}\"" })
    })

    test("GIVEN a bucket accessor WHEN deleteObject throws THEN it returns success=false and error message", async () => {
        // GIVEN
        process.env.REGION = "eu-west-2"
        process.env.BUCKET_MY__BUCKET_SECRET_ARN = "arn:bucket-secret"
        getSecretValueMock.mockResolvedValue({
            SecretString: JSON.stringify({ accessKeyId: "AKIA", secretAccessKey: "SECRET" }),
        })

        sendMock.mockRejectedValue(new Error("s3-down"))

        const api = apiS({
            needsBucket: { args: [], retVal: stringS.notNull },
        })
        const impl = jest.fn(async (props: HandlerProps) => {
            const res = await props.buckets!["my-bucket"].deleteObject("key")
            return JSON.stringify(res)
        })

        const handler = lambdaConnector(
            api.metadata.implementation.needsBucket,
            impl,
            { buckets: ["my-bucket"] }
        )

        // WHEN
        const result = await handler({ body: "[]" } as any)

        // THEN
        expect(result).toEqual({ data: "\"{\\\"success\\\":false,\\\"error\\\":\\\"s3-down\\\"}\"" })
    })

    test("GIVEN cacheConnected handler WHEN SIGTERM cleanup fails THEN it is caught and does not throw", async () => {
        // GIVEN: cache is connected and quit will throw
        process.env.CACHE_ENDPOINT_ADDRESS = "cache.local"
        process.env.CACHE_ENDPOINT_PORT = "6380"
        process.env.CACHE_SECRET_ARN = "arn:secret"
        getSecretValueMock.mockResolvedValue({ SecretString: JSON.stringify({ username: "u", password: "p" }) })
        valkeyQuitShouldThrow = true

        const api = apiS({
            needsCache: { args: [], retVal: stringS.notNull },
        })
        const handler = lambdaConnector(
            api.metadata.implementation.needsCache,
            async (_: HandlerProps) => "ok",
            { cacheConnected: true }
        )

        await handler({ body: "[]" } as any)

        // WHEN: SIGTERM is received
        const sigtermHandler = processOnCallbacks.SIGTERM
        expect(typeof sigtermHandler).toBe("function")

        // THEN: cleanup error is swallowed by the try/catch (covers lines 649-653)
        await expect(sigtermHandler()).resolves.toBeUndefined()
    })
})
