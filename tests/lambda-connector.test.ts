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
    let DB_APP_NAME: string
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
        DB_APP_NAME = handlers.DB_APP_NAME
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
                application_name: DB_APP_NAME
            }])
    })
})