import * as pg from "pg";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { apiS, intS } from "typizator";
import { HandlerEvent, HandlerResponse } from "../../src/handler-objects";

describe("Test interfaces behaviour on a real database", () => {
    jest.setTimeout(60000);
    let envSaved: NodeJS.ProcessEnv;
    let getDataHandler: (event: HandlerEvent) => Promise<HandlerResponse>;
    let testClient: any;

    const mockValues = {
        actualSecretString: null as any,
        clientPassedArgs: [] as any[]
    }

    beforeAll(async () => {
        jest.mock("@aws-sdk/client-secrets-manager", () => ({
            SecretsManager: jest.fn().mockImplementation(() => ({
                getSecretValue: jest.fn().mockImplementation(() => Promise.resolve({
                    SecretString: mockValues.actualSecretString
                }))
            }))
        }));
        const container = await new PostgreSqlContainer().withReuse().start();
        testClient = new pg.Client({ connectionString: container.getConnectionUri() });
        jest.mock("pg", () => ({
            Client: (jest.fn().mockImplementation((...args: any) => {
                mockValues.clientPassedArgs = args;
                return testClient;
            }))
        }));

        const dataApi = apiS({
            getData: { args: [], retVal: intS }
        })

        const handlers = require("../../src");
        type DatabaseConnection = {
            client: pg.Client
        };
        type HandlerProps = {
            db?: DatabaseConnection
        }
        getDataHandler = handlers.connectedHandlerImpl(
            dataApi.metadata.implementation.getData,
            async (props: HandlerProps) => {
                const result = await props.db!.client.query("SELECT 1 as one");
                return result.rows[0].one;
            }
        )
    });

    afterAll(async () => await testClient.end());

    beforeEach(async () => {
        envSaved = process.env
    });

    afterEach(async () => process.env = envSaved);

    test("Should raise an exception if the database access is not configured", async () => {
        (expect(await getDataHandler({ body: "" }))).toEqual(expect.stringContaining("access not configured"));
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx";
        (expect(await getDataHandler({ body: "" }))).toEqual(expect.stringContaining("access not configured"));
        process.env.DB_NAME = "db";
        (expect(await getDataHandler({ body: "" }))).toEqual(expect.stringContaining("access not configured"));
        process.env.DB_SECRET_ARN = "arn";
        (expect(await getDataHandler({ body: "" }))).toEqual(expect.stringContaining("password not available"));
    });

    test("Should raise an exception if the secret is not recovered correctly", async () => {
        process.env.DB_ENDPOINT_ADDRESS = "http://xxx";
        process.env.DB_NAME = "db";
        process.env.DB_SECRET_ARN = "arn";
        mockValues.actualSecretString = `{ "password": "secret" }`;
        expect(await getDataHandler({ body: "" })).toEqual({ data: "1" });
        expect(mockValues.clientPassedArgs).toEqual([
            {
                user: "postgres",
                database: "db",
                host: "http://xxx",
                password: "secret",
                port: 5432
            }]);
    });

    test("Should expose database as connected resource for the appropriate handlers", async () => {
        expect((getDataHandler as any).connectedResources).toEqual(["DATABASE"]);
    });
});