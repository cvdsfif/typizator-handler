import { Client, QueryResult } from "pg";
import { BigintS, DateS, ExtractFromFacade, IntS, ObjectOrFacadeS, Schema, SchemaDefinition, SchemaTarget } from "typizator";
import JSONBig from "json-bigint";

/**
 * What to do if an INSERT encounters a conflict on one of the unique keys
 */
export enum ActionOnConflict {
    /**
     * Replace the old value
     */
    REPLACE,
    /**
     * Replace the old value if it is null
     */
    REPLACE_IF_NULL,
    /**
     * Leave the old value as it is
     */
    IGNORE
}

/**
 * Defines how to manage the upsert query
 */
export type UpsertProps<T extends SchemaDefinition> = {
    /**
     * List of key fields that can be origin of a conflict. Snake case
     */
    upsertFields: (keyof T)[],
    /**
     * What do if a conflict occurs. See the `ActionOnConflict` type
     */
    onConflict: ActionOnConflict
}

/**
 * Possible action on a schema field. The only generally available option is actually omitting it
 */
export type OverrideActions = "OMIT"

/**
 * Possible action on a data field. In addition to the generic override actions, we can request to replace the matching field with the actual timestamp on the server
 */
export type DateOverrideActions = OverrideActions | "NOW"

/**
 * Extracts possible actions for a data field depending on its type
 */
export type SchemaOverrideActions<T extends Schema> =
    ExtractFromFacade<T> extends DateS ? DateOverrideActions :
    OverrideActions

/**
 * Allows to replace a field by any SQL function
 */
export type FunctionActionDefinition = {
    action: "FUNCTION",
    sql: string
}

/**
 * General case of action definition
 */
export type SimpleActionDefinition<T extends Schema> = {
    action: SchemaOverrideActions<T>
} | FunctionActionDefinition

/**
 * Action definition for counters
 */
export type NumberActionDefinition = {
    action: "COUNTER",
    sequenceName: string
}

/**
 * Action definition for a single field, used in `FieldsOverride`
 */
export type ActionDefinition<T extends Schema> =
    ExtractFromFacade<T> extends BigintS | IntS ?
    SimpleActionDefinition<T> | NumberActionDefinition :
    SimpleActionDefinition<T>

/**
 * Defines the list of fields that need a special treatment like omitting them or replacing by the actual timestamp on the database
 */
export type FieldsOverride<T extends SchemaDefinition> = {
    [K in keyof T]?: ActionDefinition<T[K]>
}

/**
 * Extracts the fields that are not overriden by the `FieldsOverride` action
 */
export type RecordsWithExclusions<
    T extends SchemaDefinition,
    S extends SchemaTarget<T>,
    D extends FieldsOverride<T>
> = {
        [K in keyof S as K extends keyof D ? never : K]: S[K]
    }

/**
 * Generic well-typed facade for a database connection
 */
export interface DatabaseConnection {
    /**
     * Client interface. Actually the only possibility is the client interface from the `pg`library
     */
    client: Client,

    /**
     * Simply forwards the query to the connected client
     * @param request SQL query string
     * @param parameters List of parameters, indexed on the base 1, refered in the query string as `$1`, `$2`, etc...
     * @returns Query result, as returned by the underlying library
     */
    query: (request: string, parameters?: any[]) => Promise<QueryResult<any>>,

    /**
     * Execute a database request and returns an array of objects matching the given schema
     * @param schema `typizator` schema defining the data type for each returned row
     * @param query Full SQL query that should return all the fields returned by `schema`. Note that SQL side, the field names are snake case, they are converted to camel case when extracting to Typescript object.
     * @param parameters Query parameters, indexed on the base 1, refered in the query string as `$1`, `$2`, etc...
     * @returns Array of Typescript objects with the fields value converted following the `schema` definition
     */
    typedQuery: <T extends SchemaDefinition>(schema: ObjectOrFacadeS<T>, query: string, parameters?: any[]) => Promise<SchemaTarget<T>[]>,

    /**
     * Creates a `SELECT` query from the schema's field values
     * @param schema `typizator` schema used to select table's fields
     * @param tableAndConditions In the simplest case, just the name of table to select the fields from. Any additional SQL statements going after `FROM <table name>` can be added to it.
     * @param parameters List of parameters, indexed on the base 1, refered in the query string as `$1`, `$2`, etc...
     * @param overrides Fields having special treatment like omitting them from the query...
     * @returns Array of well-typed objects representing the result of the `SELECT` query
     */
    select: <
        T extends SchemaDefinition,
        D extends FieldsOverride<T> = {}
    >(
        schema: ObjectOrFacadeS<T>,
        tableAndConditions: string,
        parameters?: any[],
        overrides?: D
    ) => Promise<SchemaTarget<T>[]>,

    /**
     * Inserts multiple records to a database table in one SQL query.
     * 
     * Note that a maxium of 1000 records can be inserted in one request. Better to do much less. 1000 is a lot in most of the cases.
     * @param schema `typizator` schema describing a single record of the inserted data
     * @param tableName Name of the table for insertions
     * @param records List of records to insert, eventually excluding the fields with default actions defined in `overrides`
     * @param overrides Fields having special treatment like omitting them from the query or replacing a date with the actual server's timestamp
     * @returns Just nothing. It's a fire-and-forget action
     */
    multiInsert: <T extends SchemaDefinition, D extends FieldsOverride<T> = {}>(
        schema: ObjectOrFacadeS<T>,
        tableName: string,
        records: RecordsWithExclusions<T, SchemaTarget<T>, D>[],
        overrides?: D) =>
        Promise<void>,

    /**
     * Proceeds to upsert of multiple records to a database table in one SQL query.
     * Upsert means an insert that can react to key records already existing in a table, then either replace them, only fill nulls or ignore
     * 
     * @param schema `typizator` schema describing a single record of the inserted data
     * @param tableName Name a table for insertions
     * @param records List of records to insert, eventually excluding the fields with default actions defined in `overrides`
     * @param upsertProps Information on how to react on a duplicate record. Contains a list of `upsertFields`, i.e. key fields (camel case)
     * that can create a duplicate conflict. `onConflict` explains what to do in that case: either replace a record or only replace null fields 
     * or totally ignore the new data
     * @param overrides Fields having special treatment like omitting them from the query or replacing a date with the actual server's timestamp
     * @returns  Just nothing. It's a fire-and-forget action
     */
    multiUpsert: <T extends SchemaDefinition, D extends FieldsOverride<T> = {}>(
        schema: ObjectOrFacadeS<T>,
        tableName: string,
        records: RecordsWithExclusions<T, SchemaTarget<T>, D>[],
        upsertProps: UpsertProps<T>,
        overrides?: D) =>
        Promise<void>
}

/**
 * Utility function changing snake case to camel case
 * @param src Source string in snake case: something-like-this
 * @returns String in camel case: somethingLikeThis
 */
export const snakeToCamel = (src: string | String) => src.replace(/([-_][a-z])/ig, ($1) => $1.toUpperCase().replace('-', '').replace('_', ''))

/**
 * Utility function changing camel case to snake case
 * @param src Source string in camel case: somethingLikeThis
 * @returns String in snake case: something-like-this
 */
export const camelToSnake = (src: string | String) => src.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`);

class DatabaseConnectionImpl implements DatabaseConnection {
    constructor(public client: Client) { }

    query = async (request: string, parameters = [] as any[]) =>
        await this.client.query({
            text: request,
            values: parameters
        });

    typedQuery = async <T extends SchemaDefinition>(schema: ObjectOrFacadeS<T>, query: string, parameters = [] as any[]): Promise<SchemaTarget<T>[]> => {
        const res = await this.client.query({
            text: query,
            values: parameters,
            rowMode: 'array'
        });
        const fields = res.fields.map(field => snakeToCamel(field.name));
        schema.metadata.fields.forEach(
            (key, value) => {
                if (!value.metadata.optional && !fields.find(fieldKey => fieldKey === key))
                    throw new Error(`Mandatory ${key} field missing from the request data`);

            }
        );
        return res.rows.map(row => {
            const retval = {} as SchemaTarget<T>;
            fields.forEach((name, idx) => {
                try {
                    (retval as any)[name] = schema.metadata.fields.get(name)?.unbox(row[idx]);
                } catch (e: any) {
                    throw new Error(`Unboxing ${name}: ${e.message}`);
                }
            });
            return retval;
        });
    };

    private fieldsList = <T extends SchemaDefinition, D extends FieldsOverride<T>>(schema: ObjectOrFacadeS<T>, overrides: D) =>
        schema.metadata.fields
            .filter(key => overrides[key as string]?.action !== "OMIT")
            .map(({ key }) => camelToSnake(key))
            .join(",");

    select = async <
        T extends SchemaDefinition,
        D extends FieldsOverride<T>
    >(
        schema: ObjectOrFacadeS<T>,
        tableAndConditions: string,
        parameters = [] as any[],
        overrides = {} as D
    ): Promise<SchemaTarget<T>[]> =>
        this.typedQuery(schema, `SELECT ${this.fieldsList(schema, overrides)} FROM ${tableAndConditions}`, parameters);

    private valuesBlock = <T extends SchemaDefinition, D extends FieldsOverride<T>>
        (schema: ObjectOrFacadeS<T>, idx: number, overrides: D) => {
        let counter = 1;
        const nonOmittedFields = schema.metadata.fields.size -
            Object.keys(overrides).filter(key => overrides[key]).length;
        return `(${schema.metadata.fields
            .filter(key => overrides[key as string]?.action !== "OMIT")
            .map(({ key }) =>
                overrides[key as string]?.action === "NOW" ?
                    "now()" :
                    overrides[key as string]?.action === "COUNTER" ?
                        `(SELECT nextval('${(overrides[key as string] as NumberActionDefinition)?.sequenceName}'))` :
                        overrides[key as string]?.action === "FUNCTION" ?
                            (overrides[key as string] as FunctionActionDefinition)?.sql :
                            `$${idx * nonOmittedFields + (counter++)}`
            )
            .join(",")})`
    }

    private recordsBlock = <T extends SchemaDefinition, D extends FieldsOverride<T>>
        (schema: ObjectOrFacadeS<T>, records: RecordsWithExclusions<T, SchemaTarget<T>, D>[], overrides: D) =>
        records.map((_, idx) => this.valuesBlock(schema, idx, overrides)).join(",");

    private resolveEventualConflicts = <T extends SchemaDefinition, D extends FieldsOverride<T>>
        (records: RecordsWithExclusions<T, SchemaTarget<T>, D>[], upsertProps: UpsertProps<T>) => {
        if (upsertProps.upsertFields.length === 0) return records;
        switch (upsertProps.onConflict) {
            case ActionOnConflict.IGNORE: return records;
            case ActionOnConflict.REPLACE_IF_NULL: {
                const recordsPresent = new Map<string, RecordsWithExclusions<T, SchemaTarget<T>, D>>;
                return records
                    .reverse()
                    .filter(record => {
                        const recordIdentifier = upsertProps.upsertFields.map(field => `${(record as any)[field]}`).join(",");
                        const existingRecord = recordsPresent.get(recordIdentifier);
                        if (existingRecord !== undefined) {
                            Object.keys(existingRecord).forEach(
                                key => (existingRecord as any)[key] = (record as any)[key] ?? (existingRecord as any)[key]
                            );
                            return false;
                        }
                        recordsPresent.set(recordIdentifier, record);
                        return true;
                    })
                    .reverse();
            }
            case ActionOnConflict.REPLACE: {
                const keysPresent = new Set<string>;
                return records
                    .reverse()
                    .filter(record => {
                        const recordIdentifier = upsertProps.upsertFields.map(field => `${(record as any)[field]}`).join(",");
                        if (keysPresent.has(recordIdentifier)) return false;
                        keysPresent.add(recordIdentifier);
                        return true;
                    })
                    .reverse();
            }
        }
    }

    private recordsAsArray = <T extends SchemaDefinition, D extends FieldsOverride<T>>
        (schema: ObjectOrFacadeS<T>, records: RecordsWithExclusions<T, SchemaTarget<T>, D>[], overrides: D) =>
        records
            .map(
                record => schema.metadata.fields
                    .filter(key => !overrides[key as string]?.action)
                    .map(({ key }) => (record as any)[key as string])
            )
            .flat();

    private upsertReplaceByExcluded = <
        T extends SchemaDefinition,
        D extends FieldsOverride<T>
    >(
        schema: ObjectOrFacadeS<T>,
        upsertProps: UpsertProps<T>,
        overrides: D
    ) =>
        schema.metadata.fields
            .filter(field => !upsertProps.upsertFields.includes(field as string) && overrides[field as string]?.action !== "OMIT")
            .map(({ key }) => {
                const snakeCaseField = camelToSnake(key)
                return `${snakeCaseField} = EXCLUDED.${snakeCaseField}`
            }).join(",")

    private upsertCoalesceWithExcluded = <
        T extends SchemaDefinition,
        D extends FieldsOverride<T>
    >(
        schema: ObjectOrFacadeS<T>,
        upsertProps: UpsertProps<T>,
        overrides: D
    ) =>
        schema.metadata.fields
            .filter(field => !upsertProps.upsertFields.includes(field as string) && overrides[field as string]?.action !== "OMIT")
            .map(({ key }) => {
                const snakeCaseField = camelToSnake(key);
                return `${snakeCaseField} = COALESCE(_src.${snakeCaseField},EXCLUDED.${snakeCaseField})`
            }).join(",")

    private upsertSetStatement = <
        T extends SchemaDefinition,
        D extends FieldsOverride<T>
    >(
        schema: ObjectOrFacadeS<T>,
        upsertProps: UpsertProps<T>,
        overrides: D
    ) => {
        switch (upsertProps.onConflict) {
            case ActionOnConflict.REPLACE:
                return `DO UPDATE SET ${this.upsertReplaceByExcluded(schema, upsertProps, overrides)}`
            case ActionOnConflict.REPLACE_IF_NULL:
                return `DO UPDATE SET ${this.upsertCoalesceWithExcluded(schema, upsertProps, overrides)}`
            case ActionOnConflict.IGNORE:
                return `DO NOTHING`
        }
    }

    private upsertStatement = <
        T extends SchemaDefinition,
        D extends FieldsOverride<T>
    >(
        schema: ObjectOrFacadeS<T>,
        upsertProps: UpsertProps<T>,
        overrides: D
    ) =>
        `ON CONFLICT(${upsertProps.upsertFields.map(field => camelToSnake(field as string)).join(",")})
        ${this.upsertSetStatement(schema, upsertProps, overrides)}`

    multiInsert = async <T extends SchemaDefinition, D extends FieldsOverride<T>>(
        schema: ObjectOrFacadeS<T>,
        tableName: string,
        recordsInput: RecordsWithExclusions<T, SchemaTarget<T>, D>[],
        overrides = {} as D,
        upsertProps = { upsertFields: [], onConflict: ActionOnConflict.IGNORE } as UpsertProps<T>):
        Promise<void> => {
        if (recordsInput.length == 0) return;
        const records = this.resolveEventualConflicts(recordsInput, upsertProps);
        const queryText =
            `INSERT INTO ${tableName} AS _src(${this.fieldsList(schema, overrides)}) 
            VALUES ${this.recordsBlock(schema, records, overrides)}
            ${upsertProps.upsertFields.length > 0 ? this.upsertStatement(schema, upsertProps, overrides) : ""}`;
        const recordsAsArray = this.recordsAsArray(schema, records, overrides);
        try {
            await this.client.query({
                text: queryText,
                values: recordsAsArray
            });
        } catch (e: any) {
            console.error(`Error executing insert: ${queryText} with ${JSONBig.stringify(recordsAsArray)}`);
            throw new Error(e);
        }
    }

    multiUpsert = async <T extends SchemaDefinition, D extends FieldsOverride<T>>(
        schema: ObjectOrFacadeS<T>,
        tableName: string,
        records: RecordsWithExclusions<T, SchemaTarget<T>, D>[],
        upsertProps: UpsertProps<T>,
        overrides = {} as D):
        Promise<void> => this.multiInsert(schema, tableName, records, overrides, upsertProps);
};

/**
 * Creates a database connection facade
 * @param client `pg` client connected to a PostgreSQL database
 * @returns facade defined by the `DatabaseConnection` interface
 */
export const connectDatabase = (client: Client) => new DatabaseConnectionImpl(client) as DatabaseConnection;