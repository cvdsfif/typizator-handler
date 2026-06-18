jest.mock("@aws-sdk/client-secrets-manager", () => ({
    SecretsManager: jest.fn().mockImplementation(() => ({
        getSecretValue: jest.fn().mockImplementation(() => Promise.resolve({
            SecretString: `{ "username": "user", "password": "secret" }`
        }))
    }))
}))

const queryFn = jest.fn();
const endFn = jest.fn();
const cacheQuitFn = jest.fn();
const valkeyConstructorFn = jest.fn().mockImplementation(() => ({
    quit: cacheQuitFn
}))

jest.mock("iovalkey", () => ({
    __esModule: true,
    default: valkeyConstructorFn
}))

jest.mock("serverless-postgres", () => jest.fn().mockImplementation((...args: any) => {
    return {
        connect: jest.fn(),
        end: endFn,
        query: queryFn,
        on: jest.fn(),
    }
}))

import { DatabaseConnection } from "../../../src"
import { MigrationResultFailure, MigrationResultSuccess, postgresMigrationHandler, setupHandler } from "../../../src/migration/postgres/postgres-migration-handler"
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

describe("Test the setup handler functionality", () => {
    let setupTestResult: MigrationResultSuccess | MigrationResultFailure
    let envSaved: NodeJS.ProcessEnv
    let throwRequired = false

    const underTest = setupHandler({
        setup: async (db: DatabaseConnection) => {
            if (throwRequired) throw new Error("Test error")
            db.query("Setup")
            return setupTestResult
        },
    } as any)

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

        process.env.CACHE_ENDPOINT_ADDRESS = "cache"
        process.env.CACHE_ENDPOINT_PORT = "6379"
        process.env.CACHE_SECRET_ARN = "arn-cache"
    })

    afterEach(async () => {
        process.env = envSaved
        queryFn.mockReset()
        endFn.mockReset()
        cacheQuitFn.mockReset()
        valkeyConstructorFn.mockClear()
        throwRequired = false
    })

    test("Should handle creation event", async () => {
        setupTestResult = {
            successful: true,
            lastSuccessful: 1
        }
        const result = await underTest({
            RequestType: "Create",
            ...dumbEvent
        })
        expect(result.Status).toEqual("SUCCESS")
        expect(result.Data!.Result).toEqual("Last setup: 1")
        expect(result.PhysicalResourceId).toEqual("custom-RID")
        expect(queryFn).toHaveBeenCalledWith({ text: "Setup", values: [] })
        expect(valkeyConstructorFn).toHaveBeenCalledWith({
            host: "cache",
            port: 6379,
            username: "user",
            password: "secret",
            tls: {},
        })
        expect(cacheQuitFn).toHaveBeenCalled()
        expect(endFn).toHaveBeenCalled()
    })

    test("Should handle update event", async () => {
        setupTestResult = {
            successful: true,
            lastSuccessful: 2
        }
        const result = await underTest({
            RequestType: "Update",
            PhysicalResourceId: "PhID",
            OldResourceProperties: {},
            ...dumbEvent
        })
        expect(result.Status).toEqual("SUCCESS")
        expect(result.Data!.Result).toEqual("Last setup: 2")
        expect(result.PhysicalResourceId).toEqual("PhID")
        expect(queryFn).toHaveBeenCalledWith({ text: "Setup", values: [] })
        expect(cacheQuitFn).toHaveBeenCalled()
        expect(endFn).toHaveBeenCalled()
    })

    test("Should handle deletion event", async () => {
        setupTestResult = {
            successful: true,
            lastSuccessful: 1
        }
        const result = await underTest({
            RequestType: "Delete",
            PhysicalResourceId: "PhID",
            ...dumbEvent
        })
        expect(result.Status).toEqual("SUCCESS")
        expect(result.Data!.Result).toEqual("This is forward-only setup, delete event ignored")
        expect(result.PhysicalResourceId).toEqual("PhID")
        expect(queryFn).not.toHaveBeenCalled()
        expect(endFn).not.toHaveBeenCalled()
        expect(cacheQuitFn).not.toHaveBeenCalled()
        expect(valkeyConstructorFn).not.toHaveBeenCalled()
    })

    test("Should report setup error", async () => {
        setupTestResult = {
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
        expect(result.Data!.Result).toEqual("Setup error: Mistake, last successful: 1")
        expect(cacheQuitFn).toHaveBeenCalled()
        expect(endFn).toHaveBeenCalled()
    })

    test("Should report setup throwing error", async () => {
        throwRequired = true
        setupTestResult = {
            successful: true,
            lastSuccessful: 1
        }
        const result = await underTest({
            RequestType: "Update",
            PhysicalResourceId: "PhID",
            OldResourceProperties: {},
            ...dumbEvent
        })
        expect(result.Status).toEqual("FAILED")
        expect(result.Data!.Result).toEqual("Setup exception: Test error")
        expect(cacheQuitFn).toHaveBeenCalled()
        expect(endFn).toHaveBeenCalled()
    })

    test("Should report setup throwing error on create event", async () => {
        throwRequired = true
        setupTestResult = {
            successful: true,
            lastSuccessful: 1
        }
        const result = await underTest({
            RequestType: "Create",
            ...dumbEvent
        })
        expect(result.Status).toEqual("FAILED")
        expect(result.Data!.Result).toEqual("Setup exception: Test error")
        expect(result.PhysicalResourceId).toEqual("custom-RID")
        expect(cacheQuitFn).toHaveBeenCalled()
        expect(endFn).toHaveBeenCalled()
    })
})