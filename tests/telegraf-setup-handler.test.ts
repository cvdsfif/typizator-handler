const BOT_ID = "bot_id"

jest.mock("@aws-sdk/client-secrets-manager", () => ({
    SecretsManager: jest.fn().mockImplementation(() => ({
        getSecretValue: jest.fn().mockImplementation(() => Promise.resolve({
            SecretString: BOT_ID
        }))
    }))
}))

const deleteWebhookMock = jest.fn()
const setWebhookMock = jest.fn()

jest.mock("telegraf", () => ({
    Telegraf: jest.fn().mockImplementation(() => ({
        telegram: {
            setWebhook: setWebhookMock,
            deleteWebhook: deleteWebhookMock
        }
    }))
}))

import { telegrafSetupHandler } from "../src/telegraf-setup-handler";
const handler = telegrafSetupHandler()

describe("Testing the telegraf setup handler", () => {
    let envSaved: any

    beforeEach(() => {
        // To clean the environment before every test, we have to copy it key by key into a new object
        envSaved = {}
        for (const key in process.env) envSaved[key] = process.env[key]
        process.env.TELEGRAF_SECRET_ARN = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        jest.clearAllMocks()
    })

    afterEach(() => {
        process.env = envSaved
    })

    const handlerFields = {
        ServiceToken: "token",
        ResponseURL: "url",
        StackId: "stackId",
        RequestId: "requestId",
        LogicalResourceId: "logicalResourceId",
        ResourceType: "resourceType",
        ResourceProperties: {
            SecretId: "secretId",
            ServiceToken: "token"
        }
    }

    const API_ENDPOINT = "https://api.example.com"

    test("Should setup a webhook for a telegraf bot", async () => {
        // GIVEN an api URL is set as an environment variable
        process.env.TELEGRAF_API_URL = API_ENDPOINT

        // WHEN the handler is called
        const response = await handler({
            RequestType: "Create",
            ...handlerFields
        })

        // THEN the response is successful
        expect(response.Status).toBe("SUCCESS")

        // AND Telegram was called to set up the API endpoint
        expect(setWebhookMock).toHaveBeenCalledWith(API_ENDPOINT)

        // AND we don't try to delete a previously set webhook
        expect(deleteWebhookMock).not.toHaveBeenCalled()
    })

    test("Should update a webhook for a telegraf bot", async () => {
        // GIVEN an api URL is set as an environment variable
        process.env.TELEGRAF_API_URL = API_ENDPOINT

        // WHEN the handler is called
        const response = await handler({
            RequestType: "Update",
            PhysicalResourceId: "RID",
            OldResourceProperties: {},
            ...handlerFields
        })

        // THEN the response is successful
        expect(response.Status).toBe("SUCCESS")

        // AND Telegram was called to set up the API endpoint
        expect(setWebhookMock).toHaveBeenCalledWith(API_ENDPOINT)

        // AND we delete a previously set webhook
        expect(deleteWebhookMock).toHaveBeenCalled()
    })

    test("Should delete a webhook for a telegraf bot", async () => {
        // GIVEN an api URL is set as an environment variable
        process.env.TELEGRAF_API_URL = API_ENDPOINT

        // WHEN the handler is called
        const response = await handler({
            RequestType: "Delete",
            PhysicalResourceId: "RID",
            ...handlerFields
        })

        // THEN the response is successful
        expect(response.Status).toBe("SUCCESS")

        // AND Telegram we don't set up an end point anymore
        expect(setWebhookMock).not.toHaveBeenCalled()

        // AND we delete a previously set webhook
        expect(deleteWebhookMock).toHaveBeenCalled()
    })

    test("Should fail if the API endpoint is missing in the environment", async () => {
        // GIVEN an api URL is set as an environment variable

        // WHEN the handler is called
        // THEN an error is thrown
        await expect(() => handler({
            RequestType: "Create",
            ...handlerFields
        })).rejects.toThrow()
    })
})