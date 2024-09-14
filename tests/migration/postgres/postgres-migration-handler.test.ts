jest.mock("@aws-sdk/client-secrets-manager", () => ({
    SecretsManager: jest.fn().mockImplementation(() => ({
        getSecretValue: jest.fn().mockImplementation(() => Promise.resolve({
            SecretString: `{ "password": "secret" }`
        }))
    }))
}))

const queryFn = jest.fn();
const endFn = jest.fn();
jest.mock("serverless-postgres", () => jest.fn().mockImplementation((...args: any) => {
    return {
        connect: jest.fn(),
        end: endFn,
        query: queryFn,
        on: jest.fn(),
    }
}))

import { DatabaseConnection } from "../../../src"
import { MigrationResultFailure, MigrationResultSuccess, postgresMigrationHandler } from "../../../src/migration/postgres/postgres-migration-handler"
import { CloudFormationCustomResourceEventCommon } from "../../../src/lib/cloud-formation-types"

describe("Test the migration handlers functionality", () => {
    let migrationTestResult: MigrationResultSuccess | MigrationResultFailure;
    let envSaved: NodeJS.ProcessEnv;
    let throwRequired = false;
    let throwRequiredOnCreate = false;

    const underTest = postgresMigrationHandler({
        initialize: async (db: DatabaseConnection) => {
            if (throwRequiredOnCreate) throw new Error("Test error")
            db.query("Initialize")
        },
        migrate: async (db: DatabaseConnection) => {
            if (throwRequired) throw new Error("Test error")
            db.query("Migrate")
            return migrationTestResult
        },
        get migrationTableName() { return "" }
    })

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

    beforeEach(async () => {
        envSaved = process.env
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx"
        process.env.DB_NAME = "db"
        process.env.DB_SECRET_ARN = "arn"
    });

    afterEach(async () => {
        process.env = envSaved
        queryFn.mockReset()
        endFn.mockReset()
        throwRequired = false;
        throwRequiredOnCreate = false;
    });

    test("Should handle creation event", async () => {
        migrationTestResult = {
            successful: true,
            lastSuccessful: 1
        }
        const result = await underTest({
            RequestType: "Create",
            ...dumbEvent
        })
        expect(result.Status).toEqual("SUCCESS")
        expect(result.Data!.Result).toEqual("Last migration: 1")
        expect(result.PhysicalResourceId).toEqual("custom-RID")
        expect(queryFn).toHaveBeenCalledWith({ text: "Initialize", values: [] })
        expect(queryFn).toHaveBeenCalledWith({ text: "Migrate", values: [] })
        expect(endFn).toHaveBeenCalled()
    })

    test("Should handle creation event", async () => {
        migrationTestResult = {
            successful: true,
            lastSuccessful: 1
        }
        const result = await underTest({
            RequestType: "Update",
            PhysicalResourceId: "PhID",
            OldResourceProperties: {},
            ...dumbEvent
        })
        expect(result.Status).toEqual("SUCCESS")
        expect(result.Data!.Result).toEqual("Last migration: 1")
        expect(result.PhysicalResourceId).toEqual("PhID")
        expect(queryFn).not.toHaveBeenCalledWith({ text: "Initialize", values: [] })
        expect(queryFn).toHaveBeenCalledWith({ text: "Migrate", values: [] })
    })

    test("Should handle deletion event", async () => {
        migrationTestResult = {
            successful: true,
            lastSuccessful: 1
        }
        const result = await underTest({
            RequestType: "Delete",
            PhysicalResourceId: "PhID",
            ...dumbEvent
        })
        expect(result.Status).toEqual("SUCCESS")
        expect(result.Data!.Result).toEqual("This is forward-only migration, delete event ignored")
        expect(result.PhysicalResourceId).toEqual("PhID")
        expect(queryFn).not.toHaveBeenCalledWith({ text: "Initialize", values: [] })
        expect(queryFn).not.toHaveBeenCalledWith({ text: "Migrate", values: [] })
        expect(endFn).not.toHaveBeenCalled()
    })

    test("Should report migration error", async () => {
        migrationTestResult = {
            successful: false,
            lastSuccessful: 1,
            errorMessage: "Mistake"
        }
        const result = await underTest({
            RequestType: "Update",
            PhysicalResourceId: "PhID",
            OldResourceProperties: {},
            ...dumbEvent
        })
        expect(result.Status).toEqual("FAILED")
        expect(result.Data!.Result).toEqual("Migration error: Mistake, last successful: 1")
        expect(endFn).toHaveBeenCalled()
    })

    test("Should report migration throwing error", async () => {
        throwRequired = true;
        migrationTestResult = {
            successful: false,
            lastSuccessful: 1,
            errorMessage: "Mistake"
        }
        const result = await underTest({
            RequestType: "Update",
            PhysicalResourceId: "PhID",
            OldResourceProperties: {},
            ...dumbEvent
        })
        expect(result.Status).toEqual("FAILED")
        expect(result.Data!.Result).toEqual("Migration exception: Test error")
        expect(endFn).toHaveBeenCalled()
    })

    test("Should report migration throwing error on create event", async () => {
        throwRequiredOnCreate = true;
        migrationTestResult = {
            successful: false,
            lastSuccessful: 1,
            errorMessage: "Mistake"
        }
        const result = await underTest({
            RequestType: "Create",
            ...dumbEvent
        })
        expect(result.Status).toEqual("FAILED")
        expect(result.Data!.Result).toEqual("Migration exception: Test error")
        expect(endFn).toHaveBeenCalled()
    })
})