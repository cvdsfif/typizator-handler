import { apiS, intS } from "typizator"
import { GetSecretValueCommandInput } from "@aws-sdk/client-secrets-manager"

describe("Test the lambda connector against a mock environment for a particular telegram shutdown case", () => {
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
    type HandlerProps = {
        db?: DatabaseConnection,
        firebaseAdmin?: any,
        secrets?: any,
        telegraf?: any
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
        const getTelegrafDataHandler = () => handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                const result = await props.db!.client.query("SELECT 1 as one");
                return result.rows[0].one;
            },
            {
                databaseConnected: true,
                telegraf: true
            }
        )
        DB_APP_NAME = handlers.DB_APP_NAME
        MIN_CONNECTION_IDLE_TIME_SEC = handlers.MIN_CONNECTION_IDLE_TIME_SEC
        MAX_CONNECTIONS = handlers.MAX_CONNECTIONS

        return {
            getTelegrafDataHandler
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

    test("Should catch errors in telegram teardown", async () => {
        // GIVEN there is no database secret information in the environment
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_REPLICA_ENDPOINT_ADDRESS = "http://xxx.replica"
        process.env.DB_NAME = "db"
        mockValues.actualSecretString = `{ "password": "secret" }`

        // AND we have the process signals functioning
        onSpyMock.mockRestore()

        // AND we initialise the handler
        const { getTelegrafDataHandler } = await init()

        // WHEN we call the data handler
        await expect(getTelegrafDataHandler()({ body: "" })).rejects.toThrow()

        // AND we invoke the teardown handler
        process.emit("SIGTERM")
        await new Promise(r => setTimeout(r, 200))

        // THEN the process is exited
        expect(mockExit).toHaveBeenCalled()

        // AND the clean mock is not called
        expect(cleanMock).not.toHaveBeenCalled()
    })
})