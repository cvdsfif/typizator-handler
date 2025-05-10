# Runtime types and metadata schemas for Typescript 

![Coverage](./badges/coverage.svg) [![npm version](https://badge.fury.io/js/typizator-handler.svg)](https://badge.fury.io/js/typizator-handler) [![Node version](https://img.shields.io/node/v/typizator-handler.svg?style=flat)](https://nodejs.org/)

## Purpose

Well-typed database facade and clean converting of JSON parameters for AWS lambdas and similar applications. Uses a special CDK construct to automate AWS lambdas creation to implement an API interface written in Typescript. Allows to create and incrementally migrate database schemas.

## Installing

```Bash
npm i typizator-handler
```

## Documentation

This library provides AWS lambda handlers to implement API methods defined by [typizator](https://www.npmjs.com/package/typizator) schemas.

> There is a tutorial explaining in details how to use this library and to connect it to the web client [here](https://medium.com/@cvds.eu/typescript-api-implementing-with-aws-cdk-and-using-on-a-web-client-2e3fe55a2f7b?sk=7f56e4bae87f46f4d774220d2f6ea95d). This tutorial is slightly outdated but the library is still compatible with most of the features described. The only thing that changed is that the `cdk-typescript-lib` library is now merged into this one.

### AWS Lambda handlers

Imagine you want to implement on the AWS backend an API that later can be called from the client (or from other backends).

You use `typizator` and you define an API to serve. For example like that:

```ts
const api = apiS({
    helloWorld: {
        args: [stringS.notNull], retVal: stringS.notNull
    }
})
```

`typizator` will translate it to:

```ts
{
    helloWorld: (arg0:string)=>string
}
```

In the microservices logic it's good to implement each function of the interface (actually, we have only one, the `helloWorld`) with a separate lambda function. But we don't want the headache of arguments and return types conversion, it would be good to make it work out of the box. Here is where this library helps. It lets you define a _handler_ like this:

```ts
export const helloWorld = 
    // This is the function from this library
    lambdaConnector(
        // We take the endpoint schema from the API we defined earlier. It ensures type checks and conversions
        api.metadata.implementation.helloWorld
        // This is the name of the implementation function. Typescript will only allow arguments and returned types defined by the endpoint schema
        helloWorldImpl
    )
```

The implementation can be whatever you want, but it has to match the signature defined by the schema (the first argument is not used if you don't have any connected resources):

```ts
const helloWorldImpl = async (_:HandlerProps, arg:string) : Promise<string> => {
    // Your implementation here
}
```

It becomes even more interesting if you want to connect a Postgres database (sitting on AWS RDS for example) and use it from your lambda. You just have to replace your handler by:

```ts
export const helloWorld = 
    // This is the other function from this library
    lambdaConnector(
        // We take the endpoint schema from the API we defined earlier. It ensures type checks and conversions
        api.metadata.implementation.helloWorld
        // This is the name of the implementation function. Typescript will only allow arguments and returned types defined by the endpoint schema
        helloWorldImpl,
        // This tells the connector that it needs to inject the active database connection to the handler
        { databaseConnected: true }
    )
```

That's it, your `helloWorldImpl` is connected to the database resource. You just have to slightly change its definition:

```ts
const helloWorldImpl = async (props:HandlerProps, arg:string) : Promise<string> => {
    // Your implementation here
}
```

When the function is called, you receive the `serverless-postgres` library facade to talk to your database. Some pleasant features of that facade will be detailed below.

But wait a second. Connection to _what_ database? We didn't seem to have configured any access till now? Well, this is simply done by the environment variables in `process.env` that you can define when you configure your AWS lambda function:

- `DB_ENDPOINT_ADDRESS` has to contain the full URI to your database
- `DB_NAME` is the database's name available at the endpoint defined by the previous variable
- `DB_SECRET_ARN` is the AWS secret's ARN where the database password is stored. We don't store our passwords in clear anywhere

You can optionally change the database connection's serverless parameters by giving values to the following environment variables:

- `DB_APP_NAME` is the string that lets the connector make the difference between the processes it controls and the other ones. Default is `typizator_sl_client`
- `MIN_CONNECTION_IDLE_TIME_SEC` is the minimum time for the connection to be idle before recovered by the system. Default is `3`
- `MAX_CONNECTIONS` is the maximum number of parallel connection in the pool to maintain. Default is `24`

All this is configured automatically if you use the `ts-api-construct`from this library to integrate all this story with the CDK. 

Note that in your implementations you still have the access to the original event received by the lambda function through the `event` field of `HandlerProps`.

> **Note:** The database connection needs to be properly closed when the lambda function unloads. This is *not* the same lifecycle event as the lambda function termination. To make sure it's done, you have to create an empty external extension in your shared layer.

The simplest choice for that would be to connect the Insights extension to your lambda. It is connected through the `insightsLayer` property of the construct. However, it is not free, it has a usage cost on AWS. Instead, you can create an empty extension and add it to your shared layer. Simply create a `logger.ts` file in your shared layer's directory with the following content:

```ts
import { ExtensionAPIService, EventTypes } from "lambda-extension-service";

const main = async () => {
    const extensionApiService = new ExtensionAPIService({
        extensionName: 'logger',
    })
    await extensionApiService.register([EventTypes.Shutdown])

    for (; ;) {
        await extensionApiService.next()
    }
}

main().catch(error => console.error(error))
```

In the same directory, create an `extension/logger` file with the following content:

```bash
#!/bin/bash
set -euo pipefail

OWN_FILENAME="$(basename $0)"
LAMBDA_EXTENSION_NAME="$OWN_FILENAME" # (external) extension name has to match the filename
NODE_OPTIONS="" # Needed to reset NODE_OPTIONS set by Lambda runtime. Otherwise, the internal interceptor extension will be loaded in the external process too.

exec "/opt/${LAMBDA_EXTENSION_NAME}.js"
```

In order to build it with the `npm run build:logger` command, add the following to your `package.json`:

```json
"scripts": {
    // ....
    "build:logger": "./node_modules/.bin/esbuild  lambda/shared-layer/logger.ts --bundle --outfile='./lambda/shared-layer/logger.js' --platform=node --main-fields=module,main --banner:js='#!/usr/bin/env node'"
}
```

Also, make sure that your shared layer's directory is in the `exclude` field of your `tsconfig.json` file.

#### Database read replica

If you don't need to write any data to the database in your handler, instead of the main instance of the database, you can use its read replica. To do that, add an extra parameter to the connector's properties:

```ts
export const helloWorld = 
    lambdaConnector(
        api.metadata.implementation.helloWorld
        helloWorldImpl,
        { 
            databaseConnected: true,
            // This tells the connector to inject the read replica as the main database connection
            replicaInjection: "inject_as_main"
        }
    )
```

If that case, instead of the main database connection, you receive a database serverless client that you can use to read data from the database.

To create the read replica, simply add the `readReplica: true` prop next to the `connectDatabase` one to the construct's props when you define the stack.

### Custom error treatment

Note that you can pass as the third parameter of any handler a function that you can use as an error logger. It will be called on every uncaught exception that can occur in your implementation code:

```ts
const errorHandler = async (error: any, props: HandlerProps, metadata: NamedMetadata) => {
    // Your implementation here
}

lambdaConnector(
    api.metadata.implementation.helloWorld
    helloWorldImpl,
    {
        databaseConnection: false,
        // This function can be shared across your implementations
        errorHandler
    }
)
```

Note that if your handler is a connected one, this function will receive a database connection information in props, so that you can for example record the error information in a table if you need it. The `metadata` parameter receives the name and the API path of the function that have thrown the error.

### Firebase admin connector

If your application needs to send push notifications to your mobile apps with Firebase, you can do it by requesting the connection to Firebase to be injected into your handler. You just have to do this:

```ts
lambdaConnector(
    api.metadata.implementation.helloWorld
    helloWorldImpl,
    {
        firebaseAdminConnected: true
    }
)
```

In that case, your handler receives the connector object in `HandlerProps` and you can call it in your lambda when you need to send push messages:

```ts
await props.firebaseAdmin?.sendMulticastNotification?.(
    "Message title", 
    "Message body", 
    // List of push tokens you receive from your client applications
    [TOKEN1, TOKEN2],
    // Optional link to follow when the end user clicks on the push notification
    "http://www.destination.com"
    )
```

The function returns a standard `BatchResponse` that you can use as specified in Firebase documentation.

Note that when you use this connector, the Firebase secret key (that you have to obtain from Firebase) has to be in the secret identified by the ARN contained in the FB_SECRET_ARN environment variable. The Firebase database URL (also available from Firebase) has to be in the FB_DATABASE_NAME environment variable.

### Telegram connector

If your application needs a Telegram bot connection via Telegraf, you can inject it into your handler by putting the `telegraf` field in the handler's properties:

```ts
lambdaConnector(
    api.metadata.implementation.helloWorld
    helloWorldImpl,
    {
        telegraf: true
    }
)
```

Note that in that case your Telegram bot's ID has to be in the AWS secret identified by the ARN contained in the `TELEGRAF_SECRET_ARN` evironment variable.

In the handler function `HandlerProps` will contain the `telegraf` field pointing to a connected Telegraf object that you can use to communicate with the chosed Telegram bot.

The handler for the Telegram bot must be an API function with no arguments and no return value that will set up a connector similar to this:

```ts
export const proceedImpl = async (props: HandlerProps): Promise<void> => {
    props.telegraf?.start(async ctx => {
        // Response to starting to use the bot
    })

    props.telegraf?.hears("hi", async ctx => {
        // Response to "hi" message
    })
}

export const proceed = lambdaConnector(
    api.metadata.implementation.telegraf,
    telegrafImpl,
    {
        telegraf: true
    }
)
```

Note that you don't have to call the `handleUpdate` function at the end of your handler, it's done automatically by the framework.

### AWS secrets injection

If your application needs to use values stored in AWS secrets available for your account, you can specify it in your Lambda connector:

```ts
lambdaConnector(
    api.metadata.implementation.helloWorld
    helloWorldImpl,
    {
        secretsUsed: true
    }
)
```

Once it's done, your connector expects to get in the `SECRETS_LIST` environment variable a comma-separated list of ARNs of the AWS secrets you want to use in your handler. Once it's done, the values of the secrets are injected into the `HandlerProps` as an array in the `secrets` field.

### Database connection helpers

As we allow our lambdas to connect to databases (Postgres only for now, but nobody prevents us from adding support to other ones in the near future), it would be good to communicate to that database without the headache given by the fact that SQL and Typescript don't share the same types system and sometimes getting an objects list from an SQL query can be... how to say... unpredictable...

The database client connection is exposed through the `DatabaseConnection` interface that is passed to your lambda through the connected handler described above. Or otherwise you can directly create if from the `serverless-postgres` (that is a wrapper around `serverless-postgres` optimising connections from lambdas) connected client by calling the `connectDatabase` factory function from this library. 

You can still access the original `serverless-postgres` client through the interface's `client` property. There is also the `query` shortcut that executes a simple query on the database, returning the data in row mode. Refer to the `serverless-postgres` library if you forgot what it is.

Now, let's look at interesting things. Imagine you have in the database a table named `test_table` containing two fields, `test_id` that is a BIGINT and `test_name` that is a `VARCHAR(255)`. This structure can be defined using `typizator` as

```ts
const testTableS = objectS({
    testId: bigintS.notNull,
    testName: stringS.optional
}).notNull
type TestTable = InferTargetFromSchema<typeof testTableS>
```

`TestTable` will be automatically inferred as

```ts
{
    testId:bigint,
    testName:string | null | undefined
}
```

Notice that we follow the camel case convention for the fields names, the library takes care of conversions.

Now if from our interface we to `await connection.select(testTableS, "test_table")`, it looks into the `testTableS` schema and creates a query like this:

```sql
SELECT test_id, test_name FROM test_table
```

The call will return an array of `TestTable`, all types safely converted.

You can exclude some of the schema's fields from the query using the optional `overrides` parameter that (for now) allows to ignore one or more schema's fields. For example, you can modify the call above:

```ts
connection.select(testTableS, "test_table", [], { testName: { action: "OMIT" }})
```

...like that, the `test_name` field will not be included in the request.

A variation of this method is the `typedQuery`. The only difference between them is that `typedQuery` doesn't create the `SELECT` statement on the fly, it requires the full SQL query as the second argument. The first argument is still the `typizator` schema definition, we need it to correctly type the rows returned from the query.

For `typedQuery` it is possible to pass a primitive (like `stringS`) as a first argument, in that case we suppose that the query result will have one column (the other eventual columns are ignored) and it will return the array of primitives of a corresponding target type of the schema.

The `multiInsert` function allows to insert (in one query) up to 1000 rows to the table at the same time. For example:

```ts
const idsAndNames = [
    { testId: 1n, testName: "One" },
    { testId: 2n, testName: "Two" }
]
connection.multiInsert(testTableS, "test_table", idsAndNames)
```

There is also a `multiUpsert` function that acts exactly like `multiInsert` but allows to define what happens if you try to insert a row generating a key conflict. For example:

```ts
connection.multiInsert(
    testTableS, 
    "test_table", 
    [{ testId: 1n, testName: "One" }]
)
connection.multiUpsert(
    testTableS, 
    "test_table", 
    [{ testId: 1n, testName: "One modified" }],
    {
        upsertFields: ["testId"],
        onConflict: ActionOnConflict.REPLACE
    }
)
```

In this case, if `testId` is a unique key field, the second call will update the row by changing the value of `testName` to a modified value.

Instead of `REPLACE`, you can also use `IGNORE` in which case the conflicting updates are simply ignored or `REPLACE_IF_NULL` that only lets update the fields that are null before the upsert call.

Both `multiInsert` and `multiUpsert` accept action definitions similar to `"OMIT"` for the `select` function. In addition, you can set the action to `"NOW"` for date fields (it will set the corresponding field to the current server timestamp) and to `"COUNTER"` for number fields, in that case you have to add next to `action` the `sequenceName` field naming the database sequence object that will be used to fill the corresponding field. If you want to replace the field value by the result of any other SQL function, use the `"FUNCTION"` action and put the function into the `sql` field.

### Security context

Handlers can be run in a security context driven by the environment parameters.

Setting the `IP_LIST` environment variable for your lambda to the JSON string representing a list of authorized IP addresses (for example, `["10.0.0.1"]`) limits the access to the handler's implementation to those IP addresses only.

Setting the `ACCESS_MASK` lets you implement the access checking function that you pass in the properties to your `lambdaConnector`. This function takes as arguments the handler's properties, the security token sent by the client and the access rights context containing the number set as the `ACCESS_MASK` environment variable for the lambda. to give a simple example:

```ts
const authenticator = async (props:HandlerProps, _: string, access: AccessRights) => {
    // The following call should be implemented by you to check the security token agains the database
    // and return the numeric mask of access rights that match that token
    // You have to implement yourself the `getSecurityToken` function taking into account the way you want to authenticate your clients from the data received in headers or cookies
    const securityToken = getSecurityToken(props.event)
    const maskToCheck = await getServerMask(props, securityToken)
    return (maskToCheck & access.mask) !== 0
}

lambdaConnector(
    api.metadata.implementation.helloWorld
    helloWorldImpl,
    {
        databaseConnected:false,
        authenticator
    }
)
```

If you want your databse to be created as an Aurora cluster instead of RDS instance, you have to set the `auroraCluster` property to `true` in the construct's props.

#### CORS configuration

When you expose an API, you can limit the access to it by adding the CORS configuration to the stack. The simplest (default) configuration allows all origins with credentials. To explicitly set it, you simply add `corsConfiguration: "*"` to the construct's props. Alternatively, you can set it to specific origins, methods, etc.:

```ts
corsConfiguration: {
    allowOrigins: ["https://my-api-consumer.com"],
    allowHeaders: ["x-security-token"],
    allowMethods: ["GET", "POST"],
    allowCredentials: true
}
```

### Single CDK stack API implementation

Let's imagine a very simple two-methods API to implement, defined as `typizator` schema:

```ts
const api = apiS({
    helloWorld: {
        args: [stringS.notNull], retVal: stringS.notNull
    },
    subGroup: {
        report: { args:[] }
    }
})
```

We want on our CDK stack a structure that will create a slot for the implementation of this API in as many lambdas as there are methods in the API. Just two in this case. It will automatically be connected to the external world with an AWS HTTP API endpoint that we'll be able to connect from the client through the [typizator-client](https://www.npmjs.com/package/typizator-client) library.

We create it in a CDK stack:

```ts
class TestStack<T extends ApiDefinition> extends Stack {
    constructor(
        scope: Construct,
        id: string,
        props: StackProps
    ) {
        super(scope, id, props)
        // This is the construct from our library connecting
        const stack = new TSApiConstruct(
            this, 
            "TestApi", 
            {
                // We eventually inherit properties from the parent stack
                ...props,
                // We name the API
                apiName: "TSTestApi",
                // We describe it to those who will read this code after us
                description: "Test Typescript API",
                // This is THE KEY POINT: we pass our API schema to the construct.
                // And it build the implementation structure behind automatically.
                apiMetadata: api.metadata,
                // The folder in the root of your project where you put the Typescript implementations of your API methods
                lambdaPath: "lambda",
                // We don't connect to a database (yet)
                connectDatabase: false,
                // Here we define the properties for all the lambdas implementing our API. This is the shared configuration point
                lambdaProps: {
                    environment: {
                        ENV1: "a"
                    }
                },
                // And what if we want to define different props for different API's methods
                // It mimics the structure of your API, but all the entries are optional
                lambdaPropertiesTree: {
                    subGroup: {
                        // Here, we limit the access to subGroup and all its children to the 10.0.0.1 IP address
                        authorizedIps: ["10.0.0.1"],
                        report: {
                            // Here, we add the binary access mask to the report context.
                            // It can be checked before each execution through the authentication function
                            // passed to the lambda handler that implements that API function
                            accessMask: 0b1000,
                            // For example, we can schedule the function to run every minutes on the AWS cloud
                            schedules: [{
                                cron: { minute: "0/1" }
                            }]
                        }
                    }
                }
            })

        new CfnOutput(this, `ApiURL`, { value: stack.httpApi.url! })
    }
}
```

Now, how do we implement the API's functions? Very simple, we place the corresponding _.ts_ files in the directory defined by `lambdaPath`. The names of the files will be the same as in the API definition, but in _kebab-case_. In our case, we'll have to Typescript files:

- `hello-world.ts`
and
- `sub-group/report.ts`

In each of those files, we must export an implementing function with the same name as the file name, but in _camelCase_:

```ts
// hello-world.ts
import { handlerImpl } from "typizator-handler";
import { api } from "........";

export const helloWorldImpl = async (arg: string) : Promise<string> => {
    // Your implementation here
}

// This name must match the API definition
export const helloWorld = handlerImpl(
    api.metadata.implementation.helloWorld,
    // The name can be whatever you want, but the method signature must match the API definition
    helloWorldImpl
)
```

...and:

```ts
// sub-group/report.ts
import { handlerImpl } from "typizator-handler";
import { api } from "........";

export const reportImpl = async () : Promise<void> => {
    // Your implementation here
}

// This name must match the API definition
export const report = handlerImpl(
    api.metadata.implementation.report,
    // The name can be whatever you want, but the method signature must match the API definition
    reportImpl
)
```

We will need the connection point to our API to use it from outside. It is very simple, remember the `CfnOutput` at the end of the example stack above? It will print the URL of your API at the end of your next CDK deployment. Just copy it and use it. It will not change after the next deployments.

The construct automatically creates a layer in the `shared-layer` subdirectory of your `lambda` directory (you can change this via the construct's props). Put there all the stuff you need to share between all the API's lambdas, first of all the heavy-weight libraries that you don't need to bundle. Don't forget to list them in the `extraBundling.externalModules` property of your construct configuration, it's good to share things, but it's also good to let the compiler know about it...

That's it, your first implementation is done, you can deploy it with CDK and start to use it via the HTTP API.

### Adding a database

This is very simple. You just have to change the `connectDatabase` parameter in the stack definition above to `true` and add `dbProps:databaseName` to name your database, that's it.

You'll have to slightly change your handlers:

```ts
// hello-world.ts
import { HandlerProps, connectedHandlerImpl } from "typizator-handler";
import { api } from "........";

// When you use connectedHandlerImpl, the extra first parameter of the implementation becomes props, that contains the connected database object
export const helloWorldImpl = async (props: HandlerProps, arg: string) : Promise<string> => {
    // Your implementation here
}

// This name must match the API definition
export const helloWorld = connectedHandlerImpl(
    api.metadata.implementation.helloWorld,
    // The name can be whatever you want, but the method signature must match the API definition
    helloWorldImpl
)
```

When your implementation is called, `props.db` will contain the `ConnectedDatabase` facade to the Postgres database instance that the construct is creating for you on AWS RDS.

#### Bastion access

Sometimes you need to manually access your database through a terminal. This is possible by setting up a "Bastion" linux instance that will be the only point to have direct access to the database's IP port (**5432** in case of Postgresql). To set it up, simply add a `bastion` config parameter to the construct's props with, as a value, the list of IP networks that can access it from outside. For example, to open the access to _200.100.50.25_ only, add `bastion:{ openTo: "200.100.50.25/32" }.

Then you'll need to create an SSH key, then to install it on your Bastion by executing the following:

```bash
aws ec2-instance-connect send-ssh-public-key --instance-id {created bastion instance id} --instance-os-user ec2-user --ssh-public-key=file://~/.ssh/{your public key name}.pub
```

All that is about manual operations, so use the AWS console to locate all the needed addresses and identifiers.

Then on a machine where you want to access your database, create a tunnel (let's imagine you open the tunnel on the port **5446**):

```bash
ssh -i ./{your private key} -f -N -L 5446:{RDS database URL}:5432 ec2-user@{Bastion server address} -v
```

Then, you're free to connect the Postgresql terminal:

```bash
psql -h 127.0.0.1 -p 5446 -U postgres {Your database name}
```

### Migrating a data schema

It's good to create an empty database, but in a test-driven environment it would be also good to populate it at least with some tables and indexes. And later, change this schema following the development of your project. This is where the migration tool comes to help us.

The construct lets you create a special lambda that is deployed and executed during the CDK deployment as a custom component connected to the created database and executes what you require on this database every time this lambda's contents are changes.

I implemented a simple list-base forward-only migration tool that you can connect through the construct's properties. For that, you have to add to your configuration the `migrationLambda` property with the name of the lambda that fill do the job. For example `migrationLambda:"migration"`.

Then you have to create in your project's `lambda` folder (this name can be changed by setting an appropriate property) a typescript file named `migration.ts` (as per the configuration above) containing something like this:

```ts
const migrations = migrationList()
      .migration({
          order: 1,
          description: "Create first table",
          query: "CREATE TABLE tab1(id INTEGER)"
      })
      .migration({
          order: 2,
          description: "Create second table",
          query: "CREATE TABLE tab2(id INTEGER)"
      })

export const migration = postgresListMigrationHandler(migrations)
```

This will create in your database two tables `tab1` and `tab2`. Then, if you want to add something more, simply add other `.migration` records to your list. Once the project deployed with CDK, don't change the existing migration steps, they become immutable, rather add new steps changing the results of the existing ones.

### Splitting stacks

With a relatively big API, you'll hit sooner or later the AWS Cloudformation's limit of 500 deployed resources per stack. For that case, the library offers a possibility to split your API into several sub-APIs, each one deployed through its own stack and using its own HTTP API entry point.

First, you exclude a part of the API from the main constructs. Remember the API we did earlier:

```ts
const api = apiS({
    helloWorld: {
        args: [stringS.notNull], retVal: stringS.notNull
    },
    subGroup: {
        report: { args:[] }
    }
})
```

Let's move the subGroup to a different construct.

In our main construct's properties, we add:

```ts
apiExclusions: [
    api.metadata.implementation.subGroup.path
]
```

Then we can create (on a different stack) a new construct that will inherit (via the properties of the main stack) the access to all the resources for the new sub-api:

```ts
// We use DependentApiConstruct from this library
const childConstruct = new DependentApiConstruct(this, "ChildApi", {
    ...otherOptionalProps,
    apiName: "TSDependentTestApi",
    description: "Dependent typescript API",
    apiMetadata: api.metadata.implementation.subGroup,
    lambdaPath: "lambda", // You can change this for another directory if you want
    // Your parent construct must be inside its own stack in inherit the information on its components, including the database connection
    parentConstruct: parentStack.construct
})
```

The directory structure for the dependent stack's lambdas stay the same, i.e. our `report` lambda will live in `lambda/sub-group/report.ts`.

You can get the URL to access your child API by putting at the end of your child stack constructor the following:

```ts
new CfnOutput(this, `ChildApiURL`, { value: childConstruct.httpApi.url! })
```

The [typizator-client](https://www.npmjs.com/package/typizator-client) already includes the tools to integrate child APIs, refer to its documentation for details.

### Attaching the API to a custom domain

If you want to use your API on a domain name that belongs to you and in general to use something more readable than a long Amazon default domain name, you have an easy option for that with this library. But first, you need to have your domain hosted on AWS Route 53. You've probably already done it manually for a while, now your task is to create a subdomain and make it point to your API.

For that, in the properties of your construct you have to add the following property:

```ts
apiDomainData: {
    hostedZoneName: "yourdomain.com",
    domainNamePrefix: "api-endpoint"
}
```

This will create the `api-endpoint.yourdomain.com` name, create a certificate for it and let you query it with an HTTPS enpoint. The `apiUrl` property of your construct will point in that case to this endpoint, the `httpApi.url` stays available and points to the long and ugly URL from Amazon.

The only problem of this construction is that CDK will expect that your hosted zone name is available on the same AWS account that is used to deploy your CDK stack. It means that during the tests it will try to access this domain which is only possible in a full integration testing context, which is too heavy most of the times.

To solve it, you have to add for your tests the mock version of the domain lookup that will not try to go to the real Route 53 to try managing the domain. For that, the library has a special mock that could be added, on the test version of the stack only, as an extra property for the domain data:

```ts
apiDomainData: {
    hostedZoneName: "yourdomain.com",
    domainNamePrefix: "api-endpoint",
    customDomainLookup: customDomainLookupMock
}
```

That done, your tests will pass.

The other issue is that to work with Route 53 your stack will need to know your AWS account and main region. Let's imagine your main AWS hosting is in London. In that case, you have to add to the properties of your stack something like this:

```ts
env: {
    account: "<Your AWS account ID>",
    region: "eu-west-2"
}
```

The problem is that if at that moment you already have a database deployed on the stack (and thus a VPC attached to it), it can disturb your VPC's routing table. To avoid it, you have to explicitly set your VPC's availability zones to those you can find if you look at your VPC configuration in the AWS console. In our "London" case, we have to add to the construct's config the following:

```ts
vpcProps: {
    natGateways: 1,
    availabilityZones: ["eu-west-2a", "eu-west-2b"]
}
```

### Injecting connectors for Firebase, Telegram and AWS secrets

The underlying `typizator-handler` library has the support for injecting to the API handlers connected resources for Firebase administration, Telegram bots and AWS secrets.

#### Firebase administrator

The Firebase administrative connector lets you send push notifications to mobile and web applications. To obtain a connector, you have to store your private key in an AWS secret that you create on your stack with a standard CDK's `Secret` construct.

Once the secret created, you set up the Firebase connection in the properties of your stack:

```ts
firebaseAdminConnect: {
    secret, // CDK construct refering to the secret
    internalDatabaseName: "<url>" // URL of your Firebase database that you obtain in your Firebase console
}
```

### Telegram

You first have to create your bot through _BotFather_, then you store its token in an AWS secret refered by a CDK construct on your stack, then you simply add a reference to this secret to your stack's properties of the lambda that will be the handler for that bot:

```ts 
export const telegrafApiS = apiS({
  proceedHandler: { args: [] }
})

export class ExampleStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const telegrafSecret = new Secret(this, "TelegrafExampleSecret", {
      description: "Telegraf example Secret"
    })

    new TSApiConstruct(this, "TelegrafLibStack", {
        // ...
        lambdaPropertiesTree: {
            proceedHandler: { telegrafSecret },
        },
    })
  }
}
```

### AWS Secrets

You can create as many AWS secrets on your CDK stack, then put their references to the stack's properties:

```ts
secrets: [secret1, secret2] // CDK constructs refering to the secrets
```

In your handler, `HandlerProps` will contain a field with the contents of the listed secrets in the same order as above.

### SES client injection

If you want to use AWS mail sending capacities in your lambdas, you can make the container pre-inject the client to the `sesClient` property of `HandlerProps`. To do it, it's enough to set to `true` the `sesClient` prop for the `lambdaConnector` used to connect the lambda function. Note that the client will automatically be connected to the main AWS region of the stack.

## Tests

I recommend to use the `@testcontainers/postgresql` library to set up database-connected tests in a real environment. To accelerate test suites execution, I recommend to use the jest's `--runInBand` option and set up your tests suites similar to that:

```ts 
export const setupTestConnection = (runFirst = async (_: DatabaseConnection) => { }) => {
    jest.setTimeout(60000);
    const setup = {
        connection: null as (DatabaseConnection | null)
    }

    beforeAll(async () => {
        const container = await new PostgreSqlContainer().withReuse().start()
        const client = new Client({ connectionString: container.getConnectionUri() })
        await client.connect()
        setup.connection = connectDatabase(client)
        await runFirst(setup.connection)
    })

    afterAll(async () => await setup.connection!.client.end())

    return setup
}
```

We never test the framework. So once your construct configured, you can consider that it should work as expected. You just need to make sure that the construction passes and there is something on the resulting stack.

```ts
test("The template should sythetize properly", () => {
    const app = new App();
    const stack = new YourStackName(app, "UniqueStackId", {
        deployFor: "test"
    })
    const template = Template.fromStack(stack)
    // For example, we check that we have the common shared layer on our deployment
    const layers = template.findResources("AWS::Lambda::LayerVersion")
    expect(Object.keys(layers).length).toEqual(1)
})
```

After that, individually test the implementations of your components. You don't need to test the handlers themselves, it's a part of the framework, if the construct passes the test above, you can consider that they are properly connected.

My recommendation for the connected lambdas is to use a local Postgres instance, as explained in the documentation of [typizator-handler](https://www.npmjs.com/package/typizator-handler) and execute your migration every time you run your tests, this usually doesn't take a lot of time on the empty database. Use something like that to set up the connection:

```ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { MigrationResultFailure, MigrationResultSuccess, PostgresListMigrationProcessor } from "cdk-typescript-lib";
import { Client } from "pg";
import { DatabaseConnection, connectDatabase } from "typizator-handler";
import { migrations } from "<Path to your migration lambda>";

const isMigrationResultFailure = (
    arg: MigrationResultSuccess | MigrationResultFailure
): arg is MigrationResultFailure => !((arg as MigrationResultFailure).successful)

export const setupTestConnection = (runFirst = async (_: DatabaseConnection) => { }) => {
    jest.setTimeout(60000);
    const setup = {
        connection: null as (DatabaseConnection | null)
    }

    beforeAll(async () => {
        const container = await new PostgreSqlContainer().withReuse().start()
        const client = new Client({ connectionString: container.getConnectionUri() })
        await client.connect()
        setup.connection = connectDatabase(client)
        await runFirst(setup.connection)
        const migration = new PostgresListMigrationProcessor(migrations, { allowMigrationContentsChanges: true })
        await migration.initialize(setup.connection)
        const migrationResult = await migration.migrate(setup.connection)
        if (isMigrationResultFailure(migrationResult))
            throw new Error(`Migration failed: ${migrationResult.errorMessage}`)
    })

    afterAll(async () => await setup.connection!.client.end())

    return setup
}
```

Using `.withReuse` with the Postgres container economises the tests execution time, but can break a bit your test sandboxes cleanliness. To make sure that things are always clean in your test suites, create global setup and teardown procedures for jest, adding to _jest.config.js_ the following lines: 

```js
    globalSetup: '<rootDir>/tests/globalSetup.ts',
    globalTeardown: '<rootDir>/tests/globalTeardown.ts'
```

Then, do the necessary cleanup:

```ts
// globalSetup.ts

import { connectDatabase } from "typizator-handler"
import { objectS, stringS } from "typizator"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import { Client } from "pg"

export default async function setup() {
    console.log("Running global setup...")
    const container = await new PostgreSqlContainer().withReuse().start()
    const client = new Client({ connectionString: container.getConnectionUri() })
    await client.connect()
    const connection = connectDatabase(client)

    const allTables = await connection.typedQuery(
        objectS({ tablename: stringS }), 
        "SELECT tablename FROM pg_tables WHERE schemaname = current_schema()"
    )
    for (const table of allTables) {
        await connection.query(`DROP TABLE IF EXISTS ${table.tablename} CASCADE`)
    }
    (globalThis as any).connection = connection
    console.log("Done")
}
```

...and

```ts
// globalTeardown.ts

import { DatabaseConnection } from "typizator-handler";

export default async function teardown() {
    await ((globalThis as any).connection as DatabaseConnection).client.end()
    console.log("Global teardown done")
}
```