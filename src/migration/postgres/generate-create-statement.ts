import { ObjectS, Schema, SchemaDefinition } from "typizator";
import { camelToSnake } from "../../database-connection";

/**
 * Flat structure extracting the types from a schema definition to allow overriding SQL data types for the table creation
 */
export type DbMetadata<T extends SchemaDefinition> = {
    [K in keyof T]?: {
        dataType?: string
    }
}

/**
 * Creates a PostgreSQL table CREATE statement from the `typizator` schema
 * @param schema Source schema
 * @param tableName Name of the table to create
 * @param primaryKeys List of primary keys for the table
 * @param metadata Lets override the SQL data types for some of the table's columns matching the schema's fields
 * @returns SQL CREATE statement. Not to be used for migrations because you cannot ensure the immutability of the target table
 */
export const generateCreateStatement = <T extends SchemaDefinition>(
    schema: ObjectS<T>,
    tableName: string,
    primaryKeys = [] as (keyof T)[],
    metadata = {} as DbMetadata<T>
) => `CREATE TABLE IF NOT EXISTS ${tableName}(
        ${generateFieldsList(schema, primaryKeys, metadata)}
        ${generateMultifieldPK(primaryKeys)}
    )`

const generateFieldsList = <T extends SchemaDefinition>(
    schema: ObjectS<T>,
    primaryKeys: (keyof T)[],
    metadata: DbMetadata<T>) =>
    schema.metadata.fields
        .map((key, data) => `${camelToSnake(key)} ${postgresTypeFor(key, data, primaryKeys, metadata)}`)
        .join(",\n")

const postgresTypeFor = <T extends SchemaDefinition>(
    key: string | String,
    data: Schema,
    primaryKeys: (keyof T)[],
    metadata: DbMetadata<T>) => {
    const typesTable = {
        "string": "TEXT",
        "bigint": "DECIMAL",
        "int": "BIGINT",
        "float": "DECIMAL",
        "date": "TIMESTAMPTZ",
        "bool": "BOOLEAN"
    }
    let typeString = (metadata as any)[key as string]?.dataType
    if (!typeString) typeString = (typesTable as any)[data.metadata.dataType as string]
    if (!typeString) throw new Error(`No PostgreSQL type available for the ${data.metadata.dataType} type: ${key} field`)
    return `${typeString
        }${primaryKeys.length == 1 &&
            primaryKeys[0] === key ? " PRIMARY KEY" : ""
        }${data.metadata.notNull ? " NOT NULL" : ""}`
}

const generateMultifieldPK = <T extends SchemaDefinition>(primaryKeys: (keyof T)[]) =>
    primaryKeys.length < 2 ? "" : `,\nPRIMARY KEY(${primaryKeys.map(key => camelToSnake(key as string)).join(",")})\n`

