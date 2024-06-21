# Runtime types and metadata schemas for Typescript 

![Coverage](./badges/coverage.svg) [![npm version](https://badge.fury.io/js/typizator-handler.svg)](https://badge.fury.io/js/typizator-handler) [![Node version](https://img.shields.io/node/v/typizator-handler.svg?style=flat)](https://nodejs.org/)

## Purpose

Well-typed database facade and clean converting of JSON parameters for AWS lambdas and similar applications

## Installing

```Bash
npm i typizator-handler
```

## Documentation

This library provides AWS lambda handlers to implement API methods defined by [typizator](https://www.npmjs.com/package/typizator) schemas.
It is essentially a set of utilities used to implement connected AWS lambda functions that are created with a set of CDK utilities
managed in the [cdk-typescript-lib](https://www.npmjs.com/package/cdk-typescript-lib).

It also defines a Postgres database facade to make requests using the same runtime type schemas.

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

When the function is called, you receive the `pg` library facade to talk to your database. Some pleasant features of that facade will be detailed below.

But wait a second. Connection to _what_ database? We didn't seem to have configured any access till now? Well, this is simply done by the environment variables in `process.env` that you can define when you configure your AWS lambda function:

- `DB_ENDPOINT_ADDRESS` has to contain the full URI to your database
- `DB_NAME` is the database's name available at the endpoint defined by the previous variable
- `DB_SECRET_ARN` is the AWS secret's ARN where the database password is stored. We don't store our passwords in clear anywhere

All this is configured automatically if you use the `cdk-typescript-lib` library to integrate all this story with the CDK. Why it is separated from this library? Simply because you don't want your lambdas to know anything about the details of their own deployment via CDK, it's not their concern. All they need are the type conversions, the resources connections and the handlers for that. And this is exactly what this library provides.

Note that in your implementations you still have the access to the original event received by the lambda function through the `event` field of `HandlerProps`.

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

    // We let Telegraf treat the body of the message received by the handler
    const body = JSON.parse(props.event!.body)
    await props.telegraf?.handleUpdate(body)
}

export const proceed = lambdaConnector(
    api.metadata.implementation.telegraf,
    telegrafImpl,
    {
        telegraf: true
    }
)
```

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

The database client connection is exposed through the `DatabaseConnection` interface that is passed to your lambda through the connected handler described above. Or otherwise you can directly create if from the `pg` connected client by calling the `connectDatabase` factory function from this library. 

You can still access the original `pg` client through the interface's `client` property. There is also the `query` shortcut that executes a simple query on the database, returning the data in row mode. Refer to the `pg` library if you forgot what it is.

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

Setting the `ACCESS_MASK` lets you implement the access checking function that you pass in the properties to your `lambdaConnector`. This function takes as arguments the handler's properties (first of all, for the database access), the security token sent by the client and the access rights context containing the number set as the `ACCESS_MASK` environment variable for the lambda. to give a simple example:

```ts
const authenticator = async (props:HandlerProps, securityToken: string, access: AccessRights) => {
    // The following call should be implemented by you to check the security token agains the database
    // and return the numeric mask of access rights that match that token
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