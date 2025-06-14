import { CustomResource, Duration, RemovalPolicy, StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, CorsPreflightOptions, DomainName, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { BastionHostLinux, ISecurityGroup, InstanceClass, InstanceSize, InstanceType, Peer, Port, SecurityGroup, SubnetType, Vpc, VpcProps } from "aws-cdk-lib/aws-ec2";
import { Architecture, Code, Function, FunctionProps, ILayerVersion, InlineCode, LayerVersion, Runtime } from "aws-cdk-lib/aws-lambda";
import { BundlingOptions, NodejsFunction, NodejsFunctionProps } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, LogGroupProps, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
    AuroraPostgresEngineVersion,
    ClusterInstance,
    Credentials,
    DatabaseCluster,
    DatabaseClusterEngine,
    DatabaseClusterProps,
    DatabaseInstance,
    DatabaseInstanceEngine,
    DatabaseInstanceProps,
    DatabaseInstanceReadReplica,
    PostgresEngineVersion
} from "aws-cdk-lib/aws-rds";
import { Construct } from "constructs";
import { ApiDefinition, ApiMetadata, NamedMetadata } from "typizator";
import { ConnectedResources } from "./";
import { Provider } from "aws-cdk-lib/custom-resources";
import { readFileSync } from "fs";
import { CronOptions, Rule, RuleTargetInput, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { ARecord, HostedZone, IHostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { Certificate, CertificateValidation } from "aws-cdk-lib/aws-certificatemanager";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { AnyPrincipal, CfnAccessKey, Effect, IManagedPolicy, ManagedPolicy, PolicyStatement, User } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, HttpMethods } from "aws-cdk-lib/aws-s3";

const connectedTelegramWebhooks = new Set<string>()

type BucketData = {
    secretArn: string,
    secret: Secret,
}

/**
 * Extended properties for the stack creation.
 * Allow to define the deployment target (production, staging, test...)
 */
export interface ExtendedStackProps extends StackProps {
    /**
     * Deployment target that will be a part of the names of CDK resources created by the stack. Allows to deploy different versions of the stack side-by-side
     */
    deployFor: string
}

/**
 * Special properties defining how the tree node and its child nodes can be accessed
 */
export type AccessProperties = {
    /**
     * Optional list of IP addresses from where it is permitted to access the elements of the subree
     */
    authorizedIps?: string[] & { 0: string }
    /**
     * Optional bitmask that the client's authorization must match to allow the access to the elements of the subtree
     */
    accessMask?: number
}

/**
 * Properties of the lambda function created on the stack
 */
export type LambdaProperties = {
    /**
     * Overrides the default properties of the NodejsFunction created
     * 
     * The actual defaults are, in addition to those defined by CDK:
     * - entry: `{lambdaPath}/{lambdaName}.ts`, where {lambdaPath} defined in `TSApiProperties` and {lambdaName} is the name of the API function implemented converted to _kebab-case_
     * - handler: name of the implemented API function in _camelCase_
     * - description: created automatically from the implemented API function name and environment type (production, staging...)
     * - runtime: as defined by the `DEFAULT_RUNTIME` constant in this module
     * - memorySize: 256M
     * - architecture: as defined by the `DEFAULT_ARCHITECTURE` constant in this module
     * - timeout: 60 seconds
     * - loggroup: default one, created by the construct
     * - layers: default shared layer created by the construct plus eventually the layers defined in the `extraLayers` properties. It is better not to override this default.
     * - bundling: minified with source map. It is better not to override this parameter directly but rather use the `extraBundling` properties
     * - environment: merge of environment variables defined at different levels. Better not to override this directly
     */
    nodejsFunctionProps?: Partial<NodejsFunctionProps>,
    /**
     * Overrides the default properties of the log group
     */
    logGroupProps?: LogGroupProps,
    /**
     * Bundling parameters for esbuild transpiling the Typescript source into Javascript. Use this instead of overriding `bundling` directly to avoid breaking other defaults
     * 
     * The actual defaults are:
     * - minify: true
     * - sourceMap: false
     */
    extraBundling?: Partial<BundlingOptions>,
    /**
     * Lambda layers to add to the stack, in addition to the default one
     */
    extraLayers?: LayerVersion[],
    /**
     * Schedule on which to call the lambda
     */
    schedules?: [{
        /**
         * Cron options defining when to schedule the lambda function call
         */
        cron: CronOptions,
        /**
         * Stringified JSON object to send to the function as an argument
         */
        eventBody?: string
    }],
    telegrafSecret?: Secret
} & AccessProperties

/**
 * Tree allowing to assign a specific set of properties to every lambda present on the API. Matches the structure of the API for the construct, each field corresponding to the function name  contains an instance of `LambdaProperties`
 */
export type LambdaPropertiesTree<T extends ApiDefinition> = {
    [K in keyof T]?:
    T[K] extends ApiDefinition ?
    LambdaPropertiesTree<T[K]> :
    LambdaProperties
} & AccessProperties

const S3_MAX_AGE = 30_000

/**
 * Properties of an S3 bucket created on the stack
 */
export type S3BucketProperties = {
    /**
     * Name of the bucket used as the key for the bucket
     */
    bucketName: string,
    /**
     * If true, anonymous users can access the bucket
     */
    publicAccess?: boolean
}

/**
 * Properties defining how the stack is constructed from the `typizator` API definition
 */
export type TSApiProperties<T extends ApiDefinition> = ExtendedStackProps & {
    /**
     * API name (unique for your AWS account)
     */
    apiName: string,
    /**
     * Human-readable description of the API
     */
    description: string,
    /**
     * Metadata of the `typizator` API holding its structure and defining what lambdas to create to implement the API
     */
    apiMetadata: ApiMetadata<T>,
    /**
     * Path to the lambda implementation files, relative to your project's root
     */
    lambdaPath: string,
    /**
     * CDK properties overriding the defaults, as defined in `NodejsFunctionProps`. If you want to define individual properties for some functions, use `lambdaPropertiesTree`
     */
    lambdaProps?: NodejsFunctionProps,
    /**
     * CDK properties overriding the log group, as defined in `NodejsFunctionProps`
     */
    logGroupProps?: LogGroupProps,
    /**
     * Path to the lambda layer, relative to your project's root
     */
    sharedLayerPath?: string,
    /**
     * List of additional layers to inject into the stack
     */
    extraLayers?: LayerVersion[],
    /**
     * Additional bundling options for all the lambdas
     */
    extraBundling?: Partial<BundlingOptions>,
    /**
     * Tree of optional additional properties that you can define for any function of your API
     */
    lambdaPropertiesTree?: LambdaPropertiesTree<T>,
    /**
     * Packages to _not_ to bundle with the lambdas. Usually those already present on AWS and those you put on your shared layer
     */
    apiExclusions?: string[],
    /**
     * Configures a custom domain name for the HTTP API managed by the construct.
     * It must belong to a zone that you host on Route53
     * 
     * @example
     * ```ts
     * {    // For api.example.org:
     *      hostedZoneName: "example.org",
     *      domainNamePrefix: "api"
     * }
     * ```
     */
    apiDomainData?: {
        /**
         * Domain name that belongs to you 
         */
        hostedZoneName: string,
        /**
         * Domain name prefix.
         */
        domainNamePrefix: string,
        /**
         * This can be used in few very limited cases like advanced testing. Replaces the standard procedure of domain lookup
         * @param scope CDK construct context
         * @param props Properties for the API creation
         * @param customPath If not empty, the path to add to the end of the API HTTP entry point. Used essentially for dependent constructs
         * @returns New hosted zone
         */
        customDomainLookup?: (
            scope: Construct,
            props: TsApiGenericProperties<any>,
            customPath: string) => IHostedZone
    },
    /**
     * If defined, allows the Firebase admin interface connection (used essentially to send notification to mobile devices)
     * by setting the appropriate environment variables that are then used in the `lambdaConnector` to give the API access to that resource
     */
    firebaseAdminConnect?: {
        /**
         * Construct describing the secret to make accessible to lambdas if they need it
         */
        secret: Secret,
        /**
         * Internal Firebase database name. It is provided to you by your Firebase management interface
         */
        internalDatabaseName: string
    },
    /**
     * If defined, lists the secrets to inject into the concerned lambdas
     */
    secrets?: Secret[] & { 0: Secret },
    /**
     * ARN of the Lambda Insights layer to use for all the lambdas. If omitted, no insights layer is configured
     */
    lambdaInsightsArn?: string,
    /**
     * Optional cors configuration for the API, if not defined, the one from the parent or the default one (* / * / * / *) is used
     */
    corsConfiguration?: CorsPreflightOptions | "*",
    /**
     * Optional map of S3 buckets to create on the stack
     */
    s3Buckets?: S3BucketProperties[],
}

/**
 * Properties for lambdas without database connection
 */
export type TSApiPlainProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    /**
     * Discriminator saying that the construct will not create a database connection to share between lambdas
     */
    connectDatabase: false,
    /**
     * Discriminator saying if the created database is an Aurora cluster rather than an RDS instance
     */
    auroraCluster?: false
}

/**
 * Properties for lambdas with database connection
 */
export type TSApiDatabaseProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    /**
     * Discriminator saying that the construct will not create a database connection to share between lambdas
     */
    connectDatabase: true,
    /**
     * Discriminator saying if the created database is an Aurora cluster rather than an RDS instance
     */
    auroraCluster?: boolean,
    /**
     * Name of the lambda function ensuring the database schema creation and its migration after updates
     */
    migrationLambda?: string,
    /**
     * Path to the migrtion lambda. Usually the same as for the other lambdas
     */
    migrationLambdaPath?: string,
    /**
     * Name of the lambda function handling errors and exceptions
     */
    errorHandlerLambda?: string,
    /**
     * Optional properties of the VPC overriding the default CDK props
     */
    vpcProps?: Partial<VpcProps>,
    /**
     * If `true`, creates a read replica of the database on RDS
     */
    readReplica?: boolean,
    /**
     * If defined, creates a Bastion Linux server for manual access to the database through an SSH tunnel
     */
    bastion?: {
        /**
         * List of CIDR IP addresses defining who can access the bastion
         */
        openTo: string[] & { 0: string }
    }
    /**
     * Properties of the database overriding the defaults of the construct and of CDK
     * 
     * The actual construct's defaults are:
     * - engine: Postgres 16, latest minor version
     * - instanceType: t3micro
     * - vpc: created inside the construct
     * - securityGroups: creted inside the construct
     * - credentials: generated and stored in AWS secret ("postgres")
     * - allocatedStorage: 10Gb
     * - maxAllocatedStorage: 50Gb
     */
    dbProps:
    Partial<Omit<DatabaseInstanceProps, "databaseName">> & { databaseName: string } |
    Partial<Omit<DatabaseClusterProps, "databaseName">> & { databaseName: string },
}

export type TsApiRdsProperties<T extends ApiDefinition> = TSApiDatabaseProperties<T> & {
    /**
     * Discriminator saying if the created database is an Aurora cluster rather than an RDS instance
     */
    auroraCluster?: false,
    /**
     * Properties of the database overriding the defaults of the construct and of CDK
     * 
     * The actual construct's defaults are:
     * - engine: Postgres 16, latest minor version
     * - instanceType: t3micro
     * - vpc: created inside the construct
     * - securityGroups: creted inside the construct
     * - credentials: generated and stored in AWS secret ("postgres")
     * - allocatedStorage: 10Gb
     * - maxAllocatedStorage: 50Gb
     */
    dbProps: Partial<Omit<DatabaseInstanceProps, "databaseName">> & { databaseName: string },
}

export type TsApiAuroraProperties<T extends ApiDefinition> = TSApiDatabaseProperties<T> & {
    /**
     * Discriminator saying if the created database is an Aurora cluster rather than an RDS instance
     */
    auroraCluster: true,
    /**
     * Properties of the database overriding the defaults of the construct and of CDK
     * 
     * The actual construct's defaults are:
     * - engine: Postgres 16, latest minor version
     * - instanceType: t3micro
     * - vpc: created inside the construct
     * - securityGroups: creted inside the construct
     * - credentials: generated and stored in AWS secret ("postgres")
     * - allocatedStorage: 10Gb
     * - maxAllocatedStorage: 50Gb
     */
    dbProps: Partial<Omit<DatabaseClusterProps, "databaseName">> & { databaseName: string },
}

export const isAuroraCluster = <T extends ApiDefinition>(
    props: TSApiDatabaseProperties<T>
): props is TsApiAuroraProperties<T> => props.auroraCluster ?? false

/**
 * All the possible combinations of TsApi properties
 */
export type TsApiGenericProperties<T extends ApiDefinition> =
    TSApiPlainProperties<T> | TSApiDatabaseProperties<T>

/**
 * Creates a test mock of the hosted zone lookup
 * @param scope CDK construct scope. `this` from the stack for example
 * @param _ Not used in the mock implementation 
 * @param _1  Not used in the mock implementation
 * @returns Hosted zone that can be used in the test synthesis
 */
export const customDomainLookupMock = <T extends ApiDefinition>(
    scope: Construct,
    _: TsApiGenericProperties<T>,
    _1: string) => HostedZone
        .fromHostedZoneAttributes(scope, "R53Domain",
            { hostedZoneId: "ID", zoneName: "test.com" })

const camelToKebab = (src: string | String) => src.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
const kebabToCamel = (src: string | String) => src.replace(/(?:_|-| |\b)(\w)/g, (_, p1) => p1.toUpperCase())

const DEFAULT_SEARCH_DEPTH = 8

const requireHereAndUp: any = (path: string, level = 0) => {
    try {
        return require(path)
    } catch (e) {
        if (level > DEFAULT_SEARCH_DEPTH) throw new Error(`Handler not found, searching up to ${path}`)
        return requireHereAndUp(`../${path}`, level + 1)
    }
}

/**
 * Tree matching the API tree containing CDK lambda functions definitions once the stack is created
 */
export type ApiLambdas<T extends ApiDefinition> = {
    [K in keyof T]: T[K] extends ApiDefinition ? ApiLambdas<T[K]> : NodejsFunction
}

/**
 * Default architecture for the lambdas created
 */
export const DEFAULT_ARCHITECTURE = Architecture.ARM_64
/**
 * Default NodeJS runtime for the lambdas created
 */
export const DEFAULT_RUNTIME = Runtime.NODEJS_22_X;

const lookupHostedZone = <T extends ApiDefinition>(
    scope: Construct,
    props: TsApiGenericProperties<T>,
    customPath: string) =>
    HostedZone.fromLookup(scope, `parent-zone-${props.apiName}-${customPath}${props.deployFor}`, {
        domainName: props.apiDomainData!.hostedZoneName
    })


const createHttpApi = <T extends ApiDefinition>(
    scope: Construct,
    props: TsApiGenericProperties<T> | InnerDependentApiProperties<T>,
    customPath = ""
) => {
    if (!props.apiDomainData) {
        const api = new HttpApi(scope, `ProxyCorsHttpApi-${props.apiName}-${customPath}${props.deployFor}`, {
            corsPreflight: !props.corsConfiguration || props.corsConfiguration === "*" ?
                { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] } : props.corsConfiguration,
        })
        return ({
            api,
            domainName: api.url
        })
    }
    const hostedZone = props.apiDomainData.customDomainLookup ?
        props.apiDomainData.customDomainLookup(scope, props, customPath) :
        lookupHostedZone(scope, props, customPath)
    const domainName = `${props.apiDomainData.domainNamePrefix}.${props.apiDomainData.hostedZoneName}`
    const certificate = new Certificate(scope, `api-certificate-${props.apiName}-${customPath}${props.deployFor}`, {
        domainName,
        validation: CertificateValidation.fromDns(hostedZone)
    })
    const domain = new DomainName(scope, `domain-${props.apiName}-${customPath}${props.deployFor}`, {
        domainName, certificate
    })
    const api = new HttpApi(scope, `ProxyCorsHttpApi-${props.apiName}-${customPath}${props.deployFor}`, {
        corsPreflight: !props.corsConfiguration || props.corsConfiguration === "*" ?
            { allowMethods: [CorsHttpMethod.ANY], allowOrigins: ['*'], allowHeaders: ['*'] } : props.corsConfiguration,
        defaultDomainMapping: {
            domainName: domain
        }
    })
    const arecord = new ARecord(scope, `arecord-${props.apiName}-${customPath}${props.deployFor}`, {
        recordName: props.apiDomainData.domainNamePrefix,
        zone: hostedZone,
        target: RecordTarget.fromAlias(
            new ApiGatewayv2DomainProperties(
                domain.regionalDomainName,
                domain.regionalHostedZoneId
            )
        )
    })
    return {
        api,
        domainName: `https://${arecord.domainName}`
    }
}

const addDatabaseProperties =
    <R extends ApiDefinition>(
        {
            props, lambdaProps, vpc, database, lambdaSG, specificLambdaProperties,
            databaseReadReplica
        }: {
            props: TsApiRdsProperties<R> | TsApiAuroraProperties<R> | InnerDependentApiProperties<R>,
            lambdaProps: NodejsFunctionProps,
            vpc: Vpc,
            database: DatabaseInstance | DatabaseCluster,
            lambdaSG: ISecurityGroup,
            specificLambdaProperties?: NodejsFunctionProps,
            databaseReadReplica?: DatabaseInstanceReadReplica
        }
    ) => {

        return {
            ...lambdaProps,
            ...specificLambdaProperties,
            vpc,
            securityGroups: [lambdaSG],

            environment: {
                ...lambdaProps.environment,
                ...specificLambdaProperties?.environment,
                DB_ENDPOINT_ADDRESS: props.auroraCluster ?
                    (database as DatabaseCluster).clusterEndpoint.hostname
                    : (database as DatabaseInstance).dbInstanceEndpointAddress,
                DB_NAME: props.dbProps.databaseName,
                DB_SECRET_ARN: database!.secret?.secretFullArn,
                DB_REPLICA_ENDPOINT_ADDRESS: props.auroraCluster ?
                    (database as DatabaseCluster).clusterReadEndpoint.hostname
                    : databaseReadReplica?.dbInstanceEndpointAddress
            },
        } as NodejsFunctionProps;
    }

const connectLambdaToDatabase =
    <R extends ApiDefinition>(
        {
            database, databaseSG, lambda, lambdaSG, props, camelCasePath, auroraCluster
        }: {
            database: DatabaseInstance | DatabaseCluster,
            databaseSG: ISecurityGroup,
            lambda: NodejsFunction,
            lambdaSG: ISecurityGroup,
            props: TSApiDatabaseProperties<R>,
            camelCasePath: string,
            auroraCluster?: boolean
        }

    ) => {
        database.secret?.grantRead(lambda)
        if (auroraCluster)
            database.grantConnect(lambda, "postgres")
        databaseSG!.addIngressRule(
            lambdaSG,
            Port.tcp(props.auroraCluster ?
                (database as DatabaseCluster).clusterEndpoint.port :
                (database as DatabaseInstance).instanceEndpoint.port),
            `Lamda2PG-${camelCasePath}-${props.deployFor}`
        )
    }

const createTelegrafSetupLambda = <R extends ApiDefinition>(
    scope: Construct,
    props: TsApiGenericProperties<R> | InnerDependentApiProperties<R>,
    telegrafSecret: Secret,
    apiUrl: string,
    sharedLayer: LayerVersion,
    key: string,
    filePath: string
) => {
    const camelCasePath = kebabToCamel(filePath.replace("/", "-"))
    const tgSetupSuffix = "-tg-setup"

    const logGroup = new LogGroup(scope, `TSApiLambdaLog-${camelCasePath}${tgSetupSuffix}${props.deployFor}`, {
        removalPolicy: RemovalPolicy.DESTROY,
        retention: RetentionDays.THREE_DAYS,
        ...props.logGroupProps
    })

    let lambdaProperties = {
        code: new InlineCode(`
            const setupHandler = require("typizator-handler")
            exports.handler = setupHandler.telegrafSetupHandler()
        `),
        handler: "index.handler",
        description: `TG setup for ${props.description} - ${apiUrl}/${key as string} (${props.deployFor})`,
        runtime: DEFAULT_RUNTIME,
        memorySize: 128,
        architecture: DEFAULT_ARCHITECTURE,
        timeout: Duration.seconds(30),
        logGroup,
        layers: [sharedLayer, ...(props.extraLayers ?? [])],
        ...props.lambdaProps,
        environment: {
            ...props.lambdaProps?.environment,
            TELEGRAF_SECRET_ARN: telegrafSecret.secretArn,
            TELEGRAF_API_URL: apiUrl
        }
    } as FunctionProps

    const lambda = new Function(
        scope,
        `TSApiLambda-${camelCasePath}${tgSetupSuffix}${props.deployFor}`,
        lambdaProperties
    )

    telegrafSecret.grantRead(lambda)

    const customResourceProvider = new Provider(
        scope, `TelegrafSetupResourceProvider-${camelCasePath}-${props.deployFor}`, {
        onEventHandler: lambda
    })
    const checksum = Buffer.from(apiUrl, "utf-8")
        .reduce((accumulator, sym) => accumulator = (accumulator + BigInt(sym)) % (65536n ** 2n), 0n)
    new CustomResource(
        scope, `TelegrafSetupResource-${props.apiName}-${props.deployFor}`, {
        serviceToken: customResourceProvider.serviceToken,
        resourceType: "Custom::TelegramBotSetup",
        properties: { Checksum: checksum.toString() }
    })

    return lambda
}

const createLambda = <R extends ApiDefinition>(
    {
        scope, props, subPath, sharedLayer, key, filePath, specificLambdaProperties, vpc,
        database, databaseReadReplica, databaseSG, lambdaSG, insightsLayer, insightsLayerPolicy, bucketVars
    }: {
        scope: Construct,
        props: TsApiGenericProperties<R> | InnerDependentApiProperties<R>,
        subPath: string,
        sharedLayer: LayerVersion,
        key: string,
        filePath: string,
        specificLambdaProperties?: LambdaProperties,
        vpc?: Vpc,
        database?: DatabaseInstance | DatabaseCluster,
        databaseReadReplica?: DatabaseInstanceReadReplica,
        databaseSG?: ISecurityGroup,
        lambdaSG?: ISecurityGroup,
        insightsLayer?: ILayerVersion,
        insightsLayerPolicy?: IManagedPolicy,
        bucketVars?: Record<string, BucketData>
    }
) => {
    const handler = requireHereAndUp(`${filePath}`)[key]
    const resourcesConnected = handler?.connectedResources
    if (!resourcesConnected) throw new Error(`No appropriate handler connected for ${filePath}`)
    const connectedResourcesArray = Array.from(resourcesConnected)
    if (!props.connectDatabase && connectedResourcesArray.includes(ConnectedResources.DATABASE.toString()))
        throw new Error(`Trying to connect database to a lambda on a non-connected stack in ${filePath}`)

    const connectFirebase = connectedResourcesArray.includes(ConnectedResources.FIREBASE_ADMIN.toString())
    if (!props.firebaseAdminConnect && connectFirebase)
        throw new Error(`Trying to connect firebase admin to a lambda on a non-connected stack in ${filePath}`)

    const connectedSecrets = connectedResourcesArray.includes(ConnectedResources.SECRETS.toString())
    if (!props.secrets && connectedSecrets)
        throw new Error(`Trying to inject secrets on a stack without secrets`);

    const connectedTelegraf = connectedResourcesArray.includes(ConnectedResources.TELEGRAF.toString())
    if (!specificLambdaProperties?.telegrafSecret && connectedTelegraf)
        throw new Error(`Trying to connect telegraf to a lambda on a non-connected stack in ${filePath}`)

    const camelCasePath = kebabToCamel(filePath.replace("/", "-"))

    const logGroup = new LogGroup(scope, `TSApiLambdaLog-${camelCasePath}${props.deployFor}`, {
        removalPolicy: RemovalPolicy.DESTROY,
        retention: RetentionDays.THREE_DAYS,
        ...props.logGroupProps,
        ...specificLambdaProperties?.logGroupProps
    })

    let lambdaProperties = {
        entry: `${filePath}.ts`,
        handler: key as string,
        description: `${props.description} - ${subPath}/${key as string} (${props.deployFor})`,
        runtime: DEFAULT_RUNTIME,
        memorySize: 256,
        architecture: DEFAULT_ARCHITECTURE,
        timeout: Duration.seconds(60),
        logGroup,
        layers: [
            sharedLayer,
            ...(insightsLayer ? [insightsLayer] : []),
            ...(specificLambdaProperties?.extraLayers ?? props.extraLayers ?? [])],
        bundling: {
            minify: true,
            sourceMap: false,
            ...(props.extraBundling),
            ...specificLambdaProperties?.extraBundling
        },
        ...props.lambdaProps,
        ...specificLambdaProperties?.nodejsFunctionProps,
        environment: {
            ...props.lambdaProps?.environment,
            ...specificLambdaProperties?.nodejsFunctionProps?.environment,
            IP_LIST: specificLambdaProperties?.authorizedIps ? JSON.stringify(specificLambdaProperties?.authorizedIps) : undefined,
            ACCESS_MASK: specificLambdaProperties?.accessMask ? JSON.stringify(specificLambdaProperties?.accessMask) : undefined,
            FB_SECRET_ARN: connectFirebase ? props.firebaseAdminConnect?.secret.secretArn : undefined,
            FB_DATABASE_NAME: connectFirebase ? props.firebaseAdminConnect?.internalDatabaseName : undefined,
            SECRETS_LIST: connectedSecrets ? props.secrets!.map(secret => secret.secretArn).join(",") : undefined,
            TELEGRAF_SECRET_ARN: specificLambdaProperties?.telegrafSecret?.secretArn,
            REGION: props.env?.region,
            ...Object.entries(bucketVars ?? {}).reduce((acc, [key, value]: any) => ({ ...acc, [key]: value.secretArn }), {}),
        }
    } as NodejsFunctionProps

    if (props.connectDatabase)
        lambdaProperties = addDatabaseProperties({
            props: props as any,
            lambdaProps: lambdaProperties,
            vpc: vpc!, database: database!, lambdaSG: lambdaSG!,
            specificLambdaProperties: specificLambdaProperties?.nodejsFunctionProps,
            databaseReadReplica
        })

    const lambda = new NodejsFunction(
        scope,
        `TSApiLambda-${camelCasePath}${props.deployFor}`,
        lambdaProperties
    )
    if (insightsLayerPolicy)
        lambda.role?.addManagedPolicy(insightsLayerPolicy)

    lambda.addToRolePolicy(new PolicyStatement({
        actions: ["ses:sendEmail", "ses:sendRawEmail"],
        resources: ["*"],
        effect: Effect.ALLOW
    }))

    Object.values(bucketVars ?? {}).forEach(value => value.secret.grantRead(lambda))

    if (connectFirebase) props.firebaseAdminConnect?.secret.grantRead(lambda)
    if (connectedSecrets) props.secrets?.forEach(secret => secret.grantRead(lambda))
    specificLambdaProperties?.telegrafSecret?.grantRead(lambda)

    if (props.connectDatabase)
        connectLambdaToDatabase({
            database: database!, databaseSG: databaseSG!, lambda,
            lambdaSG: lambdaProperties.securityGroups![0], props, camelCasePath,
            auroraCluster: props.auroraCluster
        })

    if (specificLambdaProperties?.schedules) {
        specificLambdaProperties.schedules.forEach((schedule, idx) => {
            const eventRule = new Rule(scope, `TSApiLambdaSchedule${idx}-${camelCasePath}${props.deployFor}`, {
                schedule: Schedule.cron(schedule.cron)
            })
            eventRule.addTarget(new LambdaFunction(lambda, {
                event: RuleTargetInput.fromObject({ body: schedule.eventBody ?? "{}" })
            }))
        })
    }

    return lambda
}

const connectLambda =
    <R extends ApiDefinition>(
        {
            scope, props, subPath, httpApi, sharedLayer, key, keyKebabCase, specificLambdaProperties,
            vpc, database, databaseReadReplica, databaseSG, lambdaSG, insightsLayer, insightsLayerPolicy,
            isHidden, bucketVars
        }: {
            scope: Construct,
            props: TsApiGenericProperties<R> | InnerDependentApiProperties<R>,
            subPath: string,
            httpApi: HttpApi,
            sharedLayer: LayerVersion,
            key: string,
            keyKebabCase: string,
            specificLambdaProperties: LambdaProperties,
            vpc?: Vpc,
            database?: DatabaseInstance | DatabaseCluster,
            databaseReadReplica?: DatabaseInstanceReadReplica,
            databaseSG?: ISecurityGroup,
            lambdaSG?: ISecurityGroup,
            insightsLayer?: ILayerVersion,
            insightsLayerPolicy?: IManagedPolicy,
            isHidden: boolean,
            bucketVars?: Record<string, BucketData>
        }
    ) => {
        const filePath = `${props.lambdaPath}${subPath}/${keyKebabCase}`
        const lambda = createLambda({
            scope,
            props,
            subPath,
            sharedLayer,
            key,
            filePath,
            specificLambdaProperties,
            vpc,
            database, databaseSG, lambdaSG,
            databaseReadReplica,
            insightsLayer, insightsLayerPolicy,
            bucketVars
        })

        if (!isHidden) {
            const lambdaIntegration = new HttpLambdaIntegration(
                `Integration-${props.lambdaPath}-${keyKebabCase}-${subPath.replace("/", "-")}-${props.deployFor}`,
                lambda
            )
            httpApi.addRoutes({
                integration: lambdaIntegration,
                methods: [HttpMethod.POST],
                path: `${subPath}/${keyKebabCase}`
            })
        } else if (specificLambdaProperties.telegrafSecret) {
            throw new Error(`Trying to connect telegraf to a hidden lambda in ${filePath}`)
        }

        if (specificLambdaProperties.telegrafSecret && !connectedTelegramWebhooks.has(specificLambdaProperties.telegrafSecret.secretArn)) {
            createTelegrafSetupLambda(
                scope,
                props,
                specificLambdaProperties.telegrafSecret,
                `${httpApi.url}/${subPath}/${keyKebabCase}`,
                sharedLayer,
                key,
                filePath
            )
            connectedTelegramWebhooks.add(specificLambdaProperties.telegrafSecret.secretArn)
        }

        return lambda
    }

const fillLocalAccessProperties = (
    lambdaPropertiesTree?: AccessProperties,
    accessProperties?: AccessProperties
) => {
    const localAccessProperties = {
        ...accessProperties,
    } satisfies AccessProperties
    if (lambdaPropertiesTree?.accessMask) localAccessProperties.accessMask = lambdaPropertiesTree.accessMask
    if (lambdaPropertiesTree?.authorizedIps) localAccessProperties.authorizedIps = lambdaPropertiesTree.authorizedIps
    return localAccessProperties
}

const createLambdasForApi =
    <R extends ApiDefinition>(
        {
            scope, props, subPath, apiMetadata, httpApi, sharedLayer, lambdaPropertiesTree,
            vpc, database, databaseReadReplica, databaseSG, lambdaSG, insightsLayer, insightsLayerPolicy, bucketVars
        }: {
            scope: Construct,
            props: TsApiGenericProperties<R> | InnerDependentApiProperties<R>,
            subPath: string,
            apiMetadata: ApiMetadata<R>,
            httpApi: HttpApi,
            sharedLayer: LayerVersion,
            lambdaPropertiesTree?: LambdaPropertiesTree<R>,
            vpc?: Vpc,
            database?: DatabaseInstance | DatabaseCluster,
            databaseReadReplica?: DatabaseInstanceReadReplica,
            databaseSG?: ISecurityGroup,
            lambdaSG?: ISecurityGroup,
            insightsLayer?: ILayerVersion,
            insightsLayerPolicy?: IManagedPolicy,
            bucketVars?: Record<string, BucketData>
        }
    ) => {
        const lambdas = {} as ApiLambdas<R>;
        for (const key of Object.keys(apiMetadata.implementation)) {
            const data = (apiMetadata.implementation as any)[key].metadata
            if (props.apiExclusions?.includes((data as NamedMetadata).path)) continue
            const keyKebabCase = camelToKebab(key as string)
            const localAccessProperties = fillLocalAccessProperties(lambdaPropertiesTree, (lambdaPropertiesTree as any)?.[key])
            if (data.dataType === "api")
                (lambdas as any)[key] = createLambdasForApi(
                    {
                        scope,
                        props: props as any,
                        subPath: `${subPath}/${keyKebabCase}`,
                        apiMetadata: data,
                        httpApi,
                        sharedLayer,
                        lambdaPropertiesTree: {
                            ...(lambdaPropertiesTree as any)?.[key],
                            ...localAccessProperties
                        },
                        vpc,
                        database, databaseSG, lambdaSG,
                        databaseReadReplica,
                        insightsLayer, insightsLayerPolicy, bucketVars
                    }
                )
            else
                (lambdas as any)[key] = connectLambda(
                    {
                        scope,
                        props,
                        subPath,
                        httpApi,
                        sharedLayer,
                        key: key as string,
                        keyKebabCase,
                        specificLambdaProperties: {
                            ...(lambdaPropertiesTree as any)?.[key],
                            ...localAccessProperties
                        },
                        vpc,
                        database, databaseReadReplica, databaseSG, lambdaSG,
                        insightsLayer, insightsLayerPolicy,
                        isHidden: data.hidden,
                        bucketVars
                    }
                )
        }
        return lambdas
    }

/**
 * Specific properties for the dependent API
 */
export type DependentApiProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    /**
     * Reference of the parent construct to connect to. The construct must connect the API to a database
     */
    parentConstruct: TSApiConstruct<any>
}

type InnerDependentApiProperties<T extends ApiDefinition> = TSApiProperties<T> & {
    connectDatabase: true,
    auroraCluster: boolean,
    database: DatabaseInstance,
    databaseReadReplica?: DatabaseInstanceReadReplica,
    databaseSG: ISecurityGroup,
    lambdaSG: ISecurityGroup,
    dbProps: {
        databaseName: string
    },
    vpc: Vpc,
    sharedLayer: LayerVersion,
    insightsLayer?: ILayerVersion,
    insightsLayerPolicy?: IManagedPolicy,
    bucketVars?: Record<string, BucketData>
}

const listLambdaArchitectures =
    <T extends ApiDefinition>(initialSet: Set<Architecture>, lambdaPropertiesTree?: LambdaPropertiesTree<T>, depth = 0) => {
        if (!lambdaPropertiesTree || depth++ > DEFAULT_SEARCH_DEPTH) return;
        Object.keys(lambdaPropertiesTree)
            .forEach(key => {
                if ((lambdaPropertiesTree as any)[key]) {
                    if ((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.architecture)
                        initialSet.add((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.architecture)
                    else listLambdaArchitectures(initialSet, (lambdaPropertiesTree as any)[key], depth)
                }
            })
    }

const listLambdaRuntimes =
    <T extends ApiDefinition>(initialSet: Set<Runtime>, lambdaPropertiesTree?: LambdaPropertiesTree<T>, depth = 0) => {
        if (!lambdaPropertiesTree || depth++ > DEFAULT_SEARCH_DEPTH) return;
        Object.keys(lambdaPropertiesTree)
            .forEach(key => {
                if ((lambdaPropertiesTree as any)[key]) {
                    if ((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.runtime)
                        initialSet.add((lambdaPropertiesTree as any)[key]?.nodejsFunctionProps?.runtime)
                    else listLambdaRuntimes(initialSet, (lambdaPropertiesTree as any)[key], depth)
                }
            })
    }

const createSharedLayerForConstruct = <T extends ApiDefinition>(
    scope: Construct,
    apiName: string,
    deployFor: string,
    lambdaPath: string,
    sharedLayerPath?: string,
    lambdaProps?: NodejsFunctionProps,
    lambdaPropertiesTree?: LambdaPropertiesTree<T>
) => {
    const architecturesSet = new Set<Architecture>([DEFAULT_ARCHITECTURE]);
    if (lambdaProps?.architecture) architecturesSet.add(lambdaProps.architecture);
    listLambdaArchitectures(architecturesSet, lambdaPropertiesTree);
    const runtimesSet = new Set<Runtime>([DEFAULT_RUNTIME]);
    if (lambdaProps?.runtime) runtimesSet.add(lambdaProps.runtime);
    listLambdaRuntimes(runtimesSet, lambdaPropertiesTree);
    return new LayerVersion(scope, `SharedLayer-${apiName}-${deployFor}`, {
        code: Code.fromAsset(sharedLayerPath ?? `${lambdaPath}/shared-layer`),
        compatibleArchitectures: [...architecturesSet],
        compatibleRuntimes: [...runtimesSet]
    })
}

/**
 * Dependent construct allowing to host parts of the API on a different HTTP API endpoint and deploy it as a separate stack
 */
export class DependentApiConstruct<T extends ApiDefinition> extends Construct {
    /**
     * Once the stack is created, contains the HTTP API used by its lambda function as an external entry point
     */
    readonly httpApi: HttpApi
    /**
     * URL used to access the API
     */
    readonly apiUrl: string
    /**
     * Tree of lambdas created by this construct
     */
    readonly lambdas: ApiLambdas<T>

    private readonly sharedLayer: LayerVersion

    /**
     * Creates the ready to deploy construct
     * @param scope Parent scope (usually `this` of the holding stack)
     * @param id Stack ID, unique for your AWS account
     * @param props Properties, as defined for `DependentApiProperties`
     */
    constructor(
        scope: Construct,
        id: string,
        props: DependentApiProperties<T>
    ) {
        super(scope, id)

        this.sharedLayer = createSharedLayerForConstruct(
            this,
            props.apiName,
            props.deployFor,
            props.lambdaPath,
            props.sharedLayerPath,
            props.lambdaProps,
            props.lambdaPropertiesTree
        )

        const innerProps = {
            ...props,
            parentConstruct: undefined,
            connectDatabase: true,
            auroraCluster: props.parentConstruct.auroraCluster,
            database: props.parentConstruct.database,
            databaseReadReplica: props.parentConstruct.databaseReadReplica,
            databaseSG: props.parentConstruct.databaseSG,
            lambdaSG: props.parentConstruct.lambdaSG,
            dbProps: {
                databaseName: props.parentConstruct.databaseName
            },
            vpc: props.parentConstruct.vpc,
            sharedLayer: this.sharedLayer,
            insightsLayer: props.parentConstruct.insightsLayer,
            insightsLayerPolicy: props.parentConstruct.insightsLayerPolicy,
            corsConfiguration: props.corsConfiguration ?? props.parentConstruct.corsConfiguration,
            bucketVars: props.parentConstruct.bucketVars
        } as InnerDependentApiProperties<T>
        const apiInfo = createHttpApi(this, innerProps, kebabToCamel(innerProps.apiMetadata.path.replace("/", "-")))
        this.httpApi = apiInfo.api
        this.apiUrl = apiInfo.domainName!

        this.lambdas = createLambdasForApi(
            {
                scope: this,
                props: innerProps,
                subPath: innerProps.apiMetadata.path,
                apiMetadata: innerProps.apiMetadata,
                httpApi: this.httpApi,
                sharedLayer: innerProps.sharedLayer,
                lambdaPropertiesTree: innerProps.lambdaPropertiesTree,
                vpc: innerProps.vpc,
                database: innerProps.database,
                databaseReadReplica: innerProps.databaseReadReplica,
                databaseSG: innerProps.databaseSG,
                lambdaSG: innerProps.lambdaSG,
                insightsLayer: innerProps.insightsLayer,
                insightsLayerPolicy: innerProps.insightsLayerPolicy,
                bucketVars: innerProps.bucketVars
            }
        )
    }
}

/**
 * Creates the main stack implementing your `typizator`-defined API
 */
export class TSApiConstruct<T extends ApiDefinition> extends Construct {
    /**
     * HTTP API enpoint created by the construct
     */
    readonly httpApi: HttpApi
    /**
     * URL used to access the API
     */
    readonly apiUrl: string
    /**
     * Tree of lambdas created by the construct
     */
    readonly lambdas: ApiLambdas<T>
    /**
     * Database instace created by the construct
     */
    readonly database?: DatabaseInstance | DatabaseCluster
    /**
     * Database read replica created by the construct
     */
    readonly databaseReadReplica?: DatabaseInstanceReadReplica
    /**
     * Proxy for Aurora cluster
     */
    //readonly databaseProxy?: DatabaseProxy
    /**
     * Security group attached to the database instance created by the construct
     */
    readonly databaseSG?: SecurityGroup
    /**
     * Security group for the database-connected lambdas created by the construct
     */
    readonly lambdaSG?: SecurityGroup
    /**
     * VPC created by the construct holding its resources
     */
    readonly vpc?: Vpc
    /**
     * Name of the database created
     */
    readonly databaseName?: string
    /**
     * Bastion host resource, if configured
     */
    readonly bastion?: BastionHostLinux
    /**
     * Lambda insights layer imported from a standard region-dependent URL
     */
    readonly insightsLayer?: ILayerVersion
    /**
     * Lambda insights layer policy for the layer above
     */
    readonly insightsLayerPolicy?: IManagedPolicy
    /**
     * Cors configuration for the API, if not defined, the one from the parent or the default one (* / * / * / *) is used
     */
    readonly corsConfiguration?: CorsPreflightOptions | "*"
    /**
     * Whether the database is an Aurora cluster
     */
    readonly auroraCluster: boolean
    /**
     * Bucket variables created by the construct
     */
    readonly bucketVars?: Record<string, BucketData>

    private readonly sharedLayer?: LayerVersion

    /**
     * Creates the construct
     * @param scope Parent scope, usually holging stack
     * @param id ID of the construct, has to be unique for your AWS account
     * @param props Properties, as defining in the corresponding types
     */
    constructor(scope: Construct, id: string, props: TsApiGenericProperties<T>) {
        super(scope, id)

        process.env.CDK_PHASE = "build"

        const apiInfo = createHttpApi(this, props)
        this.httpApi = apiInfo.api
        this.apiUrl = apiInfo.domainName!
        this.corsConfiguration = props.corsConfiguration

        this.sharedLayer = createSharedLayerForConstruct(
            this,
            props.apiName,
            props.deployFor,
            props.lambdaPath,
            props.sharedLayerPath,
            props.lambdaProps,
            props.lambdaPropertiesTree
        )

        if (props.lambdaInsightsArn) {
            this.insightsLayer = LayerVersion.fromLayerVersionArn(this, 'LayerFromArn', props.lambdaInsightsArn);
            this.insightsLayerPolicy = ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLambdaInsightsExecutionRolePolicy')
        }

        const bucketVars = {} as Record<string, BucketData>
        this.bucketVars = bucketVars
        props.s3Buckets?.map(bucketProps => {
            const bucketName = bucketProps.bucketName

            const bucket = new Bucket(scope, `S3Bucket-${props.apiName}-${props.deployFor}-${bucketName}`, {
                bucketName,
                publicReadAccess: false,
                removalPolicy: RemovalPolicy.DESTROY,
                blockPublicAccess: BlockPublicAccess.BLOCK_ACLS_ONLY,
                cors: [
                    {
                        allowedOrigins: ['*'],
                        allowedMethods: [HttpMethods.GET, HttpMethods.HEAD, HttpMethods.POST, HttpMethods.PUT, HttpMethods.DELETE],
                        allowedHeaders: ['*'],
                        maxAge: S3_MAX_AGE,
                    },
                ],
            })

            if (bucketProps.publicAccess) {
                bucket.addToResourcePolicy(
                    new PolicyStatement({
                        effect: Effect.ALLOW,
                        actions: ['s3:GetObject'],
                        resources: [`${bucket.bucketArn}/*`],
                        principals: [new AnyPrincipal()], // Allow public access
                    })
                )
            }

            const bucketUser = new User(scope, `S3Bucket-${props.apiName}-${props.deployFor}-${bucketName}-bucket-user`, {
                userName: `S3Bucket-${props.apiName}-${props.deployFor}-${bucketName}-bucket-user`,
            })

            bucket.addToResourcePolicy(
                new PolicyStatement({
                    effect: Effect.ALLOW,
                    actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject'],
                    resources: [`${bucket.bucketArn}/*`],
                    principals: [bucketUser],
                })
            )

            const accessKey = new CfnAccessKey(scope, `S3Bucket-${props.apiName}-${props.deployFor}-${bucketName}-bucket-user-access-key`, {
                userName: bucketUser.userName,
            })

            const bucketUserSecret = new Secret(scope, `S3Bucket-${props.apiName}-${props.deployFor}-${bucketName}-bucket-user-secret`, {
                secretName: `${props.deployFor}-bucket-user-secret`,
                generateSecretString: {
                    secretStringTemplate: JSON.stringify({
                        accessKeyId: accessKey.ref,
                        secretAccessKey: accessKey.attrSecretAccessKey,
                    }),
                    generateStringKey: 'anyKey'
                },
            })

            bucketVars[`BUCKET_${bucketName.toUpperCase().replace(/-/g, "__").replace(/./g, "_")}_SECRET_ARN`] = {
                secretArn: bucketUserSecret.secretArn,
                secret: bucketUserSecret
            }
        })

        this.auroraCluster = props.auroraCluster ?? false
        if (props.connectDatabase) {
            const vpc = this.vpc = new Vpc(this, `VPC-${props.apiName}-${props.deployFor}`, {
                natGateways: 1,
                ...props.vpcProps
            })
            this.databaseSG = new SecurityGroup(this, `SG-${props.apiName}-${props.deployFor}`, { vpc })
            this.lambdaSG = new SecurityGroup(scope, `TSApiLambdaSG-${props.apiName}-${props.deployFor}`, { vpc })

            if (isAuroraCluster(props)) {
                const identifier = `DB-${props.apiName}-${props.deployFor}`
                this.database = new DatabaseCluster(this, identifier, {
                    defaultDatabaseName: props.dbProps.databaseName,
                    clusterIdentifier: identifier,
                    engine: DatabaseClusterEngine.auroraPostgres({
                        version: AuroraPostgresEngineVersion.VER_16_4
                    }),
                    vpc: this.vpc,
                    enableDataApi: true,
                    securityGroups: [this.databaseSG],
                    credentials: Credentials.fromGeneratedSecret("postgres"),
                    writer: ClusterInstance.serverlessV2(`DBWriter-${props.apiName}-${props.deployFor}`),
                    readers: [ClusterInstance.serverlessV2(`DBReader-${props.apiName}-${props.deployFor}`, { scaleWithWriter: true }),],
                    serverlessV2MinCapacity: 0.5,
                    serverlessV2MaxCapacity: 4,
                    backup: {
                        retention: Duration.days(7),
                        preferredWindow: "04:00-04:30"
                    },
                    cloudwatchLogsRetention: RetentionDays.THREE_DAYS,
                    iamAuthentication: false,
                    preferredMaintenanceWindow: "Sat:23:00-Sat:23:30",
                    ...props.dbProps
                })
            } else {
                this.database = new DatabaseInstance(this, `DB-${props.apiName}-${props.deployFor}`, {
                    engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16 }),
                    instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
                    vpc: this.vpc,
                    securityGroups: [this.databaseSG],
                    credentials: Credentials.fromGeneratedSecret("postgres"),
                    allocatedStorage: 10,
                    maxAllocatedStorage: 50,
                    ...(props.dbProps as any)
                })
                if (props.readReplica) {
                    this.databaseReadReplica = new DatabaseInstanceReadReplica(this, `DBReplica-${props.apiName}-${props.deployFor}`, {
                        sourceDatabaseInstance: this.database,
                        instanceType: InstanceType.of(InstanceClass.T3, InstanceSize.MICRO),
                        vpc: this.vpc,
                        securityGroups: [this.databaseSG],
                        ...(props.dbProps as any)
                    })
                }
            }

            this.databaseName = props.dbProps.databaseName

            if (props.migrationLambda) {
                const keyKebabCase = camelToKebab(props.migrationLambda)
                const subPath = props.migrationLambdaPath ?? "";
                const filePath = `${props.lambdaPath}${subPath}/${keyKebabCase}`
                const handler = requireHereAndUp(filePath)[props.migrationLambda]
                const resourcesConnected = handler?.connectedResources;
                const checksum = readFileSync(`${filePath}.ts`)
                    .reduce((accumulator, sym) => accumulator = (accumulator + BigInt(sym)) % (65536n ** 2n), 0n)

                if (!handler?.isMigrationHandler || !resourcesConnected)
                    throw new Error(`No appropriate migration handler connected for ${filePath}`);

                const migrationLambda = createLambda(
                    {
                        scope: this,
                        props: props as any,
                        subPath,
                        sharedLayer: this.sharedLayer,
                        key: props.migrationLambda,
                        filePath,
                        vpc: this.vpc,
                        database: this.database,
                        databaseReadReplica: this.databaseReadReplica,
                        databaseSG: this.databaseSG,
                        lambdaSG: this.lambdaSG,
                        insightsLayer: this.insightsLayer,
                        insightsLayerPolicy: this.insightsLayerPolicy,
                        bucketVars
                    }
                )
                const customResourceProvider = new Provider(
                    this, `MigrationResourceProvider-${props.apiName}-${props.deployFor}`, {
                    onEventHandler: migrationLambda
                })
                const customResource = new CustomResource(
                    this, `MigrationResource-${props.apiName}-${props.deployFor}`, {
                    serviceToken: customResourceProvider.serviceToken,
                    resourceType: "Custom::PostgresDatabaseMigration",
                    properties: { Checksum: checksum.toString() }
                })
                customResource.node.addDependency(this.database)
            }

            if (props.bastion) {
                this.bastion = new BastionHostLinux(
                    this,
                    `BastionHost-${props.apiName}-${props.deployFor}`, {
                    vpc: this.vpc,
                    instanceType: new InstanceType("t3.nano"),
                    subnetSelection: { subnetType: SubnetType.PUBLIC }
                })
                props.bastion.openTo.forEach(address => this.bastion?.allowSshAccessFrom(Peer.ipv4(address)))
                this.database.connections.allowFrom(
                    this.bastion.connections,
                    props.auroraCluster ?
                        Port.tcp((this.database as DatabaseCluster).clusterEndpoint.port) :
                        Port.tcp((this.database as DatabaseInstance).instanceEndpoint.port),
                    `${props.apiName} API Bastion connection for the RDP database`
                )
            }
        }

        this.lambdas = createLambdasForApi({
            scope: this,
            props, subPath: "",
            apiMetadata: props.apiMetadata,
            httpApi: this.httpApi,
            sharedLayer: this.sharedLayer,
            lambdaPropertiesTree: props.lambdaPropertiesTree,
            vpc: this.vpc, database: this.database, databaseSG: this.databaseSG,
            lambdaSG: this.lambdaSG, databaseReadReplica: this.databaseReadReplica,
            insightsLayer: this.insightsLayer, insightsLayerPolicy: this.insightsLayerPolicy,
            bucketVars
        })
    }
}