# Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0


import boto3
import json
import os
from datetime import datetime
from customLogging.logger import safeLogger
from common.validators import validate

# region Logging
logger = safeLogger(service="InitMetadata")
# endregion

def build_response(http_code, body):
    return {
        "headers": {
            # tell cloudfront and api gateway not to cache the response
            "Cache-Control": "no-cache, no-store",
            "Content-Type": "application/json",
        },
        "statusCode": http_code,
        "body": body,
    }


region = os.environ['AWS_REGION']
dynamodb = boto3.resource('dynamodb', region_name=region)
table = dynamodb.Table(os.environ['METADATA_STORAGE_TABLE_NAME'])


def to_update_expr(record):
    keys = record.keys()
    keys_attr_names = ["#f{n}".format(n=x) for x in range(len(keys))]
    values_attr_names = [":v{n}".format(n=x) for x in range(len(keys))]

    keys_map = {
        k: key for k, key in zip(keys_attr_names, keys)
    }
    values_map = {
        v1: record[v] for v, v1 in zip(keys, values_attr_names)
    }
    expr = "SET " + ", ".join([
        "{f} = {v}".format(f=f, v=v)
        for f, v in zip(keys_attr_names, values_attr_names)
    ])
    return keys_map, values_map, expr


def create_or_update(databaseId, assetId, metadata):
    metadata['_metadata_last_updated'] = datetime.now().isoformat()
    keys_map, values_map, expr = to_update_expr(metadata)
    return table.update_item(
        Key={
            "databaseId": databaseId,
            "assetId": assetId,
        },
        ExpressionAttributeNames=keys_map,
        ExpressionAttributeValues=values_map,
        UpdateExpression=expr,
    )


class ValidationError(Exception):
    def __init__(self, code: int, resp: object) -> None:
        self.code = code
        self.resp = resp


def validate_event(event):
    if "pathParameters" not in event \
            or "assetId" not in event['pathParameters']:
        raise ValidationError(404, {"error": "missing asset ID path parameters"})
    if "pathParameters" not in event \
            or "databaseId" not in event['pathParameters']:
        raise ValidationError(404, {"error": "missing database ID path parameters"})
    logger.info("Validating required parameters")
    
    (valid, message) = validate({
        'databaseId': {
            'value': event['pathParameters']['databaseId'],
            'validator': 'ID'
        },
        'assetId': {
            'value': event['pathParameters']['assetId'],
            'validator': 'ID'
        },
    })

    if not valid:
        logger.error(message)
        raise ValidationError(400, {"message": message})

    if ('queryStringParameters' in event and 'prefix' in event['queryStringParameters']):
        logger.info("Validating optional parameters")
        (valid, message) = validate({
            'assetPath': {
                'value': event['queryStringParameters']['prefix'],
                'validator': 'ASSET_PATH'
            }
        })

        if not valid:
            logger.error(message)
            raise ValidationError(400, {"message": message})

def validate_body(event):

    if "body" not in event:
        raise ValidationError(400, {"error": "missing request body"})

    if isinstance(event['body'], str):
        event['body'] = json.loads(event['body'])
    
    body = event['body']

    for req_field in ["metadata", "version"]:
        if req_field not in body:
            raise ValidationError(400, {
                "error": "{f} field is missing".format(f=req_field)
            })

    if body['version'] == "1":
        for k, v in body['metadata'].items():
            if not isinstance(k, str):
                raise ValidationError(400, {
                    "error":
                        "metadata version 1 requires string keys and values"
                })
            if not isinstance(v, str):
                raise ValidationError(400, {
                    "error":
                        "metadata version 1 requires string keys and values"
                })

    return body
