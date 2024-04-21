import { ArrayMetadata, FunctionCallDefinition, FunctionMetadata, InferArguments, InferTargetFromSchema, NamedMetadata, ObjectMetadata, Schema, intS } from "typizator";
import JSONBig from "json-bigint";
import { SecretsManager } from "@aws-sdk/client-secrets-manager";
import { Client } from "pg";
import { HandlerEvent, HandlerResponse } from "./handler-objects";
import { DatabaseConnection, connectDatabase } from "./database-connection";
import * as admin from 'firebase-admin'
import { BatchResponse } from "firebase-admin/lib/messaging/messaging-api"

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
    }}`

export type FirebaseAdminConnection = {
    sendMulticastNotification?: (title: string, body: string, tokens: string[]) => Promise<BatchResponse>
}

const MAX_FB_PACKET_SIZE = 100

const uninitializedFirebaseConnection = {
} satisfies FirebaseAdminConnection

const uniqueFirebaseConnection = {
    sendMulticastNotification: async (title: string, body: string, tokens: string[]): Promise<BatchResponse> => {
        const filteredTokens = tokens.filter(token => token.trim() !== "")
        const firebasePromises = [] as Promise<BatchResponse>[]
        for (let i = 0; i < filteredTokens.length; i += MAX_FB_PACKET_SIZE) {
            firebasePromises.push(
                admin.messaging().sendEachForMulticast({
                    notification: { title, body },
                    tokens: filteredTokens.slice(i, i + MAX_FB_PACKET_SIZE)
                }).catch(e => {
                    console.error(`Firebase packet for [${tokens}] rejected: ${e?.message}`)
                    return {
                        successCount: 0,
                        failureCount: tokens.length,
                        responses: []
                    }
                })
            )
        }
        const result = await Promise.all(firebasePromises)
        return result.reduce((accumulator, current) => {
            if (current.failureCount > 0) {
                console.warn(`Failures when sending Firebase messages`)
                current.responses?.forEach(response => {
                    if (response.success) return
                    console.warn(`Failure for message ${response.messageId} : ${response.error?.code}/${response.error?.message}`)
                })
            } else console.log(`Successfully sent ${current.successCount} messages`)
            return ({
                successCount: accumulator.successCount + current.successCount,
                failureCount: accumulator.failureCount + current.failureCount,
                responses: [...accumulator.responses, ...current.responses ?? []]
            })
        }, {
            successCount: 0,
            failureCount: 0,
            responses: []
        })
    }
} satisfies FirebaseAdminConnection

const createFirebaseAdminConnection = async () => {
    const fbSecretArn = process.env.FB_SECRET_ARN
    const databaseURL = process.env.FB_DATABASE_NAME
    if (!fbSecretArn || !databaseURL) {
        console.warn("Firebase secret or database name not specified, connection unavailable")
        return uninitializedFirebaseConnection
    }
    try {
        if (admin.apps?.length > 0) return uniqueFirebaseConnection
        const secretString =
            (await new SecretsManager()
                .getSecretValue({ SecretId: fbSecretArn }))
                .SecretString
        if (!secretString) {
            console.warn("Firebase secret not found, connection unavailable")
            return uninitializedFirebaseConnection
        }
        admin.initializeApp({
            credential: admin.credential.cert(JSON.parse(secretString)),
            databaseURL
        })
        return uniqueFirebaseConnection
    } catch (e: any) {
        console.error(`Error during Firebase initialization: ${e.message}`)
        return uninitializedFirebaseConnection
    }
}

/**
 * Properties passed to a connected AWS lambda handler
 */
export type HandlerProps = {
    /**
     * If the handler is connected to a database, this is the handler facade allowing to execute queries on that database
     */
    db?: DatabaseConnection
    /**
     * If the handler is connected to a Firebase admin channel, this is the object giving access to it
     */
    firebaseAdmin?: FirebaseAdminConnection
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
export enum ConnectedResources { DATABASE = "DATABASE", FIREBASE_ADMIN = "FIREBASE_ADMIN" }

const defaultHandler = <T extends FunctionCallDefinition>(
    definition: T & { metadata: FunctionMetadata },
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    connectedResources: ConnectedResources[],
    setupProps: () => Promise<HandlerProps>,
    teardownProps: (props: HandlerProps) => Promise<void>,
    errorHandler?: (error: any, props: HandlerProps, metadata: NamedMetadata) => Promise<void>,
    authenticator?: (props: HandlerProps, securityToken: string, rights: AccessRights) => Promise<boolean>)

    :

    ((event: HandlerEvent) => Promise<HandlerResponse>) => {

    const fn = async (event: HandlerEvent) => {
        if (event.body === PING) return { data: describeJsonFunction(definition) }
        let props = {} as HandlerProps
        try {
            props = await setupProps()
            const ipVar = process.env.IP_LIST
            if (ipVar) {
                const ipList = JSON.parse(ipVar)
                const clientIp = event.headers?.["x-forwarded-for"]
                if (!ipList.some((address: string) => address === clientIp)) {
                    return {
                        statusCode: 401,
                        body: "Unauthorized",
                        data: ""
                    }
                }
            }
            const securityToken = event.headers?.["x-security-token"]?.trim()
            const accessRights = {
                mask: intS.optional.unbox(process.env.ACCESS_MASK)
            }
            if (authenticator && accessRights.mask !== undefined) {
                if (!securityToken || !(await authenticator(props, securityToken, accessRights)))
                    return {
                        statusCode: 401,
                        body: "Unauthorized",
                        data: ""
                    }
            }
            const callResult = await callImplementation(event.body, definition, implementation, props)
            return ({ data: callResult })
        } catch (e: any) {
            if (errorHandler) await errorHandler(e, props, {
                name: definition.metadata.name,
                path: definition.metadata.path
            })
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
 * @param authenticator Optional function that checks the authentication token sent from the client in the X-Security-Token against the authentication parameters that are passed in the argument and forbids the access to the underlying implementation if the function returns false
 * @returns Lambda handler checking and converting the JSON parameters passed in a lambda call and calling the implementation function passed as `implementation`
 * @deprecated Replaced by a more flexible `lambdaConnector`
 */
export const handlerImpl = <T extends FunctionCallDefinition>(
    definition: T & { metadata: FunctionMetadata },
    implementation: (...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    errorHandler?: (error: any, props: HandlerProps, metadata: NamedMetadata) => Promise<void>,
    authenticator?: (props: HandlerProps, securityToken: string, rights: AccessRights) => Promise<boolean>):
    ((event: HandlerEvent) => Promise<HandlerResponse>) =>
    defaultHandler(
        definition,
        async (_: HandlerProps, ...args: InferArguments<T["args"]>) => await implementation(...args),
        [],
        async () => ({}),
        async (_: HandlerProps) => { },
        errorHandler,
        authenticator
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
 * Access rights provided by the external environment
 */
export type AccessRights = {
    /**
     * Bitmask defining the access rights to the handler
     */
    mask?: number | null
}

/**
 * Connects a Lambda handler for an API method, with server resources connected
 * @param definition Method defined in an `apiS` schema
 * @param implementation Function implementing the API method. Its parameters and return types must be those of the `definition`
 * @param errorHandler Optional function that will be called if any error is thrown in the handler's implementation before the normal error treatment
 * @param authenticator Optional function that checks the authentication token sent from the client in the X-Security-Token against the authentication parameters that are passed in the argument and forbids the access to the underlying implementation if the function returns false
 * @returns Lambda handler checking and converting the JSON parameters passed in a lambda call and calling the implementation function passed as `implementation`
 * @deprecated Replaced by a more flexible `lambdaConnector`
 */
export const connectedHandlerImpl = <T extends FunctionCallDefinition>(
    definition: T & { metadata: FunctionMetadata },
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    errorHandler?: (error: any, props: HandlerProps, metadata: NamedMetadata) => Promise<void>,
    authenticator?: (props: HandlerProps, securityToken: string, rights: AccessRights) => Promise<boolean>):
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
        errorHandler, authenticator)

/**
 * Properties defining what and how will be injected into the lambda handler
 */
export type ConnectorProperties = {
    /**
     * If `true`, the underlying lambda receives in props prarmeter a connection to a database.
     * The database connection is created based on the `pg` library and configured with the following environment variables:
     * - ENDPOINT_ADDRESS is the URI pointing to the database that we have to connect
     * - DB_NAME is the name of the database to connect to
     * - DB_SECRET_ARN is the identifier of the AWS Secret containing the password needed to access the database
     */
    databaseConnected?: boolean,
    /**
     * Optional asynchronous function that will be called if any error is thrown in the handler's implementation before the normal error treatment
     * @param error Error object sent by the function context
     * @param props Handler properties (including an eventual database connection) passed to the handler
     * @param metadata Metadata indicating the context of the function that raised the error
     */
    errorHandler?: (error: any, props: HandlerProps, metadata: NamedMetadata) => Promise<void>,
    /**
     * Optional function that checks the authentication token provided by the client against the access rights set by the lambda's environment
     * @param props Handler properties (including an eventual database connection) passed to the handler
     * @param securityToken Receives the token sent by the client in the x-security-token header
     * @param rights Access rights bitmask set by the lambda's ACCESS_MASK environment variable
     * @returns `true` if the access is authorized, false otherwise
     */
    authenticator?: (props: HandlerProps, securityToken: string, rights: AccessRights) => Promise<boolean>,
    /**
     * If `true`, the underlying lambda receives in props parameter an interface allowing to send push messages to mobile applications.
     * The Firebase connection is configured with the following environment variables:
     * - FB_SECRET_ARN is the identifier of the AWS Secret containing the certificates necessary to access Firebase
     * - FB_DATABASE_NAME is the name of the Firebase database that is configured in the Firebase admin panel
     */
    firebaseAdminConnected?: boolean
}

export const lambdaConnector = <T extends FunctionCallDefinition>(
    definition: T & { metadata: FunctionMetadata },
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    props = { databaseConnected: false } as ConnectorProperties
): (event: HandlerEvent) => Promise<HandlerResponse> => {
    const connectedResources = [] as ConnectedResources[]

    if (props.databaseConnected) {
        connectedResources.push(ConnectedResources.DATABASE)
    }
    if (props.firebaseAdminConnected) {
        connectedResources.push(ConnectedResources.FIREBASE_ADMIN)
    }

    const setupProps = async () => {
        const handlerProps = {} as HandlerProps
        if (props.databaseConnected) {
            const client = await connectPostgresDb()
            handlerProps.db = connectDatabase(client)
        }
        if (props.firebaseAdminConnected) {
            handlerProps.firebaseAdmin = await createFirebaseAdminConnection()
        }
        return handlerProps
    }

    const teardownProps = async (handlerProps: HandlerProps) => {
        if (props.databaseConnected) await handlerProps.db?.client.end()
    }

    return defaultHandler(
        definition,
        implementation,
        connectedResources,
        setupProps,
        teardownProps,
        props.errorHandler,
        props.authenticator
    )
}


export { HandlerEvent, HandlerResponse } from "./handler-objects"
export * from "./database-connection"