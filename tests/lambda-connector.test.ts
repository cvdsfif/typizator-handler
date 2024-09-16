import { apiS, intS } from "typizator"
import { HandlerEvent, HandlerResponse } from "../src/handler-objects"
import { GetSecretValueCommandInput } from "@aws-sdk/client-secrets-manager"

describe("Test the lambda connector against a mock environment", () => {
    type SecretsDictionary = {
        [K: string]: string
    }

    const mockValues = {
        actualSecretString: null as any,
        clientPassedArgs: [] as any[],
        errorOnNextCall: false,
        secretsDictionary: {} as SecretsDictionary
    }

    const resetMockValues = () => {
        mockValues.actualSecretString = null
        mockValues.clientPassedArgs = []
        mockValues.errorOnNextCall = false
        mockValues.secretsDictionary = {}
    }

    let getDataHandler: (event: HandlerEvent) => Promise<HandlerResponse>
    let getReplicaDataHandler: (event: HandlerEvent) => Promise<HandlerResponse>
    let DB_APP_NAME: string
    let MIN_CONNECTION_IDLE_TIME_SEC: number
    let MAX_CONNECTIONS: number
    let handlers: any

    type DatabaseConnection = {
        client: any
    }
    type HandlerProps = {
        db?: DatabaseConnection,
        firebaseAdmin?: any,
        secrets?: any,
        telegraf?: any
    }
    const dataApi = apiS({
        getData: { args: [], retVal: intS }
    })

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

        jest.mock("serverless-postgres", () => jest.fn().mockImplementation((...args: any) => {
            mockValues.clientPassedArgs = args;
            return {
                connect: jest.fn(),
                clean: jest.fn(),
                query: jest.fn().mockResolvedValue({ rows: [{ one: 1 }] }),
                end: jest.fn()
            }
        })
        )

        handlers = require("../src");
        getDataHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                const result = await props.db!.client.query("SELECT 1 as one");
                return result.rows[0].one;
            },
            {
                databaseConnected: true
            }
        )
        getReplicaDataHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                const result = await props.db!.client.query("SELECT 1 as one");
                return result.rows[0].one;
            },
            {
                databaseConnected: true,
                useDatabaseReplica: true
            }
        )
        DB_APP_NAME = handlers.DB_APP_NAME
        MIN_CONNECTION_IDLE_TIME_SEC = handlers.MIN_CONNECTION_IDLE_TIME_SEC
        MAX_CONNECTIONS = handlers.MAX_CONNECTIONS
    })

    let externalEnvironment

    beforeEach(async () => {
        externalEnvironment = {} as any
        for (const key in process.env) externalEnvironment[key] = process.env[key]
    })

    afterEach(async () => {
        process.env = externalEnvironment!
    })

    test("Should correctly configure the database", async () => {
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
        mockValues.actualSecretString = `{ "password": "secret" }`
        expect(await getDataHandler({ body: "" })).toEqual({ data: "1" })
        expect(mockValues.clientPassedArgs).toEqual([
            {
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
                manualMaxConnections: true
            }])
    })

    test("Should correctly configure the database with read replica", async () => {
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_REPLICA_ENDPOINT_ADDRESS = "http://xxx.replica"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
        mockValues.actualSecretString = `{ "password": "secret" }`
        expect(await getReplicaDataHandler({ body: "" })).toEqual({ data: "1" })
        expect(mockValues.clientPassedArgs).toEqual([
            {
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
                manualMaxConnections: true
            }])
    })

    test("Should correctly configure the database with non-default parameters", async () => {
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
        process.env.DB_APP_NAME = "differentName"
        process.env.MIN_CONNECTION_IDLE_TIME_SEC = "7"
        process.env.MAX_CONNECTIONS = "42"
        mockValues.actualSecretString = `{ "password": "secret" }`
        expect(await getDataHandler({ body: "" })).toEqual({ data: "1" })
        expect(mockValues.clientPassedArgs).toEqual([
            {
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
                manualMaxConnections: true
            }])
    })
})