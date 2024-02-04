import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { ActionOnConflict, DatabaseConnection, connectDatabase } from "../../src/database-connection";
import { bigintS, boolS, dateS, intS, objectS, stringS } from "typizator";

describe("Testing the database type handling tools", () => {
    jest.setTimeout(60000);
    let connection: DatabaseConnection;

    beforeAll(async () => {
        const container = await new PostgreSqlContainer().withReuse().start();
        const client = new Client({ connectionString: container.getConnectionUri() });
        client.connect();
        connection = connectDatabase(client);
    });

    afterAll(async () => connection.client.end());

    beforeEach(async () => {
        await connection.query("CREATE TABLE test_table(id_field DECIMAL PRIMARY KEY,name VARCHAR(255),date_field TIMESTAMPTZ)");
    });

    afterEach(async () => {
        await connection.query("DROP TABLE test_table");
    });

    test("Should extract defined type array from the database query", async () => {
        const reqS = objectS({
            id: bigintS,
            firstName: stringS,
            oneExampleDate: dateS,
            nullString: stringS,
            intField: intS,
            boolField: boolS
        });
        const result = await connection.typedQuery(reqS, `
            SELECT 1 AS id,'name' AS first_name, CAST ('2024-01-31 00:00Z' AS TIMESTAMPTZ) AS one_example_date,
            NULL as null_string,2 AS int_field,CAST (1 as BOOL) AS bool_field
        `);
        expect(result[0]).toEqual({
            id: 1n, firstName: "name", oneExampleDate: new Date("2024-01-31 00:00Z"),
            nullString: null, intField: 2, boolField: true
        })
    });

    test("Should raise an exception if a non-optional field is missing", async () => {
        const testS = objectS({
            fieldMissing: intS
        });
        await expect(() => connection.typedQuery(testS, "SELECT 1 as extra"))
            .rejects.toThrow("Mandatory fieldMissing field missing from the request data");
    });

    test("Should accept if an optional field is missing", async () => {
        const testS = objectS({
            fieldMissing: intS.optional
        });
        expect(await connection.typedQuery(testS, "SELECT 1 as extra"))
            .toEqual([{}]);
    });

    test("Should raise a non-null field is null", async () => {
        const testS = objectS({
            notNullable: intS.notNull
        });
        await expect(() => connection.typedQuery(testS, "SELECT NULL as not_nullable"))
            .rejects.toThrow("Unboxing notNullable: Null not allowed");
    });

    test("Should raise an informative exception on an SQL problem", async () => {
        const testS = objectS({
            notNullable: intS.notNull
        });
        await expect(() => connection.typedQuery(testS, "SELECT nimportequoi"))
            .rejects.toThrow(`column "nimportequoi" does not exist`);
    });

    test("Should select from an inferred fields list", async () => {
        const testS = objectS({
            idField: intS,
            name: stringS
        });
        await connection.query("INSERT INTO test_table(id_field,name) VALUES(1,'something')");
        expect(await connection.select(testS, "test_table")).toEqual([{ idField: 1, name: "something" }]);
    });

    test("Should insert multiple rows in a table in a single request", async () => {
        const testS = objectS({
            idField: bigintS,
            name: stringS
        });
        await connection.multiInsert(testS, "test_table",
            [
                { idField: 12345678901234567890n, name: "One" },
                { idField: 2n, name: "Two" }
            ]);
        expect(await connection.select(testS, "test_table")).toEqual(
            [
                { idField: 12345678901234567890n, name: "One" },
                { idField: 2n, name: "Two" }
            ]);
    });

    test("Should provide informative errors for inserts", async () => {
        const testS = objectS({
            idField: bigintS,
            nameLala: stringS
        });
        await expect(async () => connection.multiInsert(testS, "test_table",
            [
                { idField: 12345678901234567890n, nameLala: "One" },
                { idField: 2n, nameLala: "Two" }
            ])).rejects.toThrow(`error: column "name_lala" of relation "test_table" does not exist`);
    });

    test("Should insert correctly execute overwriting upserts", async () => {
        const testS = objectS({
            idField: bigintS,
            name: stringS
        });
        await connection.multiInsert(testS, "test_table",
            [
                { idField: 12345678901234567890n, name: "One" },
                { idField: 2n, name: "Two" }
            ]);
        await connection.multiUpsert(testS, "test_table",
            [
                { idField: 2n, name: "Another two" }
            ], { upsertFields: ["idField"], onConflict: ActionOnConflict.REPLACE });
        expect(await connection.select(testS, "test_table WHERE id_field = 2")).toEqual(
            [
                { idField: 2n, name: "Another two" }
            ]);
    });

    test("Should only do upsert for nulls if asked for", async () => {
        const testS = objectS({
            idField: bigintS,
            name: stringS
        });
        await connection.multiInsert(testS, "test_table",
            [
                { idField: 12345678901234567890n, name: "One" },
                { idField: 2n, name: "Two" }
            ]);
        await connection.multiUpsert(testS, "test_table",
            [
                { idField: 2n, name: "Another two" }
            ], { upsertFields: ["idField"], onConflict: ActionOnConflict.REPLACE_IF_NULL });
        expect(await connection.select(testS, "test_table WHERE id_field = 2")).toEqual(
            [
                { idField: 2n, name: "Two" }
            ]);
        await connection.multiInsert(testS, "test_table",
            [
                { idField: 3n, name: null }
            ]);
        await connection.multiUpsert(testS, "test_table",
            [
                { idField: 3n, name: "Another three" }
            ], { upsertFields: ["idField"], onConflict: ActionOnConflict.REPLACE_IF_NULL });
        expect(await connection.select(testS, "test_table WHERE id_field = 3")).toEqual(
            [
                { idField: 3n, name: "Another three" }
            ]);
    });

    test("Should ignore key conflicts if asked to do so", async () => {
        const testS = objectS({
            idField: bigintS,
            name: stringS
        });
        await connection.multiInsert(testS, "test_table",
            [
                { idField: 12345678901234567890n, name: "One" },
                { idField: 2n, name: "Two" }
            ]);
        await connection.multiUpsert(testS, "test_table",
            [
                { idField: 2n, name: "Another two" }
            ], { upsertFields: ["idField"], onConflict: ActionOnConflict.IGNORE });
        expect(await connection.select(testS, "test_table WHERE id_field = 2")).toEqual(
            [
                { idField: 2n, name: "Two" }
            ]);
    });

    test("Should ignore upsert conflicts inside a single request", async () => {
        const testS = objectS({
            idField: bigintS,
            name: stringS
        });
        await connection.multiUpsert(testS, "test_table",
            [
                { idField: 12345678901234567890n, name: "One" },
                { idField: 2n, name: "Two" },
                { idField: 2n, name: "Another two" }
            ], { upsertFields: ["idField"], onConflict: ActionOnConflict.IGNORE });
        expect(await connection.select(testS, "test_table WHERE id_field = 2")).toEqual(
            [
                { idField: 2n, name: "Two" }
            ]);
    });

    test("Should resolve upsert conflicts inside a single request", async () => {
        const testS = objectS({
            idField: bigintS,
            name: stringS
        });
        await connection.multiUpsert(testS, "test_table",
            [
                { idField: 12345678901234567890n, name: "One" },
                { idField: 2n, name: "Two" },
                { idField: 2n, name: "Another two" }
            ], { upsertFields: ["idField"], onConflict: ActionOnConflict.REPLACE });
        expect(await connection.select(testS, "test_table WHERE id_field = 2")).toEqual(
            [
                { idField: 2n, name: "Another two" }
            ]);
    });

    test("Should merge upsert conflicts inside a single request", async () => {
        const testS = objectS({
            idField: bigintS,
            name: stringS
        });
        await connection.multiUpsert(testS, "test_table",
            [
                { idField: 2n, name: "Two" },
                { idField: 2n, name: "Another two" },
                { idField: 3n, name: null },
                { idField: 3n, name: "Another three" }
            ], { upsertFields: ["idField"], onConflict: ActionOnConflict.REPLACE_IF_NULL });
        expect(await connection.select(testS, "test_table")).toEqual(
            [
                { idField: 2n, name: "Two" },
                { idField: 3n, name: "Another three" }
            ]);
    });

    test("Should insert multiple rows in a table in a single request omitting and overriding some of them", async () => {
        const testS = objectS({
            idField: bigintS,
            name: stringS,
            dateField: dateS
        });
        await connection.multiInsert(testS, "test_table",
            [
                { idField: 12345678901234567890n },
                { idField: 2n }
            ],
            {
                name: { action: "OMIT" },
                dateField: { action: "NOW" }
            }
        );
        const fields = await connection.select(testS, "test_table ORDER BY id_field DESC")
        const nowOnServer = await connection.typedQuery(objectS({ isNow: dateS }), "SELECT now() AS is_now", [])
        expect(fields[0].dateField?.getTime()).toBeGreaterThan(nowOnServer[0].isNow!.getTime() - 30000)
    });
});