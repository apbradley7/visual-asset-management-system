#  Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0

import os
import boto3
import json

from botocore.exceptions import ClientError
from handlers.auth import request_to_claims
from common.constants import STANDARD_JSON_RESPONSE
from common.validators import validate
from handlers.authz import CasbinEnforcer
from common.dynamodb import get_asset_object_from_id
from customLogging.logger import safeLogger
from common.dynamodb import validate_pagination_info
from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeDeserializer

claims_and_roles = {}
logger = safeLogger(service="SubscriptionService")

dynamodb = boto3.resource('dynamodb')
dynamodb_client = boto3.client('dynamodb')
sns_client = boto3.client('sns')

main_rest_response = STANDARD_JSON_RESPONSE

try:
    subscription_table_name = os.environ["SUBSCRIPTIONS_STORAGE_TABLE_NAME"]
    asset_table_name = os.environ["ASSET_STORAGE_TABLE_NAME"]
except:
    logger.exception("Failed loading environment variables")
    main_rest_response['body'] = json.dumps(
        {"message": "Failed Loading Environment Variables"})


def get_name_for_asset_ids(asset_ids):
    #TODO: Implement paginiation but should be auto-limited by the amount of records (implementing pagination) returned by the function calling this
    if not asset_ids:
        return {}
    # TODO: Check if we can optimize this further
    filter_expression = " OR ".join([f"assetId = :id{i}" for i, asset_id in enumerate(asset_ids, 1)])

    expression_attribute_values = {f":id{i}": {"S": asset_id} for i, asset_id in enumerate(asset_ids, 1)}

    items = dynamodb_client.scan(
        TableName=asset_table_name,
        ProjectionExpression='assetId, assetName, databaseId',
        FilterExpression=filter_expression,
        ExpressionAttributeValues=expression_attribute_values,
    )
    return {item['assetId']['S']: {"assetName": item['assetName']['S'], "databaseId": item['databaseId']['S']} for item in items.get("Items", [])}


def get_subscriptions(query_params):
    response = STANDARD_JSON_RESPONSE
    deserializer = TypeDeserializer()
    paginator = dynamodb_client.get_paginator('scan')

    page_iterator = paginator.paginate(
        TableName=subscription_table_name,
        PaginationConfig={
            'MaxItems': int(query_params['maxItems']),
            'PageSize': int(query_params['pageSize']),
            'StartingToken': query_params['startingToken']
        }
    ).build_full_result()

    output_objects = []
    unique_asset_entity_ids = set()
    for obj in page_iterator.get('Items', []):
        deserialized_document = {k: deserializer.deserialize(v) for k, v in obj.items()}
        entity_name, entity_id = deserialized_document["entityName_entityId"].split("#")
        output_obj = {
            "eventName": deserialized_document["eventName"],
            "entityName": entity_name,
            "entityId": entity_id,
            "subscribers": deserialized_document["subscribers"]
        }

        # Add Casbin Enforcer to check if the user has access to GET subscription of specific Assets
        asset_object = get_asset_object_from_id(entity_id)
        asset_object.update({"object__type": "asset"})
        for user_name in claims_and_roles["tokens"]:
            casbin_enforcer = CasbinEnforcer(user_name)
            if casbin_enforcer.enforce(f"user::{user_name}", asset_object, "GET"):
                output_objects.append(output_obj)
                if entity_name == "Asset":
                    unique_asset_entity_ids.add(entity_id)

    result = {
        "Items": []
    }

    assets_with_name = get_name_for_asset_ids(list(unique_asset_entity_ids))
    result["Items"] = [
        {
            "eventName": obj["eventName"],
            "entityName": obj["entityName"],
            "entityId": obj["entityId"],
            "subscribers": obj["subscribers"],
            "entityValue": assets_with_name[obj["entityId"]]["assetName"] if obj["entityId"] in assets_with_name else None,
            "databaseId": assets_with_name[obj["entityId"]]["databaseId"] if obj["entityId"] in assets_with_name else None
        }
        for obj in output_objects
    ]

    if 'NextToken' in page_iterator:
        result['NextToken'] = page_iterator['NextToken']

    response['statusCode'] = 200
    response['body'] = json.dumps({"message": result})
    return response


def create_sns_topic(asset_id):
    topic_response = sns_client.create_topic(Name=f'AssetTopic-{asset_id}')
    return topic_response['TopicArn']


def add_sns_topic_in_asset(asset_id, database_id, sns_topic):
    asset_table = dynamodb.Table(asset_table_name)
    resp = asset_table.query(
        KeyConditionExpression='assetId = :asset_id AND databaseId = :databaseId',
        ExpressionAttributeValues={':asset_id': asset_id, ':databaseId': database_id}
    )
    items = resp.get('Items', [])
    if not items:
        logger.error(f"No asset found - {asset_id}.")
        return

    asset_table.update_item(
        Key={'databaseId': database_id, 'assetId': asset_id},
        UpdateExpression='SET snsTopic = :sns_topic',
        ExpressionAttributeValues={':sns_topic': sns_topic}
    )


def get_asset(asset_id):
    resp = dynamodb_client.scan(
        TableName=asset_table_name,
        ProjectionExpression='snsTopic, databaseId',
        FilterExpression='assetId = :asset_id',
        ExpressionAttributeValues={':asset_id': {'S': asset_id}},
    )

    items = resp.get('Items')
    if items:
        asset_obj = {"databaseId": items[0].get('databaseId').get("S")}
        if items[0].get('snsTopic'):
            asset_obj["snsTopic"] = items[0].get('snsTopic').get("S")
        return asset_obj
    return None


def delete_sns_subscriptions(asset_id, subscribers, delete_sns=False):
    asset_table = dynamodb.Table(asset_table_name)
    asset_obj = get_asset(asset_id)

    if not asset_obj.get("snsTopic"):
        logger.error(f"No topic found for asset {asset_id}")
        return

    resp = sns_client.list_subscriptions_by_topic(TopicArn=asset_obj.get("snsTopic"))
    subscription_arns = [subscription['SubscriptionArn'] for subscription in resp['Subscriptions'] if subscription['Endpoint'] in subscribers]

    for subscription_arn in subscription_arns:
        if subscription_arn != "PendingConfirmation":
            sns_client.unsubscribe(SubscriptionArn=subscription_arn)

    if delete_sns:
        sns_client.delete_topic(TopicArn=asset_obj.get("snsTopic"))
        asset_table.update_item(
            Key={'databaseId': asset_obj["databaseId"], 'assetId': asset_id},
            UpdateExpression=f"REMOVE snsTopic"
        )


def create_sns_subscriptions(asset_id, subscribers):
    asset_obj = get_asset(asset_id)
    asset_sns_topic = asset_obj.get("snsTopic")

    if not asset_sns_topic:
        asset_sns_topic = create_sns_topic(asset_id)
        add_sns_topic_in_asset(asset_id, asset_obj["databaseId"], asset_sns_topic)

    for subscriber in subscribers:
        sns_client.subscribe(
            TopicArn=asset_sns_topic,
            Protocol='email',
            Endpoint=f'{subscriber}'
        )


def get_subscription_obj(event_name, entity_name, entity_id):
    resp = dynamodb_client.get_item(
        TableName=subscription_table_name,
        Key={
            'eventName': {'S': event_name},
            'entityName_entityId': {'S': f'{entity_name}#{entity_id}'}
        }
    )
    return resp.get('Item')


def create_subscription(body):
    response = STANDARD_JSON_RESPONSE
    subscription_table = dynamodb.Table(subscription_table_name)
    items = get_subscription_obj(body["eventName"], body["entityName"], body["entityId"])

    if not items:
        subscription_table.put_item(
            Item={
                'eventName': body["eventName"],
                'entityName_entityId': f'{body["entityName"]}#{body["entityId"]}',
                'subscribers': body["subscribers"]
            }
        )

        if body["entityName"] == "Asset":
            logger.info("creating subscription")
            create_sns_subscriptions(body["entityId"], body["subscribers"])

    else:
        existing_subscribers = [item["S"] for item in items["subscribers"]['L']]
        if any(new_subscriber in existing_subscribers for new_subscriber in body["subscribers"]):
            response['statusCode'] = 400
            response['body'] = json.dumps({"message": f'Subscription already exists for eventName-{body["eventName"]} for {body["entityName"]} - {body["entityId"]} for some of the subscribers.'})
            return response
        else:
            if body["entityName"] == "Asset":
                create_sns_subscriptions(body["entityId"], body["subscribers"])

            subscription_table.update_item(
                Key={
                    'eventName': body["eventName"],
                    'entityName_entityId': f'{body["entityName"]}#{body["entityId"]}'
                },
                UpdateExpression='SET subscribers = :subscribers',
                ExpressionAttributeValues={
                    ':subscribers': existing_subscribers + body["subscribers"]
                }
            )

    response['statusCode'] = 200
    response['body'] = json.dumps({"message": "success"})
    return response


def update_subscription(body):
    response = STANDARD_JSON_RESPONSE
    subscription_table = dynamodb.Table(subscription_table_name)
    items = get_subscription_obj(body["eventName"], body["entityName"], body["entityId"])

    if not items:
        response['statusCode'] = 400
        response['body'] = json.dumps({"message": "Subscription does not exists for eventName."})
        return response

    existing_subscribers = [item["S"] for item in items["subscribers"]['L']]
    new_subscribers = body["subscribers"]
    deleted_subscribers = set(existing_subscribers) - set(new_subscribers)
    added_subscribers = set(new_subscribers) - set(existing_subscribers)

    subscription_table.update_item(
        Key={
            'eventName': body["eventName"],
            'entityName_entityId': f'{body["entityName"]}#{body["entityId"]}'
        },
        UpdateExpression='SET subscribers = :subscribers',
        ExpressionAttributeValues={
            ':subscribers': body["subscribers"]
        }
    )

    if body["entityName"] == "Asset":
        create_sns_subscriptions(body["entityId"], list(added_subscribers))
        delete_sns_subscriptions(body["entityId"], list(deleted_subscribers), delete_sns=False)

    response['statusCode'] = 200
    response['body'] = json.dumps({"message": "success"})
    return response


def delete_subscription(body):
    response = STANDARD_JSON_RESPONSE
    subscription_table = dynamodb.Table(subscription_table_name)
    try:
        subscription_table.delete_item(
            Key={
                'eventName': body["eventName"],
                'entityName_entityId': f'{body["entityName"]}#{body["entityId"]}'
            },
            ConditionExpression='attribute_exists(eventName) AND attribute_exists(entityName_entityId)'
        )
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            response['statusCode'] = 400
            response['body'] = json.dumps({"message": f'Subscription not found for Event: {body["eventName"]}, Entity: {body["entityName"]}, EntityId: {body["entityId"]}'})
        else:
            response['statusCode'] = 500
            response['body'] = json.dumps({"message": "An unexpected error occurred while executing the request"})
        return response

    if body["entityName"] == "Asset":
        delete_sns_subscriptions(body["entityId"], body["subscribers"], delete_sns=True)

    response['statusCode'] = 200
    response['body'] = json.dumps({"message": "success"})
    return response


def lambda_handler(event, context):
    response = STANDARD_JSON_RESPONSE
    try:
        httpMethod = event['requestContext']['http']['method']

        global claims_and_roles
        claims_and_roles = request_to_claims(event)

        queryParameters = event.get('queryStringParameters', {})
        validate_pagination_info(queryParameters)

        method_allowed_on_api = False
        for user_name in claims_and_roles["tokens"]:
            casbin_enforcer = CasbinEnforcer(user_name)
            if casbin_enforcer.enforceAPI(event):
                method_allowed_on_api = True

        if not method_allowed_on_api:
            response['statusCode'] = 403
            response['body'] = json.dumps({"message": "Not Authorized"})
            return response

        #Handle GET request
        if httpMethod == 'GET':
            return get_subscriptions(queryParameters)

        #Expect body from this point forward and non-GET requests
        if isinstance(event['body'], str):
            event['body'] = json.loads(event['body'])

        if not event['body'].get("eventName") or not event['body'].get("entityName") or not event['body'].get("entityId") or not event['body'].get("subscribers"):
            message = "eventName, entityName and entityId are required fields."
            response['statusCode'] = 400
            response['body'] = json.dumps({"message": message})
            return response

        (valid, message) = validate({
            'eventName': {
                'value': event['body']['eventName'],
                'validator': 'OBJECT_NAME'
            },
            'entityName': {
                'value': event['body']['entityName'],
                'validator': 'OBJECT_NAME'
            },
            'entityId': {
                'value': event['body']['entityId'],
                'validator': 'ID'
            },
            'subscribers': {
                'value': event['body']['subscribers'],
                'validator': 'EMAIL_ARRAY'
            }
        })

        if not valid:
            response['body'] = json.dumps({"message": message})
            response['statusCode'] = 400
            return response

        if event['body']["entityName"] == "Asset":
            allowed = False
            asset_object = get_asset_object_from_id(event['body']["entityId"])
            asset_object.update({"object__type": "asset"})

            for user_name in claims_and_roles["tokens"]:
                #This is a POST on asset as we are technically only modifying the asset for subscriptions (even a delete subscription)
                casbin_enforcer = CasbinEnforcer(user_name)
                if casbin_enforcer.enforce(f"user::{user_name}", asset_object, "POST"):
                    allowed = True

            if allowed and httpMethod == 'POST':
                return create_subscription(event['body'])
            elif allowed and httpMethod == 'PUT':
                return update_subscription(event['body'])
            elif allowed and httpMethod == 'DELETE':
                return delete_subscription(event['body'])
            else:
                response['statusCode'] = 403
                response['body'] = json.dumps({"message": "Not Authorized"})
                return response
        else:
            response['statusCode'] = 400
            response['body'] = json.dumps({"message": "EntityName provided not supported for subscriptions"})
            return response
    except Exception as e:
        logger.exception(e)
        response['statusCode'] = 500
        response['body'] = json.dumps({"message": "Internal Server Error"})
        return response

