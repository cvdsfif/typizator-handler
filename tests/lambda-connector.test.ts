import { apiS, intS } from "typizator"
import { GetSecretValueCommandInput } from "@aws-sdk/client-secrets-manager"

describe("Test the lambda connector against a mock environment", () => {
    type SecretsDictionary = {
        [K: string]: string
    }

    const mockValues = {
        actualSecretString: null as any,
        errorOnNextCall: false,
        secretsDictionary: {} as SecretsDictionary
    }

    let DB_APP_NAME: string
    let MIN_CONNECTION_IDLE_TIME_SEC: number
    let MAX_CONNECTIONS: number
    let handlers: any

    type DatabaseConnection = {
        client: any
    }
    type HeadersContainer = {
        headers: { [key: string]: string | string[] | undefined },
        cookies?: { [key: string]: string }
    }
    type HandlerProps = {
        db?: DatabaseConnection,
        firebaseAdmin?: any,
        secrets?: any,
        telegraf?: any,
        headersContainer?: HeadersContainer
    }
    const dataApi = apiS({
        getData: { args: [], retVal: intS }
    })

    const postgresConnectorMock = jest.fn()

    const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => { }) as any)
    const onSpyMock = jest.spyOn(process, 'on').mockImplementation((() => { }) as any)

    beforeAll(async () => {
        jest.mock("@aws-sdk/client-secrets-manager", () => ({
            SecretsManager: jest.fn().mockImplementation(() => ({
                getSecretValue: jest.fn().mockImplementation((args: GetSecretValueCommandInput) => {
                    const secret = mockValues.secretsDictionary[args.SecretId!]
                    return mockValues.errorOnNextCall ?
                        Promise.reject("Error") :
                        secret ? Promise.resolve({ SecretString: secret }) :
                            Promise.resolve({
                                SecretString: mockValues.actualSecretString
                            })
                })
            }))
        }))

        jest.mock("serverless-postgres", () => postgresConnectorMock)
    })

    let externalEnvironment

    const init = async () => {
        handlers = require("../src")
        const getDataHandler = () => handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                const result = await props.db!.client.query("SELECT 1 as one");
                return result.rows[0].one;
            },
            {
                databaseConnected: true
            }
        )
        const getEmptyDataHandler = () => handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                return ""
            }
        )
        const getHeadersDataHandler = () => handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                props.headersContainer = {
                    headers: {
                        "x-custom-header": "custom-value"
                    },
                    cookies: {
                        "custom-cookie": "cookie-value"
                    }
                }
                return ""
            }
        )
        const getReplicaDataHandler = () => handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                const result = await props.db!.client.query("SELECT 1 as one");
                return result.rows[0].one;
            },
            {
                databaseConnected: true,
                replicaInjection: "inject_as_main"
            }
        )
        DB_APP_NAME = handlers.DB_APP_NAME
        MIN_CONNECTION_IDLE_TIME_SEC = handlers.MIN_CONNECTION_IDLE_TIME_SEC
        MAX_CONNECTIONS = handlers.MAX_CONNECTIONS

        return {
            getDataHandler, getReplicaDataHandler, getEmptyDataHandler, getHeadersDataHandler
        }
    }

    const cleanMock = jest.fn()

    beforeEach(async () => {
        mockExit.mockClear()
        cleanMock.mockClear()
        onSpyMock.mockImplementation((() => { }) as any)
        externalEnvironment = {} as any
        for (const key in process.env) externalEnvironment[key] = process.env[key]
        process.env = {}
        postgresConnectorMock.mockClear()
        postgresConnectorMock.mockImplementation((...args: any) => {
            return {
                connect: jest.fn(),
                clean: cleanMock,
                query: jest.fn().mockResolvedValue({ rows: [{ one: 1 }] }),
                end: jest.fn()
            }
        })
    })

    afterEach(async () => {
        process.env = externalEnvironment!
    })

    test("Should invoke the function placeholder", async () => {
        process.env.CDK_PHASE = "build"
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
        mockValues.actualSecretString = `{ "password": "secret" }`
        const { getEmptyDataHandler } = await init()

        expect(await getEmptyDataHandler()({ body: "" })).toEqual({ data: "\"\"" })
        process.env.CDK_PHASE = undefined
    })

    test("Should invoke the function placeholder and set headers", async () => {
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
        mockValues.actualSecretString = `{ "password": "secret" }`
        const { getHeadersDataHandler } = await init()

        expect(await getHeadersDataHandler()({ body: "" })).toEqual({
            body: JSON.stringify({ data: "\"\"" }),
            headers: {
                "x-custom-header": "custom-value"
            },
            cookies: {
                "custom-cookie": "cookie-value"
            },
            statusCode: 200
        })
    })

    test("Should correctly configure the database", async () => {
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
        mockValues.actualSecretString = `{ "password": "secret" }`
        const { getDataHandler } = await init()

        expect(await getDataHandler()({ body: "" })).toEqual({ data: "1" })
        expect(postgresConnectorMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                user: "postgres",
                database: "db",
                host: "http://xxx.replica",
                password: "secret",
                port: 5432,
                ssl: {
                    rejectUnauthorized: false
                },
                delayMs: 3000,
                application_name: DB_APP_NAME,
                minConnectionIdleTimeSec: MIN_CONNECTION_IDLE_TIME_SEC,
                maxConnections: MAX_CONNECTIONS,
                connUtilization: 0.6,
                maxRetries: 5,
                capMs: 2000
            }))
        expect(postgresConnectorMock).toHaveBeenCalledWith(
            expect.objectContaining({
                user: "postgres",
                database: "db",
                host: "http://xxx",
                password: "secret",
                port: 5432,
                ssl: {
                    rejectUnauthorized: false
                },
                delayMs: 3000,
                application_name: DB_APP_NAME,
                minConnectionIdleTimeSec: MIN_CONNECTION_IDLE_TIME_SEC,
                maxConnections: MAX_CONNECTIONS,
                connUtilization: 0.6,
                maxRetries: 5,
                capMs: 2000
            }))
    })

    test("Should correctly configure the database with read replica", async () => {
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_REPLICA_ENDPOINT_ADDRESS = "http://xxx.replica"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
        mockValues.actualSecretString = `{ "password": "secret" }`
        onSpyMock.mockRestore()
        const { getReplicaDataHandler } = await init()

        expect(await getReplicaDataHandler()({ body: "" })).toEqual({ data: "1" })
        expect(postgresConnectorMock).toHaveBeenCalledWith(
            expect.objectContaining({
                user: "postgres",
                database: "db",
                host: "http://xxx.replica",
                password: "secret",
                port: 5432,
                ssl: {
                    rejectUnauthorized: false
                },
                delayMs: 3000,
                application_name: DB_APP_NAME,
                minConnectionIdleTimeSec: MIN_CONNECTION_IDLE_TIME_SEC,
                maxConnections: MAX_CONNECTIONS,
                connUtilization: 0.6,
                maxRetries: 5,
                capMs: 2000
            }))
        expect(postgresConnectorMock).not.toHaveBeenCalledWith(
            expect.objectContaining({
                user: "postgres",
                database: "db",
                host: "http://xxx",
                password: "secret",
                port: 5432,
                ssl: {
                    rejectUnauthorized: false
                },
                delayMs: 3000,
                application_name: DB_APP_NAME,
                minConnectionIdleTimeSec: MIN_CONNECTION_IDLE_TIME_SEC,
                maxConnections: MAX_CONNECTIONS,
                connUtilization: 0.6,
                maxRetries: 5,
                capMs: 2000
            }))

        process.emit("SIGTERM")
        await new Promise(r => setTimeout(r, 200))

        expect(mockExit).toHaveBeenCalledWith(0)
        expect(cleanMock).toHaveBeenCalled()
    })

    test("Should correctly configure the database with non-default parameters", async () => {
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
        process.env.DB_APP_NAME = "differentName"
        process.env.MIN_CONNECTION_IDLE_TIME_SEC = "7"
        process.env.MAX_CONNECTIONS = "42"
        mockValues.actualSecretString = `{ "password": "secret" }`
        const { getDataHandler } = await init()

        expect(await getDataHandler()({ body: "" })).toEqual({ data: "1" })
        expect(postgresConnectorMock).toHaveBeenCalledWith(
            expect.objectContaining({
                user: "postgres",
                database: "db",
                host: "http://xxx",
                password: "secret",
                port: 5432,
                ssl: {
                    rejectUnauthorized: false
                },
                delayMs: 3000,
                application_name: "differentName",
                minConnectionIdleTimeSec: 7,
                maxConnections: 42,
                connUtilization: 0.6,
                maxRetries: 5,
                capMs: 2000
            }))
    })
})