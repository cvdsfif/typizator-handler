import { CdkCustomResourceResponse, CloudFormationCustomResourceEvent } from "../../lib/cloud-formation-types";
import { postgresMigrationHandler } from "./postgres-migration-handler";
import { MigrationList } from "../migration-list";
import { MigrationProps, PostgresListMigrationProcessor } from "./postgres-list-migration-processor";

/**
 * Special handler for the CDK custom resource proceeding to the database schema's creation and updates (migrations)
 * @param migrationList List of immutable migration steps definitions
 * @param props Properties of the migration process
 * @returns AWS lambda handler for the custom resource proceeding to migrations
 */
export const postgresListMigrationHandler =
    (migrationList: MigrationList, props?: MigrationProps):
        (event: CloudFormationCustomResourceEvent) => Promise<CdkCustomResourceResponse> =>
        postgresMigrationHandler(new PostgresListMigrationProcessor(migrationList, {
            migrationTableName: props?.migrationTableName ?? PostgresListMigrationProcessor.DEFAULT_MIGRATION_TABLE_NAME,
            allowMigrationContentsChanges: props?.allowMigrationContentsChanges
        }))
