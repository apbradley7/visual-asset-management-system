/* eslint-disable @typescript-eslint/no-unused-vars */
/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Construct } from "constructs";
import { storageResources } from "../storage/storageBuilder-nestedStack";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import * as cdk from "aws-cdk-lib";
import { Stack, NestedStack } from "aws-cdk-lib";
import { SecurityGroupGatewayPipelineConstruct } from "./constructs/securitygroup-gateway-pipeline-construct";
import { PcPotreeViewerBuilderNestedStack } from "./preview/pcPotreeViewer/pcPotreeViewerBuilder-nestedStack";
import { Metadata3dLabelingNestedStack } from "./genAi/metadata3dLabeling/metadata3dLabelingBuilder-nestedStack";
import { Conversion3dBasicNestedStack } from "./conversion/3dBasic/conversion3dBasicBuilder-nestedStack";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as Config from "../../../config/config";
import * as kms from "aws-cdk-lib/aws-kms";
import { NagSuppressions } from "cdk-nag";

export interface PipelineBuilderNestedStackProps extends cdk.StackProps {
    config: Config.Config;
    vpc: ec2.IVpc;
    subnets: ec2.ISubnet[];
    vpceSecurityGroup: ec2.ISecurityGroup;
    storageResources: storageResources;
    lambdaCommonBaseLayer: LayerVersion;
}

/**
 * Default input properties
 */
const defaultProps: Partial<PipelineBuilderNestedStackProps> = {};

export class PipelineBuilderNestedStack extends NestedStack {

    public pipelineVamsLambdaFunctionNames: string[] = [];

    constructor(parent: Construct, name: string, props: PipelineBuilderNestedStackProps) {
        super(parent, name);

        props = { ...defaultProps, ...props };

        const pipelineNetwork = new SecurityGroupGatewayPipelineConstruct(
            this,
            "PipelineNetwork",
            {
                ...props,
                config: props.config,
                vpc: props.vpc,
                vpceSecurityGroup: props.vpceSecurityGroup,
                subnets: props.subnets,
            }
        );

        ////Non-VPC Required Pipelines
        //Note: May still use VPC if config set to put lambdas into VPC
        if(props.config.app.pipelines.useConversion3dBasic.enabled) {

            const conversion3dBasicPipelineNestedStack =
            new Conversion3dBasicNestedStack(this, "Conversion3dBasicNestedStack", {
                ...props,
                config: props.config,
                storageResources: props.storageResources,
                vpc: props.vpc,
                pipelineSubnets: pipelineNetwork.subnets.pipeline,
                pipelineSecurityGroups: [pipelineNetwork.securityGroups.pipeline],
                lambdaCommonBaseLayer: props.lambdaCommonBaseLayer,
            });

            //Add function name to array for stack output
            this.pipelineVamsLambdaFunctionNames.push(conversion3dBasicPipelineNestedStack.pipelineVamsLambdaFunctionName)
        }


        ////VPC-Required Pipelines
        if (
            props.config.app.pipelines.usePreviewPcPotreeViewer.enabled ||
            props.config.app.pipelines.useGenAiMetadata3dLabeling.enabled
        ) {

            //Create nested stack for each turned on pipeline
            if (props.config.app.pipelines.usePreviewPcPotreeViewer.enabled) {
                const previewPcPotreeViewerPipelineNestedStack =
                    new PcPotreeViewerBuilderNestedStack(this, "PcPotreeViewerBuilderNestedStack", {
                        ...props,
                        config: props.config,
                        storageResources: props.storageResources,
                        lambdaCommonBaseLayer: props.lambdaCommonBaseLayer,
                        vpc: props.vpc,
                        pipelineSubnets: pipelineNetwork.subnets.pipeline,
                        pipelineSecurityGroups: [pipelineNetwork.securityGroups.pipeline],
                    });

                    //Add function name to array for stack output
                    this.pipelineVamsLambdaFunctionNames.push(previewPcPotreeViewerPipelineNestedStack.pipelineVamsLambdaFunctionName)
            }

            if (props.config.app.pipelines.useGenAiMetadata3dLabeling.enabled) {
                const genAiMetadata3dLabelingNestedStack = new Metadata3dLabelingNestedStack(
                    this,
                    "GenAiMetadata3dLabelingNestedStack",
                    {
                        ...props,
                        config: props.config,
                        storageResources: props.storageResources,
                        lambdaCommonBaseLayer: props.lambdaCommonBaseLayer,
                        vpc: props.vpc,
                        pipelineSubnets: pipelineNetwork.subnets.pipeline,
                        pipelineSecurityGroups: [pipelineNetwork.securityGroups.pipeline],
                    }
                );

                //Add function name to array for stack output
                this.pipelineVamsLambdaFunctionNames.push(genAiMetadata3dLabelingNestedStack.pipelineVamsLambdaFunctionName)
            }
        }
    }
}
