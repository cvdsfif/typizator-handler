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
    handlerImpl(
        // We take the endpoint schema from the API we defined earlier. It ensures type checks and conversions
        api.metadata.implementation.helloWorld
        // This is the name of the implementation function. Typescript will only allow arguments and returned types defined by the endpoint schema
        helloWorldImpl
    )
```

The implementation can be whatever you want, but it has to match the signature defined by the schema:

```ts
const helloWorldImpl = async (arg:string) : Promise<string> => {
    // Your implementation here
}
```

It becomes even more interesting if you want to connect a Postgres database (sitting on AWS RDS for example) and use it from your lambda. You just have to replace your handler by:

```ts
export const helloWorld = 
    // This is the other function from this library
    connectedHandlerImpl(
        // We take the endpoint schema from the API we defined earlier. It ensures type checks and conversions
        api.metadata.implementation.helloWorld
        // This is the name of the implementation function. Typescript will only allow arguments and returned types defined by the endpoint schema
        helloWorldImpl
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