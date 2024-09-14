import { DatabaseConnection } from "../../database-connection";
import { MigrationProcessor, MigrationResultFailure, MigrationResultSuccess } from "./postgres-migration-handler";
import { boolS, dateS, intS, objectS, stringS } from "typizator";
import { generateCreateStatement } from "./generate-create-statement";
import { MigrationList } from "../migration-list";

/**
 * Schema for the migration log data
 */
export const databaseMigrationSchema = objectS({
    /**
     * Ordinal number of the migration step. In the list, those numbers can be non-consecutive, but must be placed in a growing order
     */
    creationOrder: intS.notNull,
    /**
     * Human-readable description of the migration step
     */
    description: stringS.notNull,
    /**
     * Timestamp when the migration step was executed on the database
     */
    runTs: dateS.notNull,
    /**
     * Query executed during the migration step
     */
    queryExecuted: stringS.notNull,
    /**
     * True if the step was successful, false otherwise (error in the SQL query for example)
     */
    successful: boolS.notNull,
    /**
     * Optional error message
     */
    message: stringS.notNull
})

/**
 * Properties of the migration
 */
export type MigrationProps = {
    /**
     * Name of the table holding the migration log
     */
    migrationTableName?: string,
    /**
     * If true (by default), the migration process must be immutable, i.e. migration queries successfuly executed and recorded cannot change in the future, if you try to change them, the migration process fails.
     */
    allowMigrationContentsChanges?: boolean
}

/**
 * Postgres implementation of the migration processor.
 * 
 * @see `MigrationProcessor` for documentation
 */
export class PostgresListMigrationProcessor implements MigrationProcessor {
    static DEFAULT_MIGRATION_TABLE_NAME = "migration_log";
    private _migrationTableName;
    private allowMigrationContentsChange;

    constructor(
        private migrationList: MigrationList,
        props?: MigrationProps
    ) {
        this._migrationTableName =
            props?.migrationTableName ??
            PostgresListMigrationProcessor.DEFAULT_MIGRATION_TABLE_NAME
        this.allowMigrationContentsChange = props?.allowMigrationContentsChanges ?? false
    }

    get migrationTableName() { return this._migrationTableName };

    initialize = async (db: DatabaseConnection) => {
        const statement = generateCreateStatement(
            databaseMigrationSchema,
            this._migrationTableName,
            ["creationOrder"]
        )
        await db.query(statement)
    }
    migrate = async (db: DatabaseConnection) => {
        let lastSuccessful = -1
        const actualMigrations = await db.select(
            databaseMigrationSchema,
            `${this._migrationTableName} ORDER BY creation_order`
        )
        actualMigrations.forEach(migration => {
            if (!migration.successful) return;
            const existingMigration = this.migrationList.find(actualMigration => actualMigration.order === migration.creationOrder)
            if (!existingMigration)
                throw new Error(
                    `The migration list must be immutable. The successful migration number ${migration.creationOrder
                    } not found in your list. The original query was "${migration.queryExecuted
                    }, executed on ${migration.runTs}"`);
            if (existingMigration.query !== migration.queryExecuted) {
                const errorMessage = `The migration list must be immutable. The successful migration number ${migration.creationOrder
                    } the query text modified. The original query was "${migration.queryExecuted
                    }, executed on ${migration.runTs}"`
                if (!this.allowMigrationContentsChange) throw new Error(errorMessage);
                console.warn(errorMessage);
            }

            lastSuccessful = migration.creationOrder;
        });
        db.query(`DELETE FROM ${this._migrationTableName} WHERE successful = false`)
        const newMigrationsList = this.migrationList.filter(migration => migration.order > lastSuccessful)

        let hasError = false
        let errorMessage = ""
        for (const migration of newMigrationsList) {
            try {
                await db.query(migration.query)
                await db.multiInsert(
                    databaseMigrationSchema,
                    this._migrationTableName,
                    [{
                        creationOrder: migration.order,
                        description: migration.description,
                        queryExecuted: migration.query,
                        successful: true,
                        message: ""
                    }],
                    {
                        runTs: { action: "NOW" }
                    }
                )
                lastSuccessful = migration.order
            } catch (e: any) {
                hasError = true
                errorMessage = e.message
                await db.multiInsert(
                    databaseMigrationSchema,
                    this._migrationTableName,
                    [{
                        creationOrder: migration.order,
                        description: migration.description,
                        queryExecuted: migration.query,
                        successful: false,
                        message: errorMessage
                    }],
                    {
                        runTs: { action: "NOW" }
                    }
                )
                break
            }
        }
        if (hasError)
            return ({
                successful: false,
                lastSuccessful,
                errorMessage
            }) as MigrationResultFailure
        return ({
            successful: true,
            lastSuccessful
        }) as MigrationResultSuccess
    }
}