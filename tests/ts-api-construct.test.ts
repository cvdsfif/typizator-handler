import { App, RemovalPolicy, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Construct } from "constructs";
import { simpleApiS, simpleApiWithFirebaseS, simpleApiWithWrongTelegrafS } from "./lambda/shared/simple-api-definition";
import { ApiDefinition } from "typizator";
import { ExtendedStackProps, TSApiConstruct } from "../src/ts-api-construct";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { CorsHttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { simpleApiWithCacheS } from "./lambda/shared/cache-api-definition";

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
                    s3Buckets: [
                        { bucketName: "test-bucket" },
                        { bucketName: "test-public", publicAccess: true },
                    ],
                    lambdaInsightsArn,
                    corsConfiguration: "*",
                    extraBundling: {
                        minify: true,
                        sourceMap: false,
                        externalModules: [
                            "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                            "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                            "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
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
                                runtime: Runtime.NODEJS_22_X
                            },
                            logGroupProps: {
                                removalPolicy: RemovalPolicy.SNAPSHOT
                            },
                        },
                        cruel: {
                            authorizedIps: ["10.0.0.1"],
                            accessMask: 0b1000,
                            world: {
                                accessMask: 0b10,
                                authorizedIps: ["10.0.0.2"],
                                nodejsFunctionProps: {
                                    runtime: Runtime.NODEJS_20_X,
                                    architecture: Architecture.X86_64
                                }
                            },
                            word: {
                                nodejsFunctionProps: {
                                    runtime: Runtime.NODEJS_20_X,
                                    architecture: Architecture.X86_64
                                }
                            }
                        }
                    }
                })
            }
        )
        template = Template.fromStack(stack);
    })

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
                        "ACCESS_MASK": "2",
                        "IP_LIST": `["10.0.0.2"]`
                    }
                }
            })
        )

        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /cruel/word (test)",
                "Environment": {
                    "Variables": {
                        "ACCESS_MASK": "8",
                        "IP_LIST": `["10.0.0.1"]`
                    }
                }
            })
        )

        template.hasResourceProperties("AWS::S3::Bucket", {
            BucketName: "test-bucket"
        })
        template.hasResourceProperties("AWS::S3::Bucket", {
            BucketName: "test-public",
        })
    })

    test.failing("There should be no route for hidden lambdas", () => {
        template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
            "RouteKey": "POST /no-meow"
        })
    })

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
            "RouteKey": "POST /cruel/world"
        });
    })

    test("Should fail if we try to create a hidden lambda for Telegraf connector", () => {
        const app = new App()
        const props = { deployFor: "staging" }
        expect(() => new TestStack(
            app, "TestedStack", props,
            (stack: Stack) => {
                const secret = new Secret(stack, "TestSecret")
                const injectedSecret = new Secret(stack, "InjectedSecret")
                const telegrafSecret = new Secret(stack, "TelegrafSecret")
                return new TSApiConstruct(stack, "SimpleApi", {
                    ...props,
                    apiName: "TSTestApi",
                    description: "Test Typescript API",
                    apiMetadata: simpleApiWithWrongTelegrafS.metadata,
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
                            "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                            "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
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
                                runtime: Runtime.NODEJS_22_X
                            },
                            logGroupProps: {
                                removalPolicy: RemovalPolicy.SNAPSHOT
                            },
                        },
                        cruel: {
                            authorizedIps: ["10.0.0.2"],
                            accessMask: 0b1000,
                            world: {
                                nodejsFunctionProps: {
                                    runtime: Runtime.NODEJS_20_X,
                                    architecture: Architecture.X86_64
                                }
                            }
                        }
                    }
                })
            }
        )).toThrow()
    })

    test("Should set the default configuration of each lambda and let the end user modify it", () => {
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (test)",
                "Architectures": ["arm64"],
                "MemorySize": 256,
                "Runtime": "nodejs22.x",
                "Timeout": 60
            })
        );

        template.resourceCountIs("AWS::Logs::LogGroup", 0)

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
                    createLogGroups: true,
                    lambdaProps: {
                        runtime: Runtime.NODEJS_22_X,
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
                            "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                            "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                        ]
                    }
                }
            )
        )
        template = Template.fromStack(stack)
        template.hasResourceProperties("AWS::Lambda::Function",
            Match.objectLike({
                "Description": "Test Typescript API - /meow (staging)",
                "Runtime": "nodejs22.x",
                "LoggingConfig": {
                    "LogGroup": { "Ref": Match.stringLikeRegexp("Meow") }
                }
            })
        )
        template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
            "Name": "ProxyCorsHttpApi-TSTestApi-staging",
            "CorsConfiguration": { "AllowMethods": ["POST"], "AllowOrigins": ['https://ori.gin'], "AllowHeaders": ['*'] }
        })
        let allLogGroups = template.findResources("AWS::Logs::LogGroup", Match.anyValue())
        let helloWorldLogGroupKey = Object.keys(allLogGroups).find(key => key.includes("HelloWorld"));
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
                "CompatibleRuntimes": Match.arrayWith(["nodejs22.x", "nodejs20.x"])
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

    test("Should wire telegraf setup lambda log group when createLogGroups is true", () => {
        const app = new App();
        const props = { deployFor: "test" }
        const stack = new TestStack(
            app, "TestedStackWithTelegrafLogGroups", props,
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
                    createLogGroups: true,
                    secrets: [injectedSecret],
                    firebaseAdminConnect: {
                        secret,
                        internalDatabaseName: "db"
                    },
                    extraBundling: {
                        minify: true,
                        sourceMap: false,
                        externalModules: [
                            "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                            "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                            "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                        ]
                    },
                    lambdaPropertiesTree: {
                        telegrafInline: {
                            telegrafSecret
                        },
                        telegrafConnected: {
                            telegrafSecret
                        }
                    }
                })
            }
        )

        const telegrafTemplate = Template.fromStack(stack)
        const allLambdas = telegrafTemplate.findResources("AWS::Lambda::Function")
        const telegrafSetupLambdaKey = Object.keys(allLambdas).find((key) => {
            const props = allLambdas[key]?.Properties
            if (!props) return false
            if (props.Handler !== "index.handler") return false

            const vars = props.Environment?.Variables
            return !!vars?.TELEGRAF_SECRET_ARN && !!vars?.TELEGRAF_API_URL
        })
        expect(telegrafSetupLambdaKey).toBeDefined()
        const telegrafSetupLambda = allLambdas[telegrafSetupLambdaKey!]
        expect(telegrafSetupLambda.Properties.LoggingConfig.LogGroup).toBeDefined()
    })

    test("Should create serverless cache with default engine/version", () => {
        // GIVEN: a stack where serverless cache is enabled, but the user does not specify cache engine or engine version
        const app = new App()
        const props = { deployFor: "test" }
        const stack = new TestStack(
            app, "TestedStackWithCacheDefaults", props,
            (stack: Stack) => new TSApiConstruct(stack, "SimpleApi", {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                corsConfiguration: "*",
                connectDatabase: false,
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules: [
                        "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                        "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                        "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                    ]
                },
                serverlessCache: {
                    serverlessCacheName: "test-cache",
                }
            })
        )

        // WHEN: the CDK stack is synthesized into a CloudFormation template
        const cacheTemplate = Template.fromStack(stack)

        // THEN: the ServerlessCache resource is created using the defaults (engine=valkey, majorEngineVersion=8)
        cacheTemplate.hasResourceProperties("AWS::ElastiCache::ServerlessCache", {
            ServerlessCacheName: "test-cache",
            Engine: "valkey",
            MajorEngineVersion: "8",
        })
    })

    test("Should create serverless cache with overridden engine/version", () => {
        // GIVEN: a stack where serverless cache is enabled and the user explicitly specifies cache engine and major engine version
        const app = new App()
        const props = { deployFor: "test" }
        const stack = new TestStack(
            app, "TestedStackWithCacheOverrides", props,
            (stack: Stack) => new TSApiConstruct(stack, "SimpleApi", {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                corsConfiguration: "*",
                connectDatabase: false,
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules: [
                        "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                        "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                        "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                    ]
                },
                serverlessCache: {
                    serverlessCacheName: "test-cache",
                    engine: "valkey",
                    majorEngineVersion: "7",
                }
            })
        )

        // WHEN: the CDK stack is synthesized into a CloudFormation template
        const cacheTemplate = Template.fromStack(stack)

        // THEN: the ServerlessCache resource is created using the explicitly provided values (engine=valkey, majorEngineVersion=7)
        cacheTemplate.hasResourceProperties("AWS::ElastiCache::ServerlessCache", {
            ServerlessCacheName: "test-cache",
            Engine: "valkey",
            MajorEngineVersion: "7",
        })
    })

    test("Should fail if cacheConnected lambda is used without enabling serverless cache", () => {
        // GIVEN: an API with a lambda that declares it needs CACHE, while the stack does not enable serverlessCache
        const app = new App()
        const props = { deployFor: "test" }

        // WHEN: creating the construct
        const createStack = () => new TestStack(
            app, "TestedStackCacheWithoutCache", props,
            (stack: Stack) => new TSApiConstruct(stack, "SimpleApi", {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiWithCacheS.metadata,
                lambdaPath: "tests/lambda",
                corsConfiguration: "*",
                connectDatabase: false,
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules: [
                        "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                        "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                        "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                    ]
                },
            })
        )

        // THEN: the construct throws because serverlessCache is not configured, covering the cache validation branch (line 684)
        expect(createStack).toThrow()
    })

    test("Should apply vpcProps when provided", () => {
        // GIVEN: a database-connected stack where the user provides vpcProps overrides
        const app = new App()
        const props = { deployFor: "test" }
        const stack = new TestStack(
            app, "TestedStackWithVpcProps", props,
            (stack: Stack) => new TSApiConstruct(stack, "SimpleApi", {
                ...props,
                apiName: "TSTestApi",
                description: "Test Typescript API",
                apiMetadata: simpleApiS.metadata,
                lambdaPath: "tests/lambda",
                corsConfiguration: "*",
                connectDatabase: true,
                vpcProps: {
                    natGateways: 2,
                },
                dbProps: {
                    databaseName: "db",
                },
                extraBundling: {
                    minify: true,
                    sourceMap: false,
                    externalModules: [
                        "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                        "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                        "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                    ]
                },
            })
        )

        // WHEN: the CDK stack is synthesized into a CloudFormation template
        const vpcTemplate = Template.fromStack(stack)

        // THEN: two NAT gateways are created (natGateways overridden to 2), covering the vpcProps branch
        expect(Object.keys(vpcTemplate.findResources("AWS::EC2::NatGateway"))).toHaveLength(2)
    })

    test("Should create a provisioned alias when provisionedInstances is configured", () => {
        // GIVEN: a stack with a lambda configured with provisioned instances
        const app = new App()
        const props = { deployFor: "test" }
        const stack = new TestStack(
            app, "TestedStackWithProvisionedConcurrency", props,
            (stack: Stack) => {
                return new TSApiConstruct(stack, "SimpleApi", {
                    ...props,
                    apiName: "TSTestApi",
                    description: "Test Typescript API",
                    apiMetadata: simpleApiS.metadata,
                    lambdaPath: "tests/lambda",
                    connectDatabase: false,
                    corsConfiguration: "*",
                    extraBundling: {
                        minify: true,
                        sourceMap: false,
                        externalModules: [
                            "json-bigint", "typizator", "typizator-handler", "@aws-sdk/client-secrets-manager", "pg", "crypto",
                            "aws-cdk-lib", "constructs", "ulid", "firebase-admin", "luxon", "jsonwebtoken",
                            "serverless-postgres", "iovalkey", "lambda-extension-service", "@aws-sdk/client-ses", "@aws-sdk/client-s3"
                        ]
                    },
                    lambdaPropertiesTree: {
                        meow: {
                            provisionedInstances: 2,
                        }
                    }
                })
            }
        )

        // WHEN: the template is synthesized
        const provisionedTemplate = Template.fromStack(stack)

        // THEN: an alias is created and autoscaling is configured for provisioned concurrency (fixed min=max)
        provisionedTemplate.hasResourceProperties(
            "AWS::Lambda::Alias",
            Match.objectLike({
                Name: "provisioned",
            })
        )

        provisionedTemplate.hasResourceProperties(
            "AWS::ApplicationAutoScaling::ScalableTarget",
            Match.objectLike({
                MinCapacity: 2,
                MaxCapacity: 2,
            })
        )
    })
})