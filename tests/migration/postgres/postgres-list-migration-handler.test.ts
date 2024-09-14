jest.mock("@aws-sdk/client-secrets-manager", () => ({
    SecretsManager: jest.fn().mockImplementation(() => ({
        getSecretValue: jest.fn().mockImplementation(() => Promise.resolve({
            SecretString: `{ "password": "secret" }`
        }))
    }))
}))

const queryFn = jest.fn()
const endFn = jest.fn()
jest.mock("serverless-postgres", () => jest.fn().mockImplementation((...args: any) => {
    return {
        connect: jest.fn(),
        end: endFn,
        query: queryFn,
        on: jest.fn(),
    }
}))

import { postgresListMigrationHandler } from "../../../src/migration/postgres/postgres-list-migration-handler"
import { CloudFormationCustomResourceEventCommon } from "../../../src/lib/cloud-formation-types"
import { migrationList } from "../../../src/migration/migration-list";
import { extendExpectWithToContainStrings } from "../../util/expect-contain-strings";

describe("Test the migration handlers using migration lists", () => {
    extendExpectWithToContainStrings()
    let envSaved: NodeJS.ProcessEnv

    const dumbEvent = {
        ServiceToken: "ST",
        ResponseURL: "http://",
        StackId: "SID",
        RequestId: "RID",
        LogicalResourceId: "LRID",
        ResourceType: "Custom",
        ResourceProperties: {
            ServiceToken: "STN"
        }
    } satisfies CloudFormationCustomResourceEventCommon

    beforeAll(() => {
        envSaved = process.env
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
    })

    beforeEach(() => queryFn.mockImplementation((request: any) => {
        if (request.text?.includes("SELECT creation_order"))
            return Promise.resolve({
                fields:
                    ["creation_order", "description", "run_ts", "query_executed", "successful", "message"]
                        .map(fieldName => ({ name: fieldName })),
                rows: []
            })
        return Promise.resolve({ fields: [], rows: [] })
    }))

    afterEach(async () => {
        queryFn.mockReset()
        endFn.mockReset()
    })

    afterAll(() => process.env = envSaved)

    test("Should correctly connect the migration handler from the migration list definition", async () => {
        const underTest = postgresListMigrationHandler(
            migrationList()
                .migration({
                    order: 1,
                    query: "SELECT 1",
                    description: "M1"
                })
        )
        await underTest({
            RequestType: "Create",
            ...dumbEvent
        })
        const result = await underTest({
            RequestType: "Update",
            PhysicalResourceId: "PhID",
            OldResourceProperties: {},
            ...dumbEvent
        })
        expect(result.Status).toEqual("SUCCESS")
        expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringMatching(/creation_order/) }))
        expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ values: expect.arrayContaining(["SELECT 1"]) }))
    })

    test("Should correctly accept a different migration table name", async () => {
        const underTest = postgresListMigrationHandler(
            migrationList()
                .migration({
                    order: 1,
                    query: "SELECT 1",
                    description: "M1"
                }),
            { migrationTableName: "another_table" }
        )
        const result = await underTest({
            RequestType: "Create",
            ...dumbEvent
        })
        expect(result.Status).toEqual("SUCCESS")
        expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ values: expect.arrayContaining(["SELECT 1"]) }))
    })
})