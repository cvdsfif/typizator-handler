import { App, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ApiDefinition } from "typizator";
import { ExtendedStackProps, TSApiConstruct, TSApiPlainProperties, customDomainLookupMock } from "../src/ts-api-construct";
import { Template } from "aws-cdk-lib/assertions";
import { simpleApiS } from "./lambda/shared/simple-api-definition";

describe("Testing API that is hosted on a separate zone", () => {
    class TestStack<T extends ApiDefinition> extends Stack {
        readonly construct: TSApiConstruct<any>
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: TSApiPlainProperties<T>,
        ) {
            super(scope, id, props);
            this.construct = new TSApiConstruct(this, "SimpleApi", apiProps);
        }
    }

    test("Should fail on trying to retrieve the existing domain resource that does not exist at the test time", () => {
        const app = new App();
        const props = { deployFor: "test" };
        expect(() => new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: false,
                apiDomainData: {
                    hostedZoneName: "example.com",
                    domainNamePrefix: "test"
                },
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules: [
                        "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                        "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                        "serverless-postgres", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                    ]
                }
            }
        )).toThrow()
    })

    test("Should successfully connect the API to a hosted domain", () => {
        const app = new App();
        const props = { deployFor: "test" };
        const stack = new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: false,
                apiDomainData: {
                    hostedZoneName: "example.com",
                    domainNamePrefix: "test",
                    customDomainLookup: customDomainLookupMock
                },
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules: [
                        "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                        "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                        "serverless-postgres", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                    ]
                }
            }
        )
        const template = Template.fromStack(stack)

        template.hasResourceProperties("AWS::Route53::RecordSet", {
            "Name": "test.test.com."
        })
        expect(stack.construct.apiUrl).toMatch(/https/)
    })
})