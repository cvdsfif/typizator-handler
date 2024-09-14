/**
 * Definition of a single migration step
 */
export type Migration = {
    /**
     * Ordinal number of the migration step. This number must grow in the consecutive steps of the migration list
     */
    order: number
    /**
     * Human-readable explanation of what the migration step does
     */
    description: string
    /**
     * Single SQL query to execute at the migration step
     */
    query: string
}

/**
 * Chain of migration steps. Allows to arrange them as a list in the code
 */
export type MigrationList = Migration[] & {
    /**
     * Adds a migration step to the list
     * @param migration Next migration step to add
     * @returns List with the migration added
     */
    migration: (migration: Migration) => MigrationList
}

const internalMigrationList = (migrations: Migration[]) => {
    (migrations as any).migration = (migration: Migration) => {
        if (migration.order <= 0) throw new Error("Migration order number must be greater than zero");
        if (migrations.length > 0 && migration.order <= migrations[migrations.length - 1].order)
            throw new Error(`Migration orders must grow, migration ${migration
                .order} cannot go after migration ${migrations[migrations.length - 1].order}`)

        return internalMigrationList([...migrations, migration])
    }
    return migrations as MigrationList
}

/**
 * Creates an empty list of migration steps
 * @returns List to which you can add migrations in consecutive steps
 * 
 * @example
 * ```ts
 * const migrations = migrationList()
 *      .migration({
 *          order: 1,
 *          description: "Create first table",
 *          query: "CREATE TABLE tab1(id INTEGER)"
 *      })
 *      .migration({
 *          order: 2,
 *          description: "Create second table",
 *          query: "CREATE TABLE tab2(id INTEGER)"
 *      })
 * ```
 */
export const migrationList = () => internalMigrationList([])