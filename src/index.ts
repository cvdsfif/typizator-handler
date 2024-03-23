import { ArrayMetadata, FunctionCallDefinition, InferArguments, InferTargetFromSchema, ObjectMetadata, Schema } from "typizator";
import JSONBig from "json-bigint";
import { SecretsManager } from "@aws-sdk/client-secrets-manager";
import { Client } from "pg";
import { HandlerEvent, HandlerResponse } from "./handler-objects";
import { DatabaseConnection, connectDatabase } from "./database-connection";

export const PING = "@@ping";

export const describeJsonSchema = (schema: Schema<any, any, any>) => {
    return schema.metadata.dataType === "object" ?
        `{${(schema.metadata as ObjectMetadata).fields.map(
            (key, value): string => `"${key}":${describeJsonSchema(value)}`
        )}}`
        :
        schema.metadata.dataType === "array" ?
            `"${(schema.metadata as ArrayMetadata).elements.metadata.dataType}[]"` :
            `"${schema.metadata.dataType}"`;
}

export const describeJsonFunction = (definition: FunctionCallDefinition) =>
    `{"args":[${definition.args.map(arg => describeJsonSchema(arg!)).join(",")
    }],"retVal":${definition.retVal ? describeJsonSchema(definition.retVal) : `"void"`
    }}`;

/**
 * Properties passed to a connected AWS lambda handler
 */
export type HandlerProps = {
    /**
     * If the handler is connected to a database, this is the handler facade allowing to execute queries on that database
     */
    db?: DatabaseConnection
}

const callImplementation = async <T extends FunctionCallDefinition>(
    eventBody: string,
    definition: T,
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    props: HandlerProps):
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
    return JSONBig.stringify(await implementation(props, ...args as any));
}

/**
 * Types of connected resources. For now only DATABASE is supported
 */
export enum ConnectedResources { DATABASE = "DATABASE" }

const defaultHandler = <T extends FunctionCallDefinition>(
    definition: T,
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    connectedResources: ConnectedResources[],
    setupProps: () => Promise<HandlerProps>,
    teardownProps: (props: HandlerProps) => Promise<void>,
    errorHandler?: (error: any, props: HandlerProps) => Promise<void>):
    ((event: HandlerEvent) => Promise<HandlerResponse>) => {
    const fn = async (event: HandlerEvent) => {
        if (event.body === PING) return { data: describeJsonFunction(definition) }
        let props = {} as HandlerProps
        try {
            props = await setupProps()
            const callResult = await callImplementation(event.body, definition, implementation, props)
            return ({ data: callResult })
        } catch (e: any) {
            if (errorHandler) await errorHandler(e, props)
            else {
                console.error(`Error caught: ${e.message ?? e}`);
                console.error(e.stack);
            }
            return JSONBig.stringify({
                errorMessage: `Handler error: ${e.message ?? e}`
            })
        } finally {
            await teardownProps(props)
        }
    }
    fn.connectedResources = connectedResources
    return fn
}

/**
 * Connects a Lambda handler for an API method, without server resources connected
 * @param definition Method defined in an `apiS` schema
 * @param implementation Function implementing the API method. Its parameters and return types must be those of the `definition`
 * @param errorHandler Optional function that will be called if any error is thrown in the handler's implementation before the normal error treatment
 * @returns Lambda handler checking and converting the JSON parameters passed in a lambda call and calling the implementation function passed as `implementation`
 */
export const handlerImpl = <T extends FunctionCallDefinition>(
    definition: T,
    implementation: (...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    errorHandler?: (error: any, props: HandlerProps) => Promise<void>):
    ((event: HandlerEvent,) => Promise<HandlerResponse>) =>
    defaultHandler(
        definition,
        async (_: HandlerProps, ...args: InferArguments<T["args"]>) => await implementation(...args),
        [],
        async () => ({}),
        async (_: HandlerProps) => { },
        errorHandler
    )

/**
 * Creates a database connection using the `pg` library from the environment variables.
 * - ENDPOINT_ADDRESS is the URI pointing to the database that we have to connect
 * - DB_NAME is the name of the database to connect to
 * - DB_SECRET_ARN is the identifier of the AWS Secret containing the password needed to access the database
 * @returns Database connection, as defined in the `pg` library
 */
export const connectPostgresDb = async () => {
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

/**
 * Connects a Lambda handler for an API method, without server resources connected
 * @param definition Method defined in an `apiS` schema
 * @param implementation Function implementing the API method. Its parameters and return types must be those of the `definition`
 * @param errorHandler Optional function that will be called if any error is thrown in the handler's implementation before the normal error treatment
 * @returns Lambda handler checking and converting the JSON parameters passed in a lambda call and calling the implementation function passed as `implementation`
 */
export const connectedHandlerImpl = <T extends FunctionCallDefinition>(
    definition: T,
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    errorHandler?: (error: any, props: HandlerProps) => Promise<void>):
    (event: HandlerEvent) => Promise<HandlerResponse> =>
    defaultHandler(
        definition,
        implementation,
        [ConnectedResources.DATABASE],
        async () => {
            const client = await connectPostgresDb()
            return ({ db: connectDatabase(client) })
        },
        async (props: HandlerProps) => await props.db?.client.end(),
        errorHandler)

export { HandlerEvent, HandlerResponse } from "./handler-objects";
export * from "./database-connection";