import { ArrayMetadata, FunctionCallDefinition, FunctionMetadata, InferArguments, InferTargetFromSchema, NamedMetadata, ObjectMetadata, Schema, intS } from "typizator";
import JSONBig from "json-bigint";
import { SecretsManager } from "@aws-sdk/client-secrets-manager";
import { HandlerEvent, HandlerResponse } from "./handler-objects";
import { DatabaseConnection, connectDatabase } from "./database-connection";
import * as admin from 'firebase-admin'
import { BatchResponse } from "firebase-admin/lib/messaging/messaging-api"
import { Telegraf } from "telegraf"
import ServerlessClient from "serverless-postgres";

export const PING = "@@ping";

/**
 * Describes the data schema in a human-readable JSON-like form.
 * @param schema Schema to describe
 * @returns A string representing the schema detailed data type
 */
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

/**
 * Describes the function schema in a human-readable JSON-like form
 * @param schema Function schema to describe
 * @returns A string representing the detailed data types of the function arguments and return values
 */
export const describeJsonFunction = (definition: FunctionCallDefinition) =>
    `{"args":[${definition.args.map(arg => describeJsonSchema(arg!)).join(",")
    }],"retVal":${definition.retVal ? describeJsonSchema(definition.retVal) : `"void"`
    }}`

/**
 * Connection interface for Firebase provided to the handler
 */
export type FirebaseAdminConnection = {
    /**
     * Sends a push notification through Firebase
     * @param title Notification title
     * @param body Notification body
     * @param tokens Push tokens (to get from the client app) to send the messages to
     * @param link Optional link that will be followed if the end user clicks on the push notification
     * @returns Information about success or failure of sending the messages
     */
    sendMulticastNotification?: (title: string, body: string, tokens: string[], link?: string) => Promise<BatchResponse>
}

const MAX_FB_PACKET_SIZE = 100

const uninitializedFirebaseConnection = {
} satisfies FirebaseAdminConnection

const uniqueFirebaseConnection = {
    sendMulticastNotification: async (title: string, body: string, tokens: string[], link = undefined as string | undefined): Promise<BatchResponse> => {
        const filteredTokens = tokens.filter(token => token.trim() !== "")
        const firebasePromises = [] as Promise<BatchResponse>[]
        for (let i = 0; i < filteredTokens.length; i += MAX_FB_PACKET_SIZE) {
            const tokens = filteredTokens.slice(i, i + MAX_FB_PACKET_SIZE)
            firebasePromises.push(
                admin.messaging().sendEachForMulticast(
                    link ?
                        {
                            notification: { title, body },
                            tokens,
                            data: {
                                meta: "root data",
                                click_action: link
                            },
                            android: {
                                notification: {
                                    title, body,
                                    clickAction: link
                                },
                                data: {
                                    meta: "android data",
                                    click_action: link
                                }
                            }
                        } :
                        {
                            notification: { title, body },
                            tokens
                        }
                ).catch(e => {
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

export type SecretValue = {
    Name?: string,
    SecretBinary?: Uint8Array,
    SecretString?: string,
    CreatedDate?: Date
}

/**
 * Properties passed to a connected AWS lambda handler
 */
export type HandlerProps = {
    /**
     * Full event information, as it is received by the lambda handler
     */
    event?: HandlerEvent,
    /**
     * If the handler is connected to a database, this is the handler facade allowing to execute queries on that database
     */
    db?: DatabaseConnection,
    /**
     * If there is a connected replica database, this is the handler facade allowing to execute queties on that database
     */
    replicaDb?: DatabaseConnection,
    /**
     * If the handler is connected to a Firebase admin channel, this is the object giving access to it
     */
    firebaseAdmin?: FirebaseAdminConnection,
    /**
     * Dictionary of secret values transmitted from AWS to the handler
     */
    secrets?: SecretValue[],
    /**
     * If the handler is connected to a Telegraf bot, this is the bot facade allowing to send messages to that bot
     */
    telegraf?: Telegraf,
    /**
     * If present, the lambda will use the provided object to send headers and cookies to the client
     */
    headersContainer?: HeadersContainer
}

const callImplementation = async <T extends FunctionCallDefinition>(
    eventBody: string,
    definition: T,
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    props: HandlerProps):
    Promise<string> => {
    let args = [] as any[]
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
 * Types of connected resources.
 */
export enum ConnectedResources {
    DATABASE = "DATABASE",
    FIREBASE_ADMIN = "FIREBASE_ADMIN",
    SECRETS = "SECRETS",
    TELEGRAF = "TELEGRAF"
}

const loadSecrets = async () => {
    const listOfSecrets = process.env.SECRETS_LIST
    if (!listOfSecrets)
        throw new Error("Secrets list not specified in the SECRETS_LIST environemnt variable")
    const secrets = listOfSecrets.split(",")
    const retval = [] as SecretValue[]

    const secretsManager = new SecretsManager()
    for (const secret of secrets) {
        retval.push(await secretsManager.getSecretValue({ SecretId: secret }))
    }

    return retval
}

export const createTelegrafConnection = async () => {
    const telegrafArn = process.env.TELEGRAF_SECRET_ARN
    if (!telegrafArn)
        throw new Error("Telegraf secret ARN not specified in the TELEGRAF_SECRET_ARN environment variable")
    const secretString =
        (await new SecretsManager()
            .getSecretValue({ SecretId: telegrafArn }))
            .SecretString
    return new Telegraf(secretString!)
}

/**
 * Internal name making the difference between the database clients created by this connector and the others
 */
export const DB_APP_NAME = "typizator_sl_client"

/**
 * Minimum time for the connection to be idle before recovered by the system
 */
export const MIN_CONNECTION_IDLE_TIME_SEC = 3

/**
 * Allowed number of parallel connections to the database
 */
export const MAX_CONNECTIONS = 24

/**
 * Creates a database connection using the `serverless-postgres` library from the environment variables.
 * - DB_ENDPOINT_ADDRESS (or DB_REPLICA_ENDPOINT_ADDRESS for the replica database) is the URI pointing to the database that we have to connect
 * - DB_NAME is the name of the database to connect to
 * - DB_SECRET_ARN is the identifier of the AWS Secret containing the password needed to access the database
 * @param props Connection's properties. Actually one `useDatabaseReplica` is used
 * @returns Database connection, as defined in the `serverless-postgres` library
 */
export const connectPostgresDb = async (props: ConnectorProperties) => {
    const host = props.replicaInjection === "inject_as_main" ?
        process.env.DB_REPLICA_ENDPOINT_ADDRESS :
        process.env.DB_ENDPOINT_ADDRESS
    const database = process.env.DB_NAME
    const dbSecretArn = process.env.DB_SECRET_ARN
    if (!host || !database || !dbSecretArn)
        throw new Error("Database access not configured, the process environment must contain DB_ENDPOINT_ADDRESS,DB_NAME and DB_SECRET_ARN")
    const secretString =
        (await new SecretsManager()
            .getSecretValue({ SecretId: dbSecretArn }))
            .SecretString
    if (!secretString)
        throw new Error("Database password not available on AWS secrets")
    const { password } = JSON.parse(secretString)
    const client = new ServerlessClient({
        user: "postgres",
        host, database, password,
        port: 5432,
        delayMs: 3000,
        ssl: {
            rejectUnauthorized: false
        },
        application_name: process.env.DB_APP_NAME ?? DB_APP_NAME,
        minConnectionIdleTimeSec: Number(process.env.MIN_CONNECTION_IDLE_TIME_SEC ?? MIN_CONNECTION_IDLE_TIME_SEC),
        maxConnections: Number(process.env.MAX_CONNECTIONS ?? MAX_CONNECTIONS),
        connUtilization: 0.6,
        maxRetries: 5,
        capMs: 2000,
        query_timeout: 600_000_000,
        statement_timeout: 600_000_000,
    })
    await client.connect()
    return client

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
 * Type of database connections injections defined in {@link ConnectorProperties}
 */
export type DatabaseInjectionType = "no_injection" | "inject_as_main"

/**
 * Type of the object containing the headers of the response to send to the client
 */
export type HeadersContainer = {
    /**
     * Headers to send to the client    
     */
    headers: { [key: string]: string | string[] | undefined },
    /**
     * Cookies to send to the client
     */
    cookies?: { [key: string]: string }
}

/**
 * Properties defining what and how will be injected into the lambda handler
 */
export type ConnectorProperties = {
    /**
     * If `true`, the underlying lambda receives in props prarmeter a connection to a database.
     * The database connection is created based on the `serverless-postgres` library and configured with the following environment variables:
     * - DB_ENDPOINT_ADDRESS is the URI pointing to the database that we have to connect
     * - DB_NAME is the name of the database to connect to
     * - DB_SECRET_ARN is the identifier of the AWS Secret containing the password needed to access the database
     */
    databaseConnected?: boolean,
    /**
     * If the value is `inject_as_main` uses `DB_REPLICA_ENDPOINT_ADDRESS` instead of `DB_ENDPOINT_ADDRESS` to connect to the read-only replica of the main database 
     * instead of the main read-write instance
     */
    replicaInjection?: DatabaseInjectionType,
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
    firebaseAdminConnected?: boolean,
    /**
     * If `true`, the `SECRETS_LIST` environment variable contains a comma-separated list of secret arns.
     * Their values are retrieved and transferred to the handler's properties
     */
    secretsUsed?: boolean,
    /**
     * If `true`, the underlying lambda receives in props parameter an interface allowing to send metrics to a telegraf instance.
     * The `TELEGRAF_SECRET_ARN` environment variable contains the arn of the AWS Secret containing the telegraf channel token.
     */
    telegraf?: boolean
}

const fillConnectedResourcesProperties = (props: ConnectorProperties, fn: any) => {
    const connectedResources = [] as ConnectedResources[]
    if (props.databaseConnected) {
        connectedResources.push(ConnectedResources.DATABASE)
    }
    if (props.firebaseAdminConnected) {
        connectedResources.push(ConnectedResources.FIREBASE_ADMIN)
    }
    if (props.secretsUsed) {
        connectedResources.push(ConnectedResources.SECRETS)
    }
    if (props.telegraf) {
        connectedResources.push(ConnectedResources.TELEGRAF)
    }
    fn.connectedResources = connectedResources
}

export const TOKEN_FROM_COOKIE = "FROM_COOKIE"
export const SECURITY_TOKEN_COOKIE_NAME = "security_token"

const isRequestAuthorized = async (connectorProps: ConnectorProperties, event: HandlerEvent, props: HandlerProps) => {
    const ipVar = process.env.IP_LIST
    if (ipVar) {
        const ipList = JSON.parse(ipVar)
        const clientIp = event.headers?.["x-forwarded-for"]
        if (!ipList.some((address: string) => address === clientIp)) {
            return false
        }
    }
    const headerToken = event.headers?.["x-security-token"]?.trim()
    const securityToken = headerToken === TOKEN_FROM_COOKIE ? event?.cookies?.SECURITY_TOKEN_COOKIE_NAME : headerToken

    const accessRights = {
        mask: intS.optional.unbox(process.env.ACCESS_MASK)
    }
    if (connectorProps.authenticator && accessRights.mask !== undefined) {
        if (!securityToken || !(await connectorProps.authenticator(props, securityToken, accessRights)))
            return false
    }
    return true
}

export const lambdaConnector = <T extends FunctionCallDefinition>(
    definition: T & { metadata: FunctionMetadata },
    implementation: (props: HandlerProps, ...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>,
    connectorProps = { databaseConnected: false } as ConnectorProperties
): (event: HandlerEvent) => Promise<HandlerResponse> => {
    if (process.env.CDK_PHASE === "build") {
        const placeholder = (async (event: HandlerEvent) => {
            return ({ data: await callImplementation(event.body, definition, implementation, {}) })
        }) as any
        fillConnectedResourcesProperties(connectorProps, placeholder)
        return placeholder as any
    }

    const setupProps = async () => {
        const handlerProps = {} as HandlerProps
        if (connectorProps.databaseConnected) {
            const client = await connectPostgresDb(connectorProps)
            handlerProps.db = connectDatabase(client)
        }
        if (connectorProps.firebaseAdminConnected) {
            handlerProps.firebaseAdmin = await createFirebaseAdminConnection()
        }
        if (connectorProps.secretsUsed) {
            handlerProps.secrets = await loadSecrets()
        }
        return handlerProps
    }

    let propsStore: HandlerProps | undefined = undefined
    const propsSource = async () => propsStore ?? (propsStore = await setupProps())

    process.on("SIGTERM", async () => {
        console.log("SIGTERM received, shutting down lambda")
        if (connectorProps.databaseConnected) {
            try {
                const props = await propsSource()
                await props.db?.client.clean()
            } catch (e) {
                console.warn("Error cleaning database connection", e)
            }
        }
        process.exit(0)
    })

    const fn = async (event: HandlerEvent) => {
        if (event.body === PING) return { data: describeJsonFunction(definition) }
        const props = await propsSource()
        props.event = event
        try {
            if (!(await isRequestAuthorized(connectorProps, event, props))) {
                return {
                    statusCode: 401,
                    body: "Unauthorized",
                    data: ""
                }
            }

            if (connectorProps.telegraf) props.telegraf = await createTelegrafConnection()
            const retval = ({ data: await callImplementation(event.body, definition, implementation, props) })
            if (props.telegraf) {
                const body = JSON.parse(props.event!.body)
                await props.telegraf.handleUpdate(body)
                return ({ data: "{}" })
            }
            if (props.headersContainer) {
                return {
                    statusCode: 200,
                    headers: props.headersContainer.headers,
                    cookies: props.headersContainer.cookies,
                    data: retval.data
                }
            }
            return retval
        } catch (e: any) {
            if (connectorProps.errorHandler) await connectorProps.errorHandler(e, props, {
                name: definition.metadata.name,
                path: definition.metadata.path
            })
            console.error(`Error caught: ${e.message ?? e}`);
            console.error(e.stack);
            return JSONBig.stringify({
                errorMessage: `Handler error: ${e.message ?? e}`
            })
        }
    }
    fillConnectedResourcesProperties(connectorProps, fn)
    return fn
}


export { HandlerEvent, HandlerResponse } from "./handler-objects"
export * from "./database-connection"
export * from './ts-api-construct'
export * from './migration/postgres/postgres-migration-handler'
export * from './migration/migration-list'
export * from './migration/postgres/postgres-list-migration-processor'
export * from './migration/postgres/postgres-migration-handler'
export * from './migration/postgres/postgres-list-migration-handler'
export * from './migration/postgres/generate-create-statement'
export * from './telegraf-setup-handler'