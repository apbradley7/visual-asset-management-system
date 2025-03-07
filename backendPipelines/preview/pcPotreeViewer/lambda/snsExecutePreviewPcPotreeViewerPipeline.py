#  Copyright 2024 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0

"""
Lambda Function to Call from an SNS trigger from S3
"""
import os
import boto3
import json
from customLogging.logger import safeLogger
from urllib.parse import unquote_plus

logger = safeLogger(service="SnsExecutePreviewPcPotreeViewerPipeline")
lambda_client = boto3.client('lambda')
OPEN_PIPELINE_FUNCTION_NAME = os.environ["OPEN_PIPELINE_FUNCTION_NAME"]
S3_ASSETAUXILIARY_BUCKET_NAME = os.environ["S3_ASSETAUXILIARY_BUCKET_NAME"]


def execute_pipeline(input_s3_asset_file_path, output_s3_asset_files_path, output_s3_asset_preview_path, output_s3_asset_metadata_path
                                        , inputOutput_s3_assetAuxiliary_files_path, input_metadata, input_parameters, external_task_token
                                        , executing_userName, executing_requestContext):

    # Create the object message to be sent
    messagePayload = {
        "inputS3AssetFilePath": input_s3_asset_file_path,
        "outputS3AssetFilesPath": output_s3_asset_files_path,
        "outputS3AssetPreviewPath": output_s3_asset_preview_path,
        "outputS3AssetMetadataPath": output_s3_asset_metadata_path,
        "inputOutputS3AssetAuxiliaryFilesPath": inputOutput_s3_assetAuxiliary_files_path,
        "inputMetadata": input_metadata,
        "inputParameters": input_parameters,
        "sfnExternalTaskToken": external_task_token,
        "executingUserName": executing_userName,
        "executingRequestContext": executing_requestContext
    }

    # Invoke the pipeline construct pipeline lambda
    logger.info("Invoking Asset Lambda .........")
    lambda_response = lambda_client.invoke(FunctionName=OPEN_PIPELINE_FUNCTION_NAME,
                                        InvocationType='RequestResponse',
                                        Payload=json.dumps(messagePayload).encode('utf-8'))
    logger.info("lambda response")
    logger.info(lambda_response)
    logger.info("Invoke Open Pipeline Lambda Successfully.")

    if 'StatusCode' not in lambda_response or lambda_response['StatusCode'] != 200:
        message = lambda_response.get("body", {}).get("message", "")
        raise Exception("Invoke Open Pipeline Lambda Failed. " + message)


def lambda_handler(event, context):
    logger.info(event)

    try:

        # if no records in message return no files response
        if not event['Records']:
            logger.error(f"Error: Unable to retrieve SNS Records. No files to process.")
            return {
                'statusCode': 500,
                'body': {
                    'error': "Unable to retrieve SNS Records. No files to process."
                }
            }

        responses = []

        # Loop through S3 Uploads Records in SNS Message Input
        records = event['Records']
        for sns_record in records:
            logger.info(f"SNS Record: {sns_record}")

            try:
                # Parse SNS Message to retrieve S3 Records
                s3_records = json.loads(sns_record["Sns"]["Message"])['Records']
                logger.info(f"S3 Records: {s3_records}")
            except:
                logger.exception(f"Error: Unable to parse SNS Message. No S3 Records to process.")
                responses.append({
                    'statusCode': 500,
                    'body': {
                        'error': "Error: unable to parse SNS Message. No S3 Records to process."
                    }
                })

            # Get any given additional inputMetadata
            input_Metadata = ''

            # Get any given additional inputParameters
            input_Parameters = ''

            # Get any given additional outer/external task token to report back to (when using this pipeline as part of another state machine)
            external_sfn_task_token = ''

            # Loop through S3 Records
            for record in s3_records:
                logger.info(f"S3 Record: {record}")

                # Extract S3 file or files (if coming from a non S3 event source where you can group files to process)
                # TODO: Upgrade this to support multiple files. For now it can take an array but still only grabs the first item
                if (isinstance(record['s3'], list)):
                    s3Record = record['s3'][0]
                else:
                    s3Record = record['s3']

                # Extract the S3 bucket and key from the event data and adjust for spaces and plus sympbols
                s3_source_bucket = s3Record['bucket']['name']
                s3_source_key = unquote_plus(s3Record['object']['key'])

                inputS3AssetFilePath = f"s3://{s3_source_bucket}/{s3_source_key}"
                inputOutputS3AssetAuxiliaryFilesPath = f"s3://{S3_ASSETAUXILIARY_BUCKET_NAME}/{s3_source_key}/preview/PotreeViewer" #hard code to pipeline location

                logger.info(inputS3AssetFilePath)
                logger.info(inputOutputS3AssetAuxiliaryFilesPath)

                #Ignore pipeline and preview files from assets
                if s3_source_key.startswith("pipeline") or s3_source_key.startswith("preview"):
                    logger.info("Ignoring pipeline and preview files from assets for this use-case pipeline run")
                    continue

                # Starts excution of pipeline 
                execute_pipeline(inputS3AssetFilePath, '', ''
                                                    , '', inputOutputS3AssetAuxiliaryFilesPath
                                                    , input_Metadata, input_Parameters, external_sfn_task_token
                                                    ,"", "")

        return {
            'statusCode': 200,
            'body': 'Success'
        }
    except Exception as e:
        logger.exception(e)
        return {
            'statusCode': 500,
            'body': json.dumps({"message": "Internal Server Error"})
        }
