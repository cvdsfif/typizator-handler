import { ArrayMetadata, FunctionCallDefinition, InferArguments, InferTargetFromSchema, ObjectMetadata, Schema } from "typizator";
import JSONBig from "json-bigint";
import { SecretsManager } from "@aws-sdk/client-secrets-manager";
import { Client } from "pg";
import { HandlerEvent, HandlerResponse } from "./handler-objects";
import { DatabaseConnection, connectDatabase } from "./database-connection";

export const PING = "@@ping";

export const describeJsonSchema = (schema: Schema<any, any, any>) => {
    return schema.metadata.dataType === "object" ?
        `{${Array.from((schema.metadata as ObjectMetadata).fields).map(
            ([key, value]): string => `"${key}":${describeJsonSchema(value)}`
        )}}` :
        schema.metadata.dataType === "array" ?
            `"${(schema.metadata as ArrayMetadata).elements.metadata.dataType}[]"` :
            `"${schema.metadata.dataType}"`;
}

export const describeJsonFunction = (definition: FunctionCallDefinition) =>
    `{"args":[${definition.args.map(arg => describeJsonSchema(arg!)).join(",")
    }],"retVal":${definition.retVal ? describeJsonSchema(definition.retVal) : `"void"`
    }}`;

export type HandlerProps = {
    db?: DatabaseConnection
}

const callImplementation = async <T extends FunctionCallDefinition>(
    eventBody: string,
    definition: T,
    implementation: (...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>):
    Promise<string> => {
    let args = [];
    if (definition.args.length > 0) {
        const jsonArgs = JSONBig.parse(eventBody);
        if (!Array.isArray(jsonArgs))
            throw new Error(`Call arguments must be an array. Got ${eventBody}.`);
        args = definition.args.map((schema, index) => {
            const receivedArg = jsonArgs[index];
            if (receivedArg === undefined && !schema?.metadata.optional)
                throw new Error(`Argument ${index} is undefined and it should't be`);
            if (receivedArg === null && schema?.metadata.notNull)
                throw new Error(`Argument ${index} is null and it should't be`);
            return definition.args[index]?.unbox(receivedArg)
        })

    }
    return JSONBig.stringify(await implementation(...args as any));
}

export enum ConnectedResources { DATABASE = "DATABASE" }

const defaultHandler = <T extends FunctionCallDefinition>(
    definition: T,
    implementation: (...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    connectedResources: ConnectedResources[]):
    ((event: HandlerEvent) => Promise<HandlerResponse>) => {
    const fn = async (event: HandlerEvent) => {
        if (event.body === PING) return { data: describeJsonFunction(definition) }
        return callImplementation(event.body, definition, implementation)
            .then(retval => ({ data: retval }))
            .catch(e => {
                console.error(`Error caught: ${e.message ?? e}`);
                console.error(e.stack);
                return JSONBig.stringify({
                    errorMessage: `Handler error: ${e.message ?? e}`
                });
            });
    };
    fn.connectedResources = connectedResources;
    return fn;
}

export const handlerImpl = <T extends FunctionCallDefinition>(
    definition: T,
    implementation: (...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>):
    ((event: HandlerEvent) => Promise<HandlerResponse>) =>
    defaultHandler(
        definition,
        async (...args: InferArguments<T["args"]>) => await implementation(...args), []);

const connectPostgresDb = async () => {
    const host = process.env.DB_ENDPOINT_ADDRESS;
    const database = process.env.DB_NAME;
    const dbSecretArn = process.env.DB_SECRET_ARN;
    if (!host || !database || !dbSecretArn)
        throw new Error("Database access not configured, the process environment must contain DB_ENDPOINT_ADDRESS,DB_NAME and DB_SECRET_ARN")
    const secretString =
        (await new SecretsManager()
            .getSecretValue({ SecretId: dbSecretArn }))
            .SecretString;
    if (!secretString)
        throw new Error("Database password not available on AWS secrets");
    const { password } = JSON.parse(secretString);
    const client = new Client({
        user: "postgres",
        host, database, password,
        port: 5432,
        ssl: {
            rejectUnauthorized: false
        }
    });
    await client.connect();
    return client;
}

export const connectedHandlerImpl = <T extends FunctionCallDefinition>(
    definition: T,
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>):
    (event: HandlerEvent) => Promise<HandlerResponse> =>
    defaultHandler(
        definition,
        async (...args: InferArguments<T["args"]>) => {
            const client = await connectPostgresDb();
            try {
                return await implementation({ db: connectDatabase(client) }, ...args)
            } finally {
                await client.end()
            }
        }, [ConnectedResources.DATABASE]);

export { HandlerEvent, HandlerResponse } from "./handler-objects";
export * from "./database-connection";