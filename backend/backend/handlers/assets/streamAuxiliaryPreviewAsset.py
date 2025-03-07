#  Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0

import os
import boto3
import json
import base64
import sys
from botocore.exceptions import ClientError
from common.constants import STANDARD_JSON_RESPONSE
from common.validators import validate
from handlers.authz import CasbinEnforcer
from handlers.auth import request_to_claims
from customLogging.logger import safeLogger
from common.s3 import validateUnallowedFileExtensionAndContentType
from common.dynamodb import get_asset_object_from_id

s3_client = boto3.client('s3')
logger = safeLogger(service_name="StreamAuxiliaryPreviewAsset")

def lambda_handler(event, context):
    response = STANDARD_JSON_RESPONSE
    #logger.info(str(event))

    global claims_and_roles
    claims_and_roles = request_to_claims(event)

    # Get the request headers from the API Gateway event
    try:
        request_headers = event['headers']
    except:
        request_headers = ""

    # # Error if no headers provided (API Gateway problem or manual testing error)
    # if not request_headers or request_headers == None or request_headers == "":
    #     message = "No Range Headers Provided"
    #     error_response = {
    #         'statusCode': 400,
    #         'body': json.dumps({"message": message}),
    #         'headers': {
    #             'Access-Control-Allow-Headers': 'Range',
    #         }
    #     }
    #     logger.error(error_response)
    #     return error_response

    # Get the "Range" header from the request headers
    try:
        range_header = request_headers.get('range')
    except:
        range_header = ""

    # # Get the "content-type" header from the request headers
    # try:
    #     content_type_header = request_headers.get('content-type')
    # except:
    #     content_type_header = ""

    # Extract the bucket name and object key from the API Gateway event
    bucket_name = os.environ["ASSET_AUXILIARY_BUCKET_NAME"]

    # Get the object key which comes after the base path of the API Call
    object_key = event['pathParameters']['proxy']  # "/".join(event['rawPath'].strip("/").split('/')[1:])

    # Error if no object key in path
    if not object_key or object_key == None or object_key == "":
        message = "No Auxiliary Preview File Object Key Provided in Path"
        error_response = {
            'statusCode': 400,
            'body': json.dumps({"message": message}),
            'headers': {
                'Access-Control-Allow-Headers': 'Range',
            }
        }
        logger.error(error_response)
        return error_response 
    
    logger.info("Validating parameters")
    (valid, message) = validate({
        'auxiliaryPreviewAssetPathKey': {
            'value': object_key,
            'validator': 'ASSET_AUXILIARYPREVIEW_PATH'
        },
    })
    if not valid:
        logger.error(message)
        response['body'] = json.dumps({"message": message})
        response['statusCode'] = 400
        return response

    # Prepare the S3 GetObject request parameters
    s3_params = {
        'Bucket': bucket_name,
        'Key': object_key
    }

    # Add the "Range" header to the S3 GetObject request if it exists
    if range_header and range_header != None and range_header != "":
        s3_params['Range'] = range_header

    # # Add the "content-type" header to the S3 GetObject request if it exists
    # if content_type_header and content_type_header != None and content_type_header != "":
    #     s3_params['ResponseContentType'] = content_type_header

    #logger.info(s3_params)
        
    #Split object key by path and return the first value (the asset ID)
    asset_id = object_key.split("/")[0]
        
    http_method = "GET"
    operation_allowed_on_asset = False

    asset_object = get_asset_object_from_id(asset_id)
    asset_object.update({"object__type": "asset"})

    logger.info(asset_object)

    for user_name in claims_and_roles["tokens"]:
        casbin_enforcer = CasbinEnforcer(user_name)
        if casbin_enforcer.enforce(f"user::{user_name}", asset_object, http_method) and casbin_enforcer.enforceAPI(event, http_method):
            operation_allowed_on_asset = True
            break

    if operation_allowed_on_asset:
        try:
            # Fetch the file from S3
            response = s3_client.get_object(**s3_params)
            logger.info(response)

            #Validate for malicious content type
            if not validateUnallowedFileExtensionAndContentType(object_key, response['ContentType']):
                message = "Error: Potentially malicious content type detected in asset file"
                error_response = {
                    'statusCode': 400,
                    'body': json.dumps({"message": message}),
                    'headers': {
                        'Access-Control-Allow-Headers': 'Range',
                    }
                }
                logger.error(error_response)
                return error_response

            # Extract the file data
            file_data = response['Body'].read()

            # Prepare the API Gateway response
            api_gateway_response = {
                'statusCode': 200,
                'body': '',
                'headers': {
                        'Access-Control-Allow-Headers': 'Range',
                        'Accept-Ranges': response['ResponseMetadata']['HTTPHeaders']['accept-ranges'],
                        'Content-Type': response['ResponseMetadata']['HTTPHeaders']['content-type'],
                        'Content-Length': response['ResponseMetadata']['HTTPHeaders']['content-length'],
                }
            }

            # Add the "Range" header if returned
            try:
                response_header_range = response['ResponseMetadata']['HTTPHeaders']['content-range']
            except:
                response_header_range = ""

            if response_header_range != None and response_header_range != "":
                api_gateway_response['headers']['Content-Range'] = response_header_range

            # Add the "ContentEncoding" header if returned
            try:
                response_header_content_encoding = response['ResponseMetadata']['HTTPHeaders']['content-encoding']
            except:
                response_header_content_encoding = ""

            if response_header_content_encoding != None and response_header_content_encoding != "":
                api_gateway_response['headers']['Content-Encoding'] = response_header_content_encoding

            #logger.info(logger.info(str(api_gateway_response)))

            # Get the size of the file data in bytes and return error if larger than ~5.9MB (accounting for header space)
            file_size = sys.getsizeof(file_data)
            if file_size > 5.9 * 1024 * 1024:
                # NOTE: 6MB is a hard limit for Lambda functions. API Gateway has a 10MB hard limit.
                message = "Error: Auxiliary Preview File Size Chunk is Larger than ~5.9MB, a AWS service limit. Use a smaller header file Range for auxiliary preview asset streaming retrieval."
                error_response = {
                    'statusCode': 400,
                    'body': json.dumps({"message": message}),
                    'headers': {
                        'Access-Control-Allow-Headers': 'Range',
                    }
                }
                logger.error(error_response)
                return error_response

            # If returned data is binary, return the file contents as a base64 encoded string in the body
            if isinstance(file_data, bytes):
                api_gateway_response['body'] = base64.b64encode(file_data).decode('utf-8')
                api_gateway_response['isBase64Encoded'] = True
                logger.info("Return is Binary so BaseEncode64")
            else:
                # else return as regular string
                api_gateway_response['body'] = file_data.decode('utf-8')

            return api_gateway_response

        except ClientError as e:
            logger.exception(e)
            message = "Error Fetching Auxiliary Preview File from Path Provided"
            error_response = {
                'statusCode': 400,
                'body': json.dumps({"message": message}),
                'headers': {
                    'Access-Control-Allow-Headers': 'Range',
                }
            }
            logger.exception(error_response)
            return error_response
        except Exception as e:
            # If other error occurs, return an error response
            message = "Internal Server Error"
            error_response = {
                'statusCode': 500,
                'body': json.dumps({"message": message}),
                'headers': {
                    'Access-Control-Allow-Headers': 'Range',
                }
            }
            logger.exception(error_response)
            return error_response
    else:
        response['statusCode'] = 403
        response['body'] = json.dumps({"message": "Not Authorized"})
        return response
