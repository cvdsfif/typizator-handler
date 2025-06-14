import { App, Stack } from "aws-cdk-lib";
import { Construct } from "constructs";
import { ApiDefinition } from "typizator";
import { DependentApiProperties, DependentApiConstruct, ExtendedStackProps, TSApiConstruct, TSApiPlainProperties, TSApiDatabaseProperties, customDomainLookupMock } from "../src/ts-api-construct";
import { Match, Template } from "aws-cdk-lib/assertions";
import { simpleApiS } from "./lambda/shared/simple-api-definition";
import { CorsHttpMethod } from "aws-cdk-lib/aws-apigatewayv2";

describe("Testing partial exclusions on the API", () => {
    class TestStack<T extends ApiDefinition> extends Stack {
        readonly construct: TSApiConstruct<T>

        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: TSApiDatabaseProperties<T>,
        ) {
            super(scope, id, props);
            this.construct = new TSApiConstruct(this, "SimpleApi", apiProps)
        }
    }

    class ConnectedStack<T extends ApiDefinition> extends Stack {
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            apiProps: DependentApiProperties<T>,
        ) {
            super(scope, id, props);
            new DependentApiConstruct(this, "ChildApi", apiProps)
        }
    }

    let stack: Stack
    let dependentStack: Stack
    let dependentStackWithoutCors: Stack
    let dependentStackWithWildcardCors: Stack
    let dependentStackWithWildcardCorsAndWithDomain: Stack
    let dependentStackWithDomain: Stack

    const externalModules = [
        "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
        "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
        "serverless-postgres", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
    ]

    const init = () => {
        const app = new App()
        const props = { deployFor: "test" };
        const innerStack = new TestStack(
            app, "TestedStack", props,
            {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                connectDatabase: true,
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules
                },
                dbProps: {
                    databaseName: "TestDB"
                },
                lambdaProps: {
                    environment: {
                        ENV1: "a"
                    }
                },
                corsConfiguration: { allowMethods: [CorsHttpMethod.POST], allowHeaders: ["*"], allowOrigins: ["https://ori.gin"] },
                apiExclusions: [
                    simpleApiS.metadata.implementation.cruel.metadata.path,
                    simpleApiS.metadata.implementation.noMeow.metadata.path
                ]
            }
        )
        stack = innerStack

        dependentStack = new ConnectedStack(
            app, "DependentStack", props,
            {
                ...props,
                apiName: "TSDependentTestApi",
                description: "Dependent typescript API",
                apiMetadata: simpleApiS.metadata.implementation.cruel.metadata,
                lambdaPath: "tests/lambda",
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules
                },
                parentConstruct: innerStack.construct,
                corsConfiguration: { allowMethods: [CorsHttpMethod.GET], allowHeaders: ["*"], allowOrigins: ["https://ori.gin"] },
            }
        )

        dependentStackWithoutCors = new ConnectedStack(
            app, "DependentStackWithoutCors", props,
            {
                ...props,
                apiName: "TSDependentTestApi",
                description: "Dependent typescript API",
                apiMetadata: simpleApiS.metadata.implementation.cruel.metadata,
                lambdaPath: "tests/lambda",
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules
                },
                parentConstruct: innerStack.construct,
            }
        )

        dependentStackWithWildcardCors = new ConnectedStack(
            app, "DependentStackWithWildcardCors", props,
            {
                ...props,
                apiName: "TSDependentTestApi",
                description: "Dependent typescript API",
                apiMetadata: simpleApiS.metadata.implementation.cruel.metadata,
                lambdaPath: "tests/lambda",
                parentConstruct: innerStack.construct,
                corsConfiguration: "*",
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules
                },
                apiDomainData: {
                    hostedZoneName: "example.com",
                    domainNamePrefix: "test",
                    customDomainLookup: customDomainLookupMock
                },
            }
        )

        dependentStackWithWildcardCorsAndWithDomain = new ConnectedStack(
            app, "DependentStackWithWildcardCorsAndWithDomain", props,
            {
                ...props,
                apiName: "TSDependentTestApi",
                description: "Dependent typescript API",
                apiMetadata: simpleApiS.metadata.implementation.cruel.metadata,
                lambdaPath: "tests/lambda",
                parentConstruct: innerStack.construct,
                corsConfiguration: "*",
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules
                },
                apiDomainData: {
                    hostedZoneName: "example.com",
                    domainNamePrefix: "test",
                    customDomainLookup: customDomainLookupMock
                },
            }
        )

        dependentStackWithDomain = new ConnectedStack(
            app, "DependentStackWithDomain", props,
            {
                ...props,
                apiName: "TSDependentTestApi",
                description: "Dependent typescript API",
                apiMetadata: simpleApiS.metadata.implementation.cruel.metadata,
                lambdaPath: "tests/lambda",
                parentConstruct: innerStack.construct,
                corsConfiguration: { allowMethods: [CorsHttpMethod.POST], allowHeaders: ["*"], allowOrigins: ["https://ori.gin"] },
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules
                },
                apiDomainData: {
                    hostedZoneName: "example.com",
                    domainNamePrefix: "test",
                    customDomainLookup: customDomainLookupMock
                },
            }
        )
    }


    test("Excluded functions should not appear on the stack", async () => {
        init()
        const template = Template.fromStack(stack)
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("meow")
            })
        )
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("helloWorld")
            })
        )
        template.allResourcesProperties("AWS::Lambda::Function",
            Match.not(
                Match.objectLike({
                    "Description": Match.stringLikeRegexp("world")
                })
            )
        )
        template.allResourcesProperties("AWS::Lambda::Function",
            Match.not(
                Match.objectLike({
                    "Description": Match.stringLikeRegexp("cruel")
                })
            )
        )
        template.allResourcesProperties("AWS::Lambda::Function",
            Match.not(
                Match.objectLike({
                    "Description": Match.stringLikeRegexp("noMeow")
                })
            )
        )
    })

    test("Dependent stack constructs and takes resources from the main one with separate HTTP api", async () => {
        init()
        const dependentTemplate = Template.fromStack(dependentStack)
        dependentTemplate.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("world")
            })
        )

        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /cruel/world"
        })
        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSDependentTestApi-Crueltest",
            "CorsConfiguration": { "AllowMethods": ["GET"], "AllowOrigins": ['https://ori.gin'], "AllowHeaders": ['*'] }
        })

    })

    test("Dependent stack constructs and takes resources from the main one with separate HTTP api inheriting cors", async () => {
        init()
        const dependentTemplate = Template.fromStack(dependentStackWithoutCors)
        dependentTemplate.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("world")
            })
        )

        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /cruel/world"
        })
        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSDependentTestApi-Crueltest",
            "CorsConfiguration": { "AllowMethods": ["POST"], "AllowOrigins": ['https://ori.gin'], "AllowHeaders": ['*'] }
        })

    })

    test("Dependent stack constructs and takes resources from the main one with separate HTTP api wildcard cors", async () => {
        init()
        const dependentTemplate = Template.fromStack(dependentStackWithWildcardCors)
        dependentTemplate.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("world")
            })
        )

        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /cruel/world"
        })
        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSDependentTestApi-Crueltest",
            "CorsConfiguration": { "AllowMethods": ["*"], "AllowOrigins": ['*'], "AllowHeaders": ['*'] }
        })
    })

    test("Dependent stack constructs and takes resources from the main one with separate HTTP api wildcard cors and domain", async () => {
        init()
        const dependentTemplate = Template.fromStack(dependentStackWithWildcardCorsAndWithDomain)
        dependentTemplate.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("world")
            })
        )

        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /cruel/world"
        })
        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSDependentTestApi-Crueltest",
            "CorsConfiguration": { "AllowMethods": ["*"], "AllowOrigins": ['*'], "AllowHeaders": ['*'] }
        })
    })

    test("Dependent stack constructs and takes resources from the main one with separate HTTP api and domain", async () => {
        init()
        const dependentTemplate = Template.fromStack(dependentStackWithDomain)
        dependentTemplate.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": Match.stringLikeRegexp("world")
            })
        )

        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /cruel/world"
        })
        dependentTemplate.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSDependentTestApi-Crueltest",
            "CorsConfiguration": { "AllowMethods": ["POST"], "AllowOrigins": ['https://ori.gin'], "AllowHeaders": ['*'] }
        })
    })
})