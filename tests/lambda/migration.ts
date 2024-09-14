import { migrationList } from "../../src/migration/migration-list";
import { postgresListMigrationHandler } from "../../src/migration/postgres/postgres-list-migration-handler";

export const migration = postgresListMigrationHandler(migrationList())