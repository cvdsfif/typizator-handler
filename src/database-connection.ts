import { Client, QueryResult } from "pg";
import { ObjectS, SchemaDefinition, SchemaTarget } from "typizator";
import JSONBig from "json-bigint";

export enum ActionOnConflict { REPLACE, REPLACE_IF_NULL, IGNORE }
export type UpsertProps<T extends SchemaDefinition> = {
    upsertFields: (keyof T)[],
    onConflict: ActionOnConflict
}

export interface DatabaseConnection {
    client: Client,
    query: (request: string) => Promise<QueryResult<any>>,
    typedQuery: <T extends SchemaDefinition>(schema: ObjectS<T>, query: string, parameters?: any[]) => Promise<SchemaTarget<T>[]>,
    select: <T extends SchemaDefinition>(schema: ObjectS<T>, tableAndConditions: string, parameters?: any[]) => Promise<SchemaTarget<T>[]>,
    multiInsert: <T extends SchemaDefinition>(
        schema: ObjectS<T>,
        tableName: string,
        records: SchemaTarget<T>[]) =>
        Promise<void>,
    multiUpsert: <T extends SchemaDefinition>(
        schema: ObjectS<T>,
        tableName: string,
        records: SchemaTarget<T>[],
        upsertProps: UpsertProps<T>) =>
        Promise<void>
}

const snakeToCamel = (src: string | String) => src.replace(/([-_][a-z])/ig, ($1) => $1.toUpperCase().replace('-', '').replace('_', ''));
const camelToSnake = (src: string | String) => src.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`);
class DatabaseConnectionImpl implements DatabaseConnection {
    constructor(public client: Client) { }

    query = async (request: string) => await this.client.query(request);

    typedQuery = async <T extends SchemaDefinition>(schema: ObjectS<T>, query: string, parameters = [] as any[]): Promise<SchemaTarget<T>[]> => {
        const res = await this.client.query({
            text: query,
            values: parameters,
            rowMode: 'array'
        });
        const fields = res.fields.map(field => snakeToCamel(field.name));
        Array.from(schema.metadata.fields).forEach(
            ([key, value]) => {
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

    private fieldsList = <T extends SchemaDefinition>(schema: ObjectS<T>) =>
        Array.from(schema.metadata.fields).map(([key]) => camelToSnake(key)).join(",");

    select = async <T extends SchemaDefinition>(schema: ObjectS<T>, tableAndConditions: string, parameters = [] as any[]): Promise<SchemaTarget<T>[]> =>
        this.typedQuery(schema, `SELECT ${this.fieldsList(schema)} FROM ${tableAndConditions}`, parameters);

    private valuesBlock = <T extends SchemaDefinition>(schema: ObjectS<T>, records: SchemaTarget<T>, idx: number) =>
        `(${Array.from(schema.metadata.fields).map((_, i) => `$${idx * schema.metadata.fields.size + i + 1}`).join(",")})`;

    private recordsBlock = <T extends SchemaDefinition>(schema: ObjectS<T>, records: SchemaTarget<T>[]) =>
        records.map((record, idx) => this.valuesBlock(schema, record, idx)).join(",");

    private resolveEventualConflicts = <T extends SchemaDefinition>(records: SchemaTarget<T>[], upsertProps: UpsertProps<T>) => {
        if (upsertProps.upsertFields.length === 0) return records;
        switch (upsertProps.onConflict) {
            case ActionOnConflict.IGNORE: return records;
            case ActionOnConflict.REPLACE_IF_NULL: {
                const recordsPresent = new Map<string, SchemaTarget<T>>;
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

    private recordsAsArray = <T extends SchemaDefinition>(schema: ObjectS<T>, records: SchemaTarget<T>[]) =>
        records.map(
            record => Array.from(schema.metadata.fields)
                .map(([key]) => (record as any)[key as string])
        ).flat();

    private upsertSetStatement = <T extends SchemaDefinition>(schema: ObjectS<T>, upsertProps: UpsertProps<T>) =>
        Array.from(schema.metadata.fields)
            .filter(([field]) => !upsertProps.upsertFields.includes(field as string))
            .map(([field]) => {
                const snakeCaseField = camelToSnake(field);
                switch (upsertProps.onConflict) {
                    case ActionOnConflict.REPLACE:
                        return `DO UPDATE SET ${snakeCaseField} = EXCLUDED.${snakeCaseField}`;
                    case ActionOnConflict.REPLACE_IF_NULL:
                        return `DO UPDATE SET ${snakeCaseField} = COALESCE(_src.${snakeCaseField},EXCLUDED.${snakeCaseField})`;
                    case ActionOnConflict.IGNORE:
                        return `DO NOTHING`;
                }
            });

    private upsertStatement = <T extends SchemaDefinition>(schema: ObjectS<T>, upsertProps: UpsertProps<T>) =>
        `ON CONFLICT(${upsertProps.upsertFields.map(field => camelToSnake(field as string)).join(",")})
        ${this.upsertSetStatement(schema, upsertProps)}`

    multiInsert = async <T extends SchemaDefinition>(
        schema: ObjectS<T>,
        tableName: string,
        recordsInput: SchemaTarget<T>[],
        upsertProps = { upsertFields: [], onConflict: ActionOnConflict.IGNORE } as UpsertProps<T>):
        Promise<void> => {
        const records = this.resolveEventualConflicts(recordsInput, upsertProps);
        const queryText =
            `INSERT INTO ${tableName} AS _src(${this.fieldsList(schema)}) 
            VALUES ${this.recordsBlock(schema, records)}
            ${upsertProps.upsertFields.length > 0 ? this.upsertStatement(schema, upsertProps) : ""}`;
        const recordsAsArray = this.recordsAsArray(schema, records);
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

    multiUpsert = async <T extends SchemaDefinition>(
        schema: ObjectS<T>,
        tableName: string,
        records: SchemaTarget<T>[],
        upsertProps: UpsertProps<T>):
        Promise<void> => this.multiInsert(schema, tableName, records, upsertProps);
};

export const connectDatabase = (client: Client) => new DatabaseConnectionImpl(client) as DatabaseConnection;