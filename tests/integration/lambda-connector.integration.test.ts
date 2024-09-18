import ServerlessClient from "serverless-postgres";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { apiS, intS } from "typizator";
import { HandlerEvent, HandlerResponse } from "../../src/handler-objects";
import { BatchResponse } from "../../node_modules/firebase-admin/lib/messaging/messaging-api"
import { GetSecretValueCommandInput } from "@aws-sdk/client-secrets-manager";
import { Telegraf } from "telegraf";

describe("Test interfaces behaviour on a real database", () => {
    jest.setTimeout(60000)
    let getDataHandler: (event: HandlerEvent) => Promise<HandlerResponse>
    let connectedHandler: (event: HandlerEvent) => Promise<HandlerResponse>
    let testClient: any

    type SecretsDictionary = {
        [K: string]: string
    }

    const mockValues = {
        actualSecretString: null as any,
        errorOnNextCall: false,
        secretsDictionary: {} as SecretsDictionary
    }

    const resetMockValues = () => {
        mockValues.actualSecretString = null
        mockValues.errorOnNextCall = false
        mockValues.secretsDictionary = {}
    }

    const initializeAppMock = jest.fn()
    const certMock = jest.fn()
    const sendForMulticastMock = jest.fn()
    const initializedFirebaseApps = [] as any[]
    let handlers: any

    type DatabaseConnection = {
        client: ServerlessClient
    }
    type FirebaseAdminConnection = {
        sendMulticastNotification?: (title: string, body: string, tokens: string[], link?: string) => Promise<BatchResponse>
    }
    type HandlerProps = {
        db?: DatabaseConnection,
        firebaseAdmin?: FirebaseAdminConnection,
        secrets?: SecretsDictionary,
        telegraf?: Telegraf
    }
    const dataApi = apiS({
        getData: { args: [], retVal: intS }
    })

    const messageTitle = "title"
    const messageSent = "msg"
    const tokens = ["t1", "t2"]

    const telegrafHandlerMock = jest.fn()

    const telegrafStub = {
        handleUpdate: telegrafHandlerMock as any
    } as Telegraf
    const telegrafMock = jest.fn().mockImplementation((_: string) => telegrafStub)

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

        jest.mock("telegraf", () => ({
            Telegraf: telegrafMock
        }))

        const container = await new PostgreSqlContainer().withReuse().start()
        testClient = new ServerlessClient({ connectionString: container.getConnectionUri() })


        jest.mock("firebase-admin", () => ({
            initializeApp: initializeAppMock,
            credential: {
                cert: certMock
            },
            messaging: jest.fn().mockImplementation(() => ({
                sendEachForMulticast: sendForMulticastMock
            })),
            apps: initializedFirebaseApps
        }))

        handlers = require("../../src");
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
    })

    const connectStandardFbHandler = () => {
        connectedHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                await props.firebaseAdmin?.sendMulticastNotification?.(messageTitle, messageSent, tokens)
                return 1;
            },
            {
                firebaseAdminConnected: true
            }
        )
    }

    afterAll(async () => await testClient.clean())

    let externalEnvironment

    beforeEach(async () => {
        externalEnvironment = {} as any
        for (const key in process.env) externalEnvironment[key] = process.env[key]
        sendForMulticastMock.mockImplementation(() => Promise.resolve({
            successCount: 1,
            failureCount: 1,
            responses: [{
                success: false,
                messageId: 1,
                error: {
                    message: "Err",
                    code: 1
                }
            }, { success: true }]
        }))
        initializedFirebaseApps.splice(0, initializedFirebaseApps.length)
    })

    afterEach(async () => {
        initializeAppMock.mockReset()
        certMock.mockReset()
        sendForMulticastMock.mockReset()
        telegrafMock.mockReset().mockImplementation((_: string) => telegrafStub)
        telegrafHandlerMock.mockReset()
        resetMockValues()
        process.env = externalEnvironment!
    })

    test("Should raise an exception if the database access is not configured", async () => {
        (expect(await getDataHandler({ body: "" }))).toEqual(expect.stringContaining("access not configured"));
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx";
        (expect(await getDataHandler({ body: "" }))).toEqual(expect.stringContaining("access not configured"));
        process.env.DB_NAME = "db";
        (expect(await getDataHandler({ body: "" }))).toEqual(expect.stringContaining("access not configured"));
        process.env.DB_SECRET_ARN = "arn";
        (expect(await getDataHandler({ body: "" }))).toEqual(expect.stringContaining("password not available"));
    })

    test("Should expose database as connected resource for the database handler", async () => {
        expect((getDataHandler as any).connectedResources).toEqual(expect.arrayContaining([
            "DATABASE"
        ]))
    })

    test("Should correctly configure Firebase admin", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND some secret object is returned by the secrets manager and the certificate mock returns some value
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND a standard handler is connected
        connectStandardFbHandler()

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "" })

        // THEN it correctly returns
        expect(data).toEqual({ data: "1" })

        // AND Firebase is correctly initialized
        expect(certMock).toHaveBeenCalledWith(JSON.parse(mockValues.actualSecretString))
        expect(initializeAppMock).toHaveBeenCalledWith({ credential: "cert", databaseURL: "fbdb" })

        // AND a call is made for a group notification
        expect(sendForMulticastMock).toHaveBeenCalledWith(expect.objectContaining({
            notification: {
                title: messageTitle,
                body: messageSent
            },
            tokens
        }))

        // AND the handler is marked as having a firebase connection
        expect((connectedHandler as any).connectedResources).toEqual(expect.arrayContaining([
            "FIREBASE_ADMIN"
        ]))
    })

    test("Should acknowledge sending success", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND some secret object is returned by the secrets manager and the certificate mock returns some value
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND a standard handler is connected
        connectStandardFbHandler()

        // AND sending reports success
        sendForMulticastMock.mockImplementation(() => Promise.resolve({
            successCount: 1,
            failureCount: 0,
            responses: [{ success: true }]
        }))

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "" })

        // THEN it correctly returns
        expect(data).toEqual({ data: "1" })
    })

    test("Should acknowledge sending success with empty response list", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND some secret object is returned by the secrets manager and the certificate mock returns some value
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND a standard handler is connected
        connectStandardFbHandler()

        // AND sending reports success
        sendForMulticastMock.mockImplementation(() => Promise.resolve({
            successCount: 1,
            failureCount: 0
        }))

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "" })

        // THEN it correctly returns
        expect(data).toEqual({ data: "1" })
    })

    test("Should ignore empty push tokens", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND some secret object is returned by the secrets manager and the certificate mock returns some value
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND the connected handler returns a list with an empty token
        connectedHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                await props.firebaseAdmin?.sendMulticastNotification?.(messageTitle, messageSent, ["t1", "", "t2"])
                return 1;
            },
            {
                firebaseAdminConnected: true
            }
        )

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "" })

        // THEN we have a group notification without the empty tokens
        expect(sendForMulticastMock).toHaveBeenCalledWith(expect.objectContaining({
            notification: {
                title: messageTitle,
                body: messageSent
            },
            tokens: ["t1", "t2"]
        }))
    })

    test("Should correctly count failures", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND some secret object is returned by the secrets manager and the certificate mock returns some value
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND sending reports success
        sendForMulticastMock.mockImplementation(() => Promise.resolve({
            successCount: 1,
            failureCount: 0
        }))

        // AND the connected handler returns a list with an empty token
        connectedHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                return (
                    await props.firebaseAdmin?.sendMulticastNotification?.(messageTitle, messageSent, ["t1", "t2"])
                )?.failureCount
            },
            {
                firebaseAdminConnected: true
            }
        )

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "" })

        // THEN it correctly returns
        expect(data).toEqual({ data: "0" })
    })

    test("Should tolerate google notifications fckups", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND some secret object is returned by the secrets manager and the certificate mock returns some value
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND the firebase multicast fails
        sendForMulticastMock.mockImplementation(() => Promise.reject(new Error("Rejected")))

        // AND a standard handler is connected
        connectStandardFbHandler()

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "" })

        // THEN the call passes without errors
        expect(data).toEqual({ data: "1" })
    })

    test("Should send google notifications even if the system tries to initialize the firebase system twice", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND some secret object is returned by the secrets manager and the certificate mock returns some value
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND there is already an initialized firebase app
        initializedFirebaseApps.push({})

        // AND a standard handler is connected
        connectStandardFbHandler()

        // WHEN calling the connected handler
        await connectedHandler({ body: "" })

        // THEN Firebase initialization is not called
        expect(certMock).not.toHaveBeenCalled()
        expect(initializeAppMock).not.toHaveBeenCalled()

        // AND a call is made for a group notification
        expect(sendForMulticastMock).toHaveBeenCalledWith(expect.objectContaining({
            notification: {
                title: messageTitle,
                body: messageSent
            },
            tokens
        }))
    })

    test("Should not try to send notifications if there are no keys stored in the secret", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND there is no secret value in the store
        mockValues.actualSecretString = null
        certMock.mockReturnValue("cert")

        // AND a standard handler is connected
        connectStandardFbHandler()

        // WHEN calling the connected handler
        await connectedHandler({ body: "" })

        // THEN Firebase initialization is not called
        expect(certMock).not.toHaveBeenCalled()
        expect(initializeAppMock).not.toHaveBeenCalled()

        // AND a call is made for a group notification
        expect(sendForMulticastMock).not.toHaveBeenCalled()
    })

    test("Should not try to send notifications an error occurs during the secret's retrieval", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND there is no secret value in the store
        mockValues.errorOnNextCall = true
        certMock.mockReturnValue("cert")

        // AND a standard handler is connected
        connectStandardFbHandler()

        // WHEN calling the connected handler
        await connectedHandler({ body: "" })

        // THEN Firebase initialization is not called
        expect(certMock).not.toHaveBeenCalled()
        expect(initializeAppMock).not.toHaveBeenCalled()

        // AND a call is made for a group notification
        expect(sendForMulticastMock).not.toHaveBeenCalled()
    })

    test("Should not try to send notifications if there is no secret ARN provided", async () => {
        // GIVEN the secret ARN is missing
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND there is no secret value in the store
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND a standard handler is connected
        connectStandardFbHandler()

        // WHEN calling the connected handler
        await connectedHandler({ body: "" })

        // THEN Firebase initialization is not called
        expect(certMock).not.toHaveBeenCalled()
        expect(initializeAppMock).not.toHaveBeenCalled()

        // AND a call is made for a group notification
        expect(sendForMulticastMock).not.toHaveBeenCalled()
    })

    test("Should not try to send notifications if there is no database name", async () => {
        // GIVEN the secret ARN is missing
        process.env.FB_SECRET_ARN = "fbarn"

        // AND there is no secret value in the store
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND a standard handler is connected
        connectStandardFbHandler()

        // WHEN calling the connected handler
        await connectedHandler({ body: "" })

        // THEN Firebase initialization is not called
        expect(certMock).not.toHaveBeenCalled()
        expect(initializeAppMock).not.toHaveBeenCalled()

        // AND a call is made for a group notification
        expect(sendForMulticastMock).not.toHaveBeenCalled()
    })

    test("Should correctly send Firebase notifications with Android links", async () => {
        // GIVEN the environment variables are correctly configured
        process.env.FB_SECRET_ARN = "fbarn"
        process.env.FB_DATABASE_NAME = "fbdb"

        // AND some secret object is returned by the secrets manager and the certificate mock returns some value
        mockValues.actualSecretString = `{ "password": "secret" }`
        certMock.mockReturnValue("cert")

        // AND a standard handler is connected and configured to send Android links with the package
        connectedHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                await props.firebaseAdmin?.sendMulticastNotification?.(messageTitle, messageSent, ["t1", "t2"], "http://link")
                return 1;
            },
            {
                firebaseAdminConnected: true
            }
        )

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "" })

        // THEN it correctly returns
        expect(data).toEqual({ data: "1" })

        // AND Firebase is correctly initialized
        expect(certMock).toHaveBeenCalledWith(JSON.parse(mockValues.actualSecretString))
        expect(initializeAppMock).toHaveBeenCalledWith({ credential: "cert", databaseURL: "fbdb" })

        // AND a call is made for a group notification
        expect(sendForMulticastMock).toHaveBeenCalledWith(expect.objectContaining({
            notification: {
                title: messageTitle,
                body: messageSent
            },
            data: {
                meta: "root data",
                click_action: "http://link"
            },
            android: {
                data: {
                    meta: "android data",
                    click_action: "http://link"
                },
                notification: {
                    title: messageTitle,
                    body: messageSent,
                    clickAction: "http://link"
                }
            },
            tokens
        }))

        // AND the handler is marked as having a firebase connection
        expect((connectedHandler as any).connectedResources).toEqual(expect.arrayContaining([
            "FIREBASE_ADMIN"
        ]))
    })

    test("Should correctly retrieve AWS secrets and transmit them to the handler", async () => {
        // GIVEN the environment variable containing the list of secrets
        process.env.SECRETS_LIST = "arn1,arn2"

        // AND secret values returned depenging on secret ARNs passed
        mockValues.secretsDictionary = {
            arn1: "val1",
            arn2: "val2"
        }

        // AND a standard handler is connected and configured to use secret values
        let secretsReceived = {} as SecretsDictionary
        connectedHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                secretsReceived = props.secrets!
            },
            {
                secretsUsed: true
            }
        )

        // WHEN calling the connected handler
        await connectedHandler({ body: "" })

        // THEN the secrets are correctly received
        expect(secretsReceived).toEqual([{ SecretString: "val1" }, { SecretString: "val2" }])

        // AND the handler is marked as having secrets
        expect((connectedHandler as any).connectedResources).toEqual(expect.arrayContaining([
            "SECRETS"
        ]))
    })

    test("Should raise an exception if the secrets connection is required and there is no matching environment variables", async () => {
        // GIVEN there are no environment variables for secrets

        // AND a standard handler is connected and configured to use secret values
        connectedHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => { },
            {
                secretsUsed: true
            }
        )

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "" })

        // THEN an exception value is returned
        expect(data).toEqual(expect.stringContaining("Secrets list not specified"))
    })

    test("Should correctly connect a Telegraf handler from a given secret", async () => {
        // GIVEN the environment variable containing the Telegraf secret
        process.env.TELEGRAF_SECRET_ARN = "arn1"

        // AND secret values returned depenging on secret ARNs passed
        mockValues.secretsDictionary = {
            arn1: "val1"
        }

        // AND a standard handler is connected and configured to use telegraf
        let telegrafGot = undefined as Telegraf | undefined
        connectedHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                telegrafGot = props.telegraf
            },
            {
                telegraf: true
            }
        )

        // WHEN calling the connected handler
        await connectedHandler({ body: "{}" })

        // THEN the connected handler correctly receives an instance of Telegraf
        expect(telegrafGot === telegrafStub).toBeTruthy()

        // AND Telegraf is created with the right secret value
        expect(telegrafMock).toHaveBeenCalledWith("val1")

        // AND the handler is marked as having telegraf
        expect((connectedHandler as any).connectedResources).toEqual(expect.arrayContaining([
            "TELEGRAF"
        ]))

        // AND the handler is marked as having secrets
        expect((connectedHandler as any).connectedResources).toEqual(expect.arrayContaining([
            "TELEGRAF"
        ]))

        // AND the Telegram handler is invoked
        expect(telegrafHandlerMock).toHaveBeenCalled()
    })

    test("Should raise an exception if the secrets connection is required and there is no matching environment variables", async () => {
        // GIVEN there are no environment variables for secrets

        // AND a standard handler is connected and configured to inject Telegraf
        connectedHandler = handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async () => { },
            {
                telegraf: true
            }
        )

        // WHEN calling the connected handler
        const data = await connectedHandler({ body: "{}" })

        // THEN an exception value is returned
        expect(data).toEqual(expect.stringContaining("Telegraf secret ARN not specified"))

        // AND the Telegram handler is not invoked
        expect(telegrafHandlerMock).not.toHaveBeenCalled()
    })

    test("Should correctly invoike a teardown handler", async () => {
        // GIVEN the lambda connector set up
        handlers.lambdaConnector(
            dataApi.metadata.implementation.getData,
            async () => { },
            {
                telegraf: true
            }
        )

        // AND our test intercepts the process' exit call
        const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => { }) as any);

        // WHEN sending the termination signal
        process.emit("SIGTERM")

        // THEN the process exits with the code 0
        expect(mockExit).toHaveBeenCalledWith(0);
    })
})