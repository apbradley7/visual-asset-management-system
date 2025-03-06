/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import { storageResources } from "../../../../storage/storageBuilder-nestedStack";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Peer, Port } from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import * as iam from "aws-cdk-lib/aws-iam";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Duration, Stack, Names, NestedStack } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
    buildConstructPipelineFunction,
    buildOpenPipelineFunction,
    buildVamsExecuteRapidPipelineFunction,
    buildPipelineEndFunction,
} from "../lambdaBuilder/rapidPipelineFunctions";
import { NagSuppressions } from "cdk-nag";
import { CfnOutput } from "aws-cdk-lib";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as ServiceHelper from "../../../../../helper/service-helper";
import { Service } from "../../../../../helper/service-helper";
import * as Config from "../../../../../../config/config";
import { generateUniqueNameHash } from "../../../../../helper/security";
import { kmsKeyPolicyStatementGenerator } from "../../../../../helper/security";

import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs"; // remove once ECS cluster is moved to VAMS vpc

export interface RapidPipelineConstructProps extends cdk.StackProps {
    config: Config.Config;
    storageResources: storageResources;
    vpc: ec2.IVpc;
    pipelineSubnetsPrivate: ec2.ISubnet[];
    pipelineSubnetsIsolated: ec2.ISubnet[];
    pipelineSecurityGroups: ec2.ISecurityGroup[];
    lambdaCommonBaseLayer: LayerVersion;
}

/**
 * Default input properties
 */
const defaultProps: Partial<RapidPipelineConstructProps> = {
    //stackName: "",
    //env: {},
};

/**
 * Deploys a Step Function for ECS RunTask workflow
 * Creates:
 * - SFN
 * - ECS
 * - IAM Roles / Policy Documents for permissions to S3 / Lambda
 * On redeployment, will automatically invalidate the CloudFront distribution cache
 */
export class RapidPipelineConstruct extends NestedStack {
    public pipelineVamsLambdaFunctionName: string;
    constructor(parent: Construct, name: string, props: RapidPipelineConstructProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        const region = Stack.of(this).region;
        const account = Stack.of(this).account;

        // const vpcSubnets = props.vpc.selectSubnets({
        //     subnets: props.pipelineSubnets,
        // });

        /**
         * ECS Task Resources
         */
        const inputBucketPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                    resources: [
                        props.storageResources.s3.assetBucket.bucketArn,
                        `${props.storageResources.s3.assetBucket.bucketArn}/*`,
                    ],
                }),
                new iam.PolicyStatement({
                    actions: ["s3:ListBucket"],
                    resources: [props.storageResources.s3.assetBucket.bucketArn],
                }),
            ],
        });

        const outputBucketPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                    resources: [
                        props.storageResources.s3.assetAuxiliaryBucket.bucketArn,
                        `${props.storageResources.s3.assetAuxiliaryBucket.bucketArn}/*`,
                    ],
                }),
                new iam.PolicyStatement({
                    actions: ["s3:ListBucket"],
                    resources: [props.storageResources.s3.assetAuxiliaryBucket.bucketArn],
                }),
            ],
        });

        //Add KMS key use if provided
        if (props.storageResources.encryption.kmsKey) {
            inputBucketPolicy.addStatements(
                kmsKeyPolicyStatementGenerator(props.storageResources.encryption.kmsKey)
            );

            outputBucketPolicy.addStatements(
                kmsKeyPolicyStatementGenerator(props.storageResources.encryption.kmsKey)
            );
        }

        const stateTaskPolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
                    resources: [`arn:${ServiceHelper.Partition()}:states:${region}:${account}:*`],
                }),
            ],
        });

        // Allows AWS Marketplace to track container usage
        const marketplaceUsagePolicy = new iam.PolicyDocument({
            statements: [
                new iam.PolicyStatement({
                    actions: ["aws-marketplace:RegisterUsage", "aws-marketplace:MeterUsage"],
                    resources: ["*"],
                }),
            ],
        });

        const containerExecutionRole = new iam.Role(this, "RapidPipelineContainerExecutionRole", {
            assumedBy: Service("ECS_TASKS").Principal,
            inlinePolicies: {
                InputBucketPolicy: inputBucketPolicy,
                OutputBucketPolicy: outputBucketPolicy,
                StateTaskPolicy: stateTaskPolicy,
                MarketplaceUsagePolicy: marketplaceUsagePolicy,
            },
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy"
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"),
            ],
        });

        const containerJobRole = new iam.Role(this, "RapidPipelineContainerJobRole", {
            assumedBy: Service("ECS_TASKS").Principal,
            inlinePolicies: {
                InputBucketPolicy: inputBucketPolicy,
                OutputBucketPolicy: outputBucketPolicy,
                StateTaskPolicy: stateTaskPolicy,
                MarketplaceUsagePolicy: marketplaceUsagePolicy,
            },
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    "service-role/AmazonECSTaskExecutionRolePolicy"
                ),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXrayWriteOnlyAccess"),
            ],
        });

        /**
         * SFN States
         */

        // connect pipeline lambda function
        // transforms data input for AWS ECS RunTask
        const constructPipelineFunction = buildConstructPipelineFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.config,
            props.vpc,
            props.pipelineSubnetsIsolated,
            props.pipelineSecurityGroups,
            props.storageResources.s3.assetAuxiliaryBucket,
            props.storageResources.encryption.kmsKey
        );

        // creates pipeline definition based on event notification input
        const constructPipelineTask = new tasks.LambdaInvoke(this, "ConstructPipelineTask", {
            lambdaFunction: constructPipelineFunction,
            outputPath: "$.Payload",
        });

        // end state: success
        const successState = new sfn.Succeed(this, "SuccessState", {
            comment: "Pipeline returned SUCCESS",
        });

        // end state: failure
        const failState = new sfn.Fail(this, "FailState", {
            causePath: sfn.JsonPath.stringAt("$.error.Cause"),
            errorPath: sfn.JsonPath.stringAt("$.error.Error"),
        });

        // end state evaluation: success or failure
        const endStatesChoice = new sfn.Choice(this, "EndStatesChoice")
            .when(sfn.Condition.isPresent("$.error"), failState)
            .otherwise(successState);

        // final lambda called on pipeline end to close out the statemachine run
        const pipelineEndFunction = buildPipelineEndFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources.s3.assetBucket,
            props.storageResources.s3.assetAuxiliaryBucket,
            props.config,
            props.vpc,
            props.pipelineSubnetsIsolated,
            props.pipelineSecurityGroups,
            props.storageResources.encryption.kmsKey
        );

        const pipeLineEndTask = new tasks.LambdaInvoke(this, "PipelineEndTask", {
            lambdaFunction: pipelineEndFunction,
            inputPath: "$",
            outputPath: "$.Payload",
        }).next(endStatesChoice);

        // error handler passthrough - from RapidPipeline ECS Task
        const handleRapidPipelineError = new sfn.Pass(this, "HandleRapidPipelineError", {
            resultPath: "$",
        }).next(pipeLineEndTask);

        /**
         * RapidPipeline Container Setup
         */

        const containerName =
            "RapidPipelineContainer" +
            generateUniqueNameHash(
                props.config.env.coreStackName,
                props.config.env.account,
                "VAMS-ECR-Container",
                10
            );

        // Note: temporary resource until cluster is moved to VAMS vpc
        // const vpcLogsGroups = new LogGroup(this, "CloudWatchVAMSVpc", {
        //     logGroupName:
        //         "/aws/vendedlogs/VAMSCloudWatchVPCLogs" +
        //         generateUniqueNameHash(
        //             props.config.env.coreStackName,
        //             props.config.env.account,
        //             "VAMSCloudWatchVPCLogsRapidPipeline",
        //             10
        //         ),
        //     retention: RetentionDays.TEN_YEARS,
        //     removalPolicy: cdk.RemovalPolicy.DESTROY,
        // });

        // Note: temporary resource until cluster is moved to VAMS vpc
        // const vpc = new ec2.Vpc(this, "vpc", {
        //     subnetConfiguration: [{
        //           cidrMask: 24,
        //           name: 'public',
        //           subnetType: ec2.SubnetType.PUBLIC,
        //     },
        //     {
        //           cidrMask: 24,
        //           name: 'private',
        //           subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        //     },
        // ],
        //     flowLogs: {
        //         "vpc-logs": {
        //             destination: ec2.FlowLogDestination.toCloudWatchLogs(vpcLogsGroups),
        //             trafficType: ec2.FlowLogTrafficType.ALL,
        //         },
        //     },
        // })

        const containerImage = ecs.ContainerImage.fromRegistry(
            props.config.app.pipelines.useRapidPipeline.ecrContainerImageURI
        );

        // Overriding cluster name bc AWS Marketplace team is having issues with long cluster names
        const cluster = new ecs.Cluster(this, "RapidPipelineEcsCluster", {
            clusterName:
                "rapid-cluster" +
                generateUniqueNameHash(
                    props.config.env.coreStackName,
                    props.config.env.account,
                    "VAMS-ECS-Cluster",
                    10
                ),
            // vpc, // temporarily placed in separate VPC with public subnet until VAMS vpc can handle private subnet with egress
            vpc: props.vpc,
            containerInsights: true,
        });

        const logGroup = new cdk.aws_logs.LogGroup(this, "RapidPipelineLogGroup", {
            logGroupName: "/aws/vendedlogs/Pipelines/" + containerName,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.ONE_MONTH,
        });

        const taskDefinition = new ecs.FargateTaskDefinition(this, "RapidPipelineTaskDefinition", {
            executionRole: containerExecutionRole,
            taskRole: containerJobRole,
            memoryLimitMiB: 16384, // 16 GB
            cpu: 2048, // 2 vCPU
        });

        const containerDefinition = taskDefinition.addContainer(
            "RapidPipelineContainerDefinition",
            {
                image: containerImage,
                logging: ecs.LogDrivers.awsLogs({
                    logGroup: logGroup,
                    streamPrefix: "ecs",
                }),
                memoryLimitMiB: 16384,
                cpu: 2048,
            }
        );

        // ECS cluster needs to be in private subnet (with egress) to connect to AWS Marketplace API
        const subnetSelection: ec2.SubnetSelection = {
            subnets: props.pipelineSubnetsPrivate,
        };

        // Note: temporary resource until cluster is moved to VAMS vpc
        // const securityGroup = new cdk.aws_ec2.SecurityGroup(this, "RapidPipelineTaskRunSG", { vpc: props.vpc, allowAllOutbound: true });
        // securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443), "Allow HTTPS access");

        // Step function task for ECS
        const runRapidPipelineJob = new tasks.EcsRunTask(this, "RapidPipelineRunFargate", {
            integrationPattern: sfn.IntegrationPattern.RUN_JOB,
            cluster,
            taskDefinition,
            assignPublicIp: false,
            containerOverrides: [
                {
                    containerDefinition,
                    command: sfn.JsonPath.listAt("$.commands"),
                    environment: [
                        {
                            name: "externalSfnTaskToken",
                            value: sfn.JsonPath.stringAt("$.externalSfnTaskToken"),
                        },
                    ],
                },
            ],
            launchTarget: new tasks.EcsFargateLaunchTarget(),
            propagatedTagSource: ecs.PropagatedTagSource.TASK_DEFINITION,
            // securityGroups: [securityGroup], // temporary until ECS cluster is moved to VAMS vpc
            securityGroups: props.pipelineSecurityGroups,
            subnets: subnetSelection,
        })
            .addCatch(handleRapidPipelineError, {
                resultPath: "$.error",
            })
            .next(pipeLineEndTask);

        /**
         * SFN Definition
         */
        const sfnPipelineDefinition = sfn.Chain.start(
            constructPipelineTask.next(runRapidPipelineJob)
        );

        /**
         * CloudWatch Log Group
         */
        const stateMachineLogGroup = new logs.LogGroup(
            this,
            "RapidPipelineProcessing-StateMachineLogGroup",
            {
                logGroupName:
                    "/aws/vendedlogs/VAMSStateMachine-RapidPipeline" +
                    generateUniqueNameHash(
                        props.config.env.coreStackName,
                        props.config.env.account,
                        "RapidPipelineProcessing-StateMachineLogGroup",
                        10
                    ),
                retention: logs.RetentionDays.TEN_YEARS,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            }
        );

        /**
         * SFN State Machine
         */
        const pipelineStateMachine = new sfn.StateMachine(
            this,
            "RapidPipelineProcessing-StateMachine",
            {
                definitionBody: sfn.DefinitionBody.fromChainable(sfnPipelineDefinition),
                timeout: Duration.hours(5),
                logs: {
                    destination: stateMachineLogGroup,
                    includeExecutionData: true,
                    level: sfn.LogLevel.ALL,
                },
                tracingEnabled: true,
            }
        );

        /**
         * Lambda Resources
         */

        //Build Lambda Pipeline Resources to Open the Pipeline
        // ******  See RapidPipeline documentation for available file extensions *******
        const allowedInputFileExtensions = ".glb,.gltf,.fbx,.obj,.stl,.ply,.usd,.usdz,.dae,.abc";
        const openPipelineFunction = buildOpenPipelineFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources.s3.assetBucket,
            props.storageResources.s3.assetAuxiliaryBucket,
            pipelineStateMachine,
            allowedInputFileExtensions,
            props.config,
            props.vpc,
            props.pipelineSubnetsIsolated,
            props.storageResources.encryption.kmsKey
        );

        //Build Lambda VAMS Execution Function (as an optional pipeline execution action)
        const rapidPipelineExecuteFunction = buildVamsExecuteRapidPipelineFunction(
            this,
            props.lambdaCommonBaseLayer,
            props.storageResources.s3.assetBucket,
            props.storageResources.s3.assetAuxiliaryBucket,
            openPipelineFunction,
            props.config,
            props.vpc,
            props.pipelineSubnetsIsolated,
            props.storageResources.encryption.kmsKey
        );

        this.pipelineVamsLambdaFunctionName = rapidPipelineExecuteFunction.functionName;

        //Output VAMS Pipeline Execution Function name
        new CfnOutput(this, "RapidPipelineLambdaExecutionFunctionName", {
            value: rapidPipelineExecuteFunction.functionName,
            description: "The RapidPipeline Lambda Function Name to use in a VAMS Pipeline",
            exportName: "RapidPipelineLambdaExecutionFunctionName",
        });

        //Nag Supressions
        const reason =
            "Intended Solution. The pipeline lambda functions need appropriate access to S3.";
        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: reason,
                    appliesTo: [
                        {
                            regex: "/Action::s3:.*/g",
                        },
                    ],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: reason,
                    appliesTo: [
                        {
                            // https://github.com/cdklabs/cdk-nag#suppressing-a-rule
                            regex: "/^Resource::.*/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: reason,
                    appliesTo: [
                        {
                            // https://github.com/cdklabs/cdk-nag#suppressing-a-rule
                            regex: "^Resource::.*openPipeline/ServiceRole/.*/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: reason,
                    appliesTo: [
                        {
                            // https://github.com/cdklabs/cdk-nag#suppressing-a-rule
                            regex: "^Resource::.*RapidPipelineProcessing-StateMachine/Role/.*/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: reason,
                    appliesTo: [
                        {
                            // https://github.com/cdklabs/cdk-nag#suppressing-a-rule
                            regex: "^Resource::.*pipelineEnd/ServiceRole/.*/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: reason,
                    appliesTo: [
                        {
                            // https://github.com/cdklabs/cdk-nag#suppressing-a-rule
                            regex: "^Resource::.*vamsExecuteRapidPipeline/ServiceRole/.*/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            containerExecutionRole,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "The IAM role for ECS Container execution uses AWS Managed Policies",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "ECS Containers require access to objects in the DataBucket",
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressions(
            containerJobRole,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "The IAM role for ECS Container execution uses AWS Managed Policies",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "ECS Containers require access to objects in the DataBucket",
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressionsByPath(
            Stack.of(this),
            `/${this.toString()}/RapidPipelineProcessing-StateMachine/Role/DefaultPolicy/Resource`,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "PipelineProcessingStateMachine uses default policy that contains wildcard",
                    appliesTo: [
                        "Resource::*",
                        "Action::kms:GenerateDataKey*",
                        `Resource::arn:<AWS::Partition>:batch:${region}:${account}:job-definition/*`,
                        {
                            regex: "/^Resource::<.*Function.*.Arn>:.*$/g",
                        },
                        {
                            regex: "/^Action::s3:.*$/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressionsByPath(
            Stack.of(this),
            `/${this.toString()}/openPipeline/ServiceRole/Resource`,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "openPipeline requires AWS Managed Policies, AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole",
                    appliesTo: [
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                    ],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "openPipeline uses default policy that contains wildcard",
                    appliesTo: ["Resource::*"],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressionsByPath(
            Stack.of(this),
            `/${this.toString()}/constructPipeline/ServiceRole/Resource`,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "constructPipeline requires AWS Managed Policies, AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole",
                    appliesTo: [
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                    ],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "openPipeline uses default policy that contains wildcard",
                    appliesTo: ["Resource::*"],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressionsByPath(
            Stack.of(this),
            `/${this.toString()}/vamsExecuteRapidPipeline/ServiceRole/DefaultPolicy/Resource`,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "vamsExecuteRapidPipeline requires AWS Managed Policies, AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole",
                    appliesTo: [
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                    ],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "vamsExecuteRapidPipeline uses default policy that contains wildcard",
                    appliesTo: ["Resource::*"],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "vamsExecuteRapidPipeline uses default policy that contains wildcard",
                    appliesTo: [
                        "Action::kms:GenerateDataKey*",
                        {
                            regex: "/^Resource::<.*Function.*.Arn>:.*$/g",
                        },
                    ],
                },
            ],
            true
        );

        NagSuppressions.addResourceSuppressionsByPath(
            Stack.of(this),
            `/${this.toString()}/pipelineEnd/ServiceRole/Resource`,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "pipelineEnd requires AWS Managed Policies, AWSLambdaBasicExecutionRole and AWSLambdaVPCAccessExecutionRole",
                    appliesTo: [
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
                        "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                    ],
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "pipelineEnd uses default policy that contains wildcard",
                    appliesTo: ["Resource::*"],
                },
            ],
            true
        );

        // temporary until ECS cluster is moved into VAMS vpc
        // NagSuppressions.addResourceSuppressionsByPath(
        //     Stack.of(this),
        //     `/${this.toString()}/RapidPipelineTaskRunSG/Resource`,
        //     [
        //         {
        //             id: "AwsSolutions-EC23",
        //             reason: "Inbound is limited to port 443 (HTTPS).",
        //         },
        //     ],
        //     true
        // );
    }
}
