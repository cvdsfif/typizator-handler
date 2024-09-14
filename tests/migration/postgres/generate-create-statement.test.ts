import { bigintS, boolS, dateS, floatS, intS, objectS, stringS } from "typizator";
import { generateCreateStatement } from "../../../src/migration/postgres/generate-create-statement";
import { extendExpectWithToContainStrings } from "./../../util/expect-contain-strings";

describe("Test create statements generator", () => {
    extendExpectWithToContainStrings()
    const simpleS = objectS({
        id: intS,
        strField: stringS,
        bigIntField: bigintS.notNull,
        floatField: floatS,
        dateField: dateS,
        boolField: boolS,
        specificString: stringS
    });

    test("Should generate create statement from a simple schema", () => {
        expect(generateCreateStatement(simpleS, "test_table", ["id"],
            {
                specificString: { dataType: "VARCHAR(255)" }
            }))
            .toContainAllStrings(
                "CREATE TABLE IF NOT EXISTS test_table",
                "id BIGINT PRIMARY KEY",
                "str_field TEXT",
                "big_int_field DECIMAL NOT NULL",
                "float_field DECIMAL",
                "date_field TIMESTAMPTZ",
                "bool_field BOOLEAN",
                "specific_string VARCHAR(255)"
            )
    })

    test("Should generate create statement with multiple-field primary keys", () => {
        expect(generateCreateStatement(simpleS, "test_table", ["id", "strField"]))
            .toContainAllStrings(
                "CREATE TABLE IF NOT EXISTS test_table",
                "id BIGINT",
                "str_field TEXT",
                "big_int_field DECIMAL",
                "float_field DECIMAL",
                "date_field TIMESTAMPTZ",
                "bool_field BOOLEAN",
                "PRIMARY KEY(id,str_field)"
            )
    })

    test("Should refuse unknown object types", () => {
        expect(() => generateCreateStatement(objectS({ subset: objectS({ f: stringS }) }), "test_table"))
            .toThrow("No PostgreSQL type available for the object type: subset field");
    })
})