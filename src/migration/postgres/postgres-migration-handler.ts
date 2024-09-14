import { DatabaseConnection, connectDatabase } from "../../database-connection"
import { connectPostgresDb, ConnectedResources } from "../..";
import { CdkCustomResourceResponse, CloudFormationCustomResourceEvent } from "../../lib/cloud-formation-types"

/**
 * Successful response of the migration processor
 */
export type MigrationResultSuccess = {
    /**
     * `true` for migration success
     */
    successful: true,
    /**
     * Order number of the last successful migration
     */
    lastSuccessful: number
}

/**
 * Failure response of the migration processor
 */
export type MigrationResultFailure = {
    /**
     * `false` for migration failure
     */
    successful: false,
    /**
     * Last order number that was successful during the migration
     */
    lastSuccessful: number,
    /**
     * Details of the error occured
     */
    errorMessage: string
}

/**
 * Classes implementing this process to database schema creation and migration
 */
export type MigrationProcessor = {
    /**
     * Called the first time the processor is called. Usually creates the migration log table to store the state of the migration
     * @param db Connection to the database to migrate
     */
    initialize: (db: DatabaseConnection) => Promise<void>,
    /**
     * Effectively migrated to the last requested state of the database
     * @param db Connection to the database to migrate
     * @returns Result of the migration
     */
    migrate: (db: DatabaseConnection) => Promise<MigrationResultSuccess | MigrationResultFailure>
    /**
     * Name of the migration log table used.
     */
    get migrationTableName(): string
}

const cdkResponse = (
    status: ("SUCCESS" | "FAILED"),
    result: string,
    physicalResourceId: string,
    event: CloudFormationCustomResourceEvent
): CdkCustomResourceResponse => ({
    Status: status,
    PhysicalResourceId: physicalResourceId,
    Data: { Result: result },
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId
})

export const failureResponse = (
    response: string,
    physicalResourceId: string,
    event: CloudFormationCustomResourceEvent
): CdkCustomResourceResponse => cdkResponse(
    "FAILED",
    response,
    physicalResourceId, event
)

export const successResponse = (
    response: string,
    physicalResourceId: string,
    event: CloudFormationCustomResourceEvent
): CdkCustomResourceResponse => cdkResponse("SUCCESS", response, physicalResourceId, event)

const migrationUpdate = async (
    migrationProcessor: MigrationProcessor,
    db: DatabaseConnection,
    eventResourceId: string,
    event: CloudFormationCustomResourceEvent): Promise<CdkCustomResourceResponse> => {
    const result = await migrationProcessor.migrate(db)
    if (!result.successful)
        return failureResponse(
            `Migration error: ${result.errorMessage}, last successful: ${result.lastSuccessful}`,
            eventResourceId, event
        )
    return successResponse(`Last migration: ${result.lastSuccessful}`, eventResourceId, event)
}
/**
 * 
 * @param migrationProcessor Returns the migration handler that can be connected to the CDK stack as a custom migration service
 * @returns Handler than can be connected to the default entry point to the custom resource lambda
 */
export const postgresMigrationHandler =
    /**
     * Instance of the migration processor to use for the migration
     */
    (migrationProcessor: MigrationProcessor):
        (event: CloudFormationCustomResourceEvent) => Promise<CdkCustomResourceResponse> => {
        const fn = async (event: CloudFormationCustomResourceEvent) => {
            if (event.RequestType === "Delete")
                return successResponse("This is forward-only migration, delete event ignored", event.PhysicalResourceId, event)
            try {
                const client = await connectPostgresDb();
                try {
                    const db = connectDatabase(client);
                    let resourceId: string | null = null;
                    if (event.RequestType === "Create") {
                        await migrationProcessor.initialize(db)
                        resourceId = `custom-${event.RequestId}`
                    } else resourceId = event.PhysicalResourceId;
                    return await migrationUpdate(migrationProcessor, db, resourceId, event)
                } finally {
                    client.end()
                }
            } catch (e: any) {
                return failureResponse(
                    `Migration exception: ${e.message}`,
                    event.RequestType === "Create" ? `custom-${event.RequestId}` : event.PhysicalResourceId,
                    event)
            }
        }
        fn.isMigrationHandler = true
        fn.connectedResources = [ConnectedResources.DATABASE]
        return fn;
    }