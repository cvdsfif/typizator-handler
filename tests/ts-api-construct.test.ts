import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Construct } from "constructs";
import { simpleApiS, simpleApiWithFirebaseS } from "./lambda/shared/simple-api-definition";
import { ApiDefinition } from "typizator";
import { ExtendedStackProps, TSApiConstruct, TSApiPlainProperties } from "../src/ts-api-construct";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { CorsHttpMethod } from "aws-cdk-lib/aws-apigatewayv2";

describe("Testing the behaviour of the Typescript API construct for CDK", () => {
    class TestStack<T extends ApiDefinition> extends Stack {
        constructor(
            scope: Construct,
            id: string,
            props: ExtendedStackProps,
            createConstruct: (stack: Stack) => TSApiConstruct<T>
        ) {
            super(scope, id, props)
            createConstruct(this)
        }
    }

    let template: Template
    const lambdaInsightsArn = "arn:aws:lambda:eu-west-2:580247275435:layer:LambdaInsightsExtension-Arm64:20"

    beforeEach(() => {
        const app = new App();
        const props = { deployFor: "test" }
        const stack = new TestStack(
            app, "TestedStack", props,
            (stack: Stack) => {
                const secret = new Secret(stack, "TestSecret")
                const injectedSecret = new Secret(stack, "InjectedSecret")
                const telegrafSecret = new Secret(stack, "TelegrafSecret")
                return new TSApiConstruct(stack, "SimpleApi", {
                    ...props,
                    apiName: "TSTestApi",
                    description: "Test Typescript API",
                    apiMetadata: simpleApiWithFirebaseS.metadata,
                    lambdaPath: "tests/lambda",
                    connectDatabase: false,
                    secrets: [injectedSecret],
                    firebaseAdminConnect: {
                        secret,
                        internalDatabaseName: "db"
                    },
                    lambdaProps: {
                        environment: {
                            ENV1: "a"
                        }
                    },
                    lambdaInsightsArn,
                    corsConfiguration: "*",
                    extraBundling: {
                        minify: true,
                        sourceMap: false,
                        externalModules: [
                            "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                            "aws-cdk-lib", "constructs", "ulid", "moment", "firebase-admin", "luxon"
                        ]
                    },
                    lambdaPropertiesTree: {
                        telegrafInline: {
                            telegrafSecret
                        },
                        telegrafConnected: {
                            telegrafSecret
                        },
                        meow: {
                            schedules: [{
                                cron: { minute: "0/1" }
                            }],
                            nodejsFunctionProps: {
                                environment: {
                                    ENV2: "b"
                                }
                            }
                        },
                        noMeow: {
                            authorizedIps: ["10.0.0.1"],
                            accessMask: 0b1000,
                            nodejsFunctionProps: {
                                runtime: Runtime.NODEJS_18_X
                            },
                            logGroupProps: {
                                removalPolicy: RemovalPolicy.SNAPSHOT
                            }
                        },
                        cruel: {
                            authorizedIps: ["10.0.0.1"],
                            accessMask: 0b1000,
                            world: {
                                nodejsFunctionProps: {
                                    runtime: Runtime.NODEJS_16_X,
                                    architecture: Architecture.X86_64
                                }
                            }
                        }
                    }
                })
            }
        )
        template = Template.fromStack(stack);
    });

    test("Should create lambdas matching the API structure", () => {
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (test)",
                "Environment": {
                    "Variables": Match.objectLike({
                        "ENV1": "a",
                        "ENV2": "b"
                    })
                }
            })
        );
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /noMeow (test)",
                "Environment": {
                    "Variables": {
                        "ACCESS_MASK": "8",
                        "IP_LIST": `["10.0.0.1"]`
                    }
                }
            })
        )
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /firebaseConnected (test)",
                "Environment": {
                    "Variables": {
                        "FB_SECRET_ARN": {
                            "Ref": Match.stringLikeRegexp("TestSecret")
                        },
                        "FB_DATABASE_NAME": "db"
                    }
                }
            })
        )
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /secretsConnected (test)",
                "Environment": {
                    "Variables": {
                        "SECRETS_LIST": {
                            "Ref": Match.stringLikeRegexp("InjectedSecret")
                        }
                    }
                }
            })
        )
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /telegrafConnected (test)",
                "Environment": {
                    "Variables": {
                        "TELEGRAF_SECRET_ARN": {
                            "Ref": Match.stringLikeRegexp("TelegrafSecret")
                        }
                    }
                }
            })
        )
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /helloWorld (test)"
            })
        );
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /cruel/world (test)",
                "Environment": {
                    "Variables": {
                        "ACCESS_MASK": "8",
                        "IP_LIST": `["10.0.0.1"]`
                    }
                }
            })
        );
    });

    test("Should integrate lambdas with an HTTP api", () => {
        template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSTestApi-test",
            "CorsConfiguration": { "AllowMethods": ["*"], "AllowOrigins": ['*'], "AllowHeaders": ['*'] }
        });

        template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
            "IntegrationUri": {
                "Fn::GetAtt": [Match.stringLikeRegexp("Meow"), "Arn"]
            }
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
            "IntegrationUri": {
                "Fn::GetAtt": [Match.stringLikeRegexp("NoMeow"), "Arn"]
            }
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
            "IntegrationUri": {
                "Fn::GetAtt": [Match.stringLikeRegexp("HelloWorld"), "Arn"]
            }
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
            "IntegrationUri": {
                "Fn::GetAtt": [Match.stringLikeRegexp("CruelWorld"), "Arn"]
            }
        });

        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /hello-world"
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /meow"
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /no-meow"
        });
        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /cruel/world"
        });
    });

    test("Should set the default configuration of each lambda and let the end user modify it", () => {
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (test)",
                "Architectures": ["arm64"],
                "MemorySize": 256,
                "Runtime": "nodejs20.x",
                "Timeout": 60,
                "LoggingConfig": {
                    "LogGroup": { "Ref": Match.stringLikeRegexp("Meow") }
                }
            })
        );

        let allLogGroups = template.findResources("AWS::Logs::LogGroup", Match.anyValue())
        let helloWorldLogGroupKey = Object.keys(allLogGroups).find(key => key.includes("HelloWorld"));
        expect(allLogGroups[helloWorldLogGroupKey!].DeletionPolicy).toEqual("Delete")
        const noMeowLogGroupKey = Object.keys(allLogGroups).find(key => key.includes("NoMeow"));
        expect(allLogGroups[noMeowLogGroupKey!].DeletionPolicy).toEqual("Snapshot")

        // Create a separate stack with updated Lambda config
        const app = new App()
        const props = { deployFor: "staging" }
        const stack = new TestStack(
            app, "TestedStack", props,
            (stack: Stack) => new TSApiConstruct(stack, "SimpleApi",
                {
                    ...props,
                    apiName: "TSTestApi",
                    description: "Test Typescript API",
                    apiMetadata: simpleApiS.metadata,
                    lambdaPath: "tests/lambda",
                    corsConfiguration: { allowMethods: [CorsHttpMethod.POST], allowHeaders: ["*"], allowOrigins: ["https://ori.gin"] },
                    lambdaProps: {
                        runtime: Runtime.NODEJS_18_X,
                        architecture: Architecture.ARM_64
                    },
                    logGroupProps: {
                        removalPolicy: RemovalPolicy.RETAIN
                    },
                    connectDatabase: false,
                    extraBundling: {
                        minify: true,
                        sourceMap: false,
                        externalModules: [
                            "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                            "aws-cdk-lib", "constructs", "ulid", "moment", "firebase-admin", "luxon"
                        ]
                    }
                }
            )
        )
        template = Template.fromStack(stack)
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (staging)",
                "Runtime": "nodejs18.x",
                "LoggingConfig": {
                    "LogGroup": { "Ref": Match.stringLikeRegexp("Meow") }
                }
            })
        )
        template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSTestApi-staging",
            "CorsConfiguration": { "AllowMethods": ["POST"], "AllowOrigins": ['https://ori.gin'], "AllowHeaders": ['*'] }
        })
        allLogGroups = template.findResources("AWS::Logs::LogGroup", Match.anyValue())
        helloWorldLogGroupKey = Object.keys(allLogGroups).find(key => key.includes("HelloWorld"));
        expect(allLogGroups[helloWorldLogGroupKey!].DeletionPolicy).toEqual("Retain")
    })

    test("Should add a shared layer to lambdas", () => {
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (test)",
                "Layers": [
                    { "Ref": Match.stringLikeRegexp("SimpleApiSharedLayer") },
                    lambdaInsightsArn
                ]
            })
        );
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /noMeow (test)"
            })
        );
        template.hasResourceProperties("AWS::Lambda::LayerVersion",
            Match.objectLike({
                "CompatibleRuntimes": Match.arrayWith(["nodejs20.x", "nodejs18.x", "nodejs16.x"])
            })
        );
    });

    test("Should set the timers as required", () => {
        template.hasResourceProperties("AWS::Events::Rule",
            Match.objectLike({
                "ScheduleExpression": "cron(0/1 * * * ? *)"
            })
        )
        template.hasResourceProperties("AWS::Events::Rule",
            Match.objectLike({
                "Targets": [Match.objectLike({
                    "Arn": { "Fn::GetAtt": [Match.stringLikeRegexp("Meow"), "Arn"] },
                    "Input": "{\"body\":\"{}\"}"
                })]
            })
        )
    })
});