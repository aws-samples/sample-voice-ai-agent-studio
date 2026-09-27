"""
Lambda handler for Tools API (multi-tenant).

CRUD for tools (webhooks, Lambda, MCP) stored in DynamoDB, scoped per user.
Also lists existing Lambda functions and AgentCore gateways from the AWS account (shared).

Handles:
  GET    /tools            — List user's saved tools (admin: all)
  POST   /tools            — Create a tool (owned by user)
  DELETE /tools/{id}       — Delete a tool (must own or be admin)
  GET    /tools/lambdas    — List Lambda functions from account (shared)
  GET    /tools/gateways   — List AgentCore gateways from account (shared)
"""

import json
import os
import uuid
from datetime import datetime, timezone

import random
import re
import string

import boto3

from auth_utils import get_user_context, check_item_access


def generate_slug_id(name):
    """Generate a human-readable ID: lowercase name, special chars removed, spaces to dashes, plus 5 random chars."""
    slug = name.lower().strip()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)  # remove special characters
    slug = re.sub(r'[\s]+', '-', slug)  # spaces to dashes
    slug = re.sub(r'-+', '-', slug).strip('-')  # collapse multiple dashes
    suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=5))
    return f"{slug}-{suffix}" if slug else suffix

REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
TABLE_NAME = os.environ.get("TOOLS_TABLE_NAME", "voice-agent-poc-tools")

dynamodb = boto3.resource("dynamodb", region_name=REGION)
table = dynamodb.Table(TABLE_NAME)
lambda_client = boto3.client("lambda", region_name=REGION)

CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
}


def handler(event, context):
    """Main Lambda entry point."""
    http_method = event.get("httpMethod", "")
    path = event.get("path", "")
    path_params = event.get("pathParameters") or {}

    if http_method == "OPTIONS":
        return response(200, {})

    # Extract authenticated user context
    user_ctx = get_user_context(event)

    try:
        if http_method == "GET" and path == "/tools":
            return list_tools(user_ctx)
        elif http_method == "POST" and path == "/tools":
            body = json.loads(event.get("body") or "{}")
            return create_tool(body, user_ctx)
        elif http_method == "DELETE" and "id" in path_params:
            return delete_tool(path_params["id"], user_ctx)
        elif http_method == "PUT" and "id" in path_params and "/test" not in path:
            body = json.loads(event.get("body") or "{}")
            return update_tool(path_params["id"], body, user_ctx)
        elif http_method == "POST" and "id" in path_params and path.endswith("/test"):
            body = json.loads(event.get("body") or "{}")
            return test_tool(path_params["id"], body, user_ctx)
        elif http_method == "GET" and path == "/tools/lambdas":
            return list_lambdas()
        elif http_method == "GET" and path == "/tools/gateways":
            return list_gateways()
        elif http_method == "GET" and path.startswith("/tools/gateways/") and path != "/tools/gateways":
            gw_id = path.split("/tools/gateways/")[1].split("/")[0]
            if path.endswith("/call"):
                body = json.loads(event.get("body") or "{}")
                return call_mcp_tool(gw_id, body)
            return get_gateway_detail(gw_id)
        elif http_method == "POST" and path.startswith("/tools/gateways/") and path.endswith("/call"):
            gw_id = path.split("/tools/gateways/")[1].split("/")[0]
            body = json.loads(event.get("body") or "{}")
            return call_mcp_tool(gw_id, body)
        elif http_method == "GET" and path == "/tools/runtimes":
            return list_runtimes()
        else:
            return response(404, {"error": "Not found"})
    except Exception as e:
        print(f"Error: {e}")
        return response(500, {"error": str(e)})


def list_tools(user_ctx):
    """List saved tools — scoped to user unless admin."""
    try:
        if user_ctx["isAdmin"]:
            result = table.scan()
            items = result.get("Items", [])
        else:
            from boto3.dynamodb.conditions import Key
            result = table.query(
                IndexName="userId-index",
                KeyConditionExpression=Key("userId").eq(user_ctx["userId"]),
                ScanIndexForward=False,
            )
            items = result.get("Items", [])
        items.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
        return response(200, items)
    except Exception as e:
        return response(500, {"error": f"Failed to list tools: {str(e)}"})


def create_tool(body, user_ctx):
    """Create a new tool owned by the authenticated user."""
    name = body.get("name", "").strip()
    tool_type = body.get("type", "").strip()

    if not name:
        return response(400, {"error": "name is required"})
    if tool_type not in ("webhook", "lambda", "mcp", "subagent"):
        return response(400, {"error": "type must be webhook, lambda, or mcp"})

    now = datetime.now(timezone.utc).isoformat()
    item = {
        "id": generate_slug_id(name),
        "userId": user_ctx["userId"],
        "name": name,
        "type": tool_type,
        "description": body.get("description", ""),
        "createdAt": now,
        # Webhook fields
        "endpoint": body.get("endpoint", ""),
        "method": body.get("method", "POST"),
        "timeout": body.get("timeout", "30"),
        "headers": body.get("headers", ""),
        "mockResponse": body.get("mockResponse", ""),
        # Lambda fields
        "functionArn": body.get("functionArn", ""),
        # MCP fields
        "gatewayId": body.get("gatewayId", ""),
        # Parameter definitions
        "parameters": body.get("parameters", ""),
    }
    table.put_item(Item=item)
    return response(201, item)


def delete_tool(tool_id, user_ctx):
    """Delete a tool (must own or be admin)."""
    try:
        result = table.get_item(Key={"id": tool_id})
        item = result.get("Item")
        if not item:
            return response(404, {"error": "Tool not found"})

        if not check_item_access(item, user_ctx):
            return response(403, {"error": "Access denied"})

        table.delete_item(Key={"id": tool_id})
        return response(200, {"message": "Deleted", "id": tool_id})
    except Exception as e:
        return response(500, {"error": f"Failed to delete: {str(e)}"})


def update_tool(tool_id, body, user_ctx):
    """Update a tool (must own or be admin)."""
    result = table.get_item(Key={"id": tool_id})
    item = result.get("Item")
    if not item:
        return response(404, {"error": "Tool not found"})

    if not check_item_access(item, user_ctx):
        return response(403, {"error": "Access denied"})

    # Update fields
    for field in ["name", "description", "endpoint", "method", "timeout", "headers", "mockResponse", "functionArn", "gatewayId", "parameters"]:
        if field in body:
            item[field] = body[field]

    # Backfill userId for legacy items
    if not item.get("userId"):
        item["userId"] = user_ctx["userId"]

    table.put_item(Item=item)
    return response(200, item)

def test_tool(tool_id, body, user_ctx):
    """Test a tool by invoking it (must own or be admin)."""
    # Get tool from DB
    result = table.get_item(Key={"id": tool_id})
    item = result.get("Item")
    if not item:
        return response(404, {"error": "Tool not found"})

    if not check_item_access(item, user_ctx):
        return response(403, {"error": "Access denied"})

    tool_type = item.get("type", "")
    test_payload = body.get("payload", "{}")

    if tool_type == "webhook":
        return test_webhook(item, test_payload)
    elif tool_type == "lambda":
        return test_lambda(item, test_payload)
    elif tool_type == "mcp":
        return test_mcp_gateway(item)
    else:
        return response(400, {"error": f"Unknown tool type: {tool_type}"})


def test_mcp_gateway(tool):
    """Test an MCP integration by resolving its gateway and listing tools."""
    import time

    gateway_id = tool.get("gatewayId", "")
    if not gateway_id:
        return response(400, {"error": "No AgentCore gateway configured"})

    started_at = time.time()
    detail_response = get_gateway_detail(gateway_id)
    elapsed_ms = int((time.time() - started_at) * 1000)
    try:
        detail = json.loads(detail_response.get("body") or "{}")
    except (TypeError, json.JSONDecodeError):
        detail = {}

    if detail_response.get("statusCode") != 200:
        return response(200, {
            "result": detail.get("error", "Failed to connect to MCP gateway"),
            "status": "error",
            "statusCode": detail_response.get("statusCode", 500),
            "responseTimeMs": elapsed_ms,
            "request": {"url": gateway_id, "method": "MCP tools/list", "headers": {}, "body": ""},
        })

    tools = detail.get("mcpTools", [])
    note = detail.get("mcpToolsNote", "")
    gateway_status = detail.get("status", "unknown")
    succeeded = bool(tools) and not note
    summary = f"Gateway {gateway_status}; discovered {len(tools)} MCP tool(s)"
    if note:
        summary = f"{summary}. {note}"

    return response(200, {
        "result": summary,
        "status": "success" if succeeded else "error",
        "statusCode": 200,
        "responseTimeMs": elapsed_ms,
        "request": {"url": detail.get("gatewayUrl", gateway_id), "method": "MCP tools/list", "headers": {}, "body": ""},
    })


def test_webhook(tool, payload):
    """Test a webhook tool by calling its endpoint."""
    import urllib.request
    import urllib.error
    import urllib.parse

    endpoint = tool.get("endpoint", "")
    method = tool.get("method", "POST")
    timeout = int(tool.get("timeout", "30"))
    headers_str = tool.get("headers", "")
    mock_response = tool.get("mockResponse", "")
    parameters_str = tool.get("parameters", "")

    # Parse test payload values
    try:
        payload_values = json.loads(payload) if payload else {}
    except json.JSONDecodeError:
        payload_values = {}

    # Parse parameter definitions to route values to correct locations
    param_defs = []
    try:
        param_defs = json.loads(parameters_str) if parameters_str else []
    except json.JSONDecodeError:
        pass

    # Build request parts from parameter definitions
    query_params = {}
    header_params = {}
    body_params = {}
    path_replacements = {}

    if param_defs and isinstance(param_defs, list):
        for p in param_defs:
            name = p.get("name", "")
            location = p.get("in", "body")
            val = payload_values.get(name, "")
            if not val:
                continue
            # If the URL contains {name} as a placeholder, always treat as path regardless of declared location
            if f"{{{name}}}" in endpoint:
                path_replacements[name] = val
            elif location == "query":
                query_params[name] = val
            elif location == "header":
                header_params[name] = val
            elif location == "path":
                path_replacements[name] = val
            else:
                body_params[name] = val
    else:
        # No param defs — check if URL has {placeholders} and try to substitute from payload
        import re
        placeholders = re.findall(r'\{(\w+)\}', endpoint)
        for ph in placeholders:
            if ph in payload_values:
                path_replacements[ph] = payload_values[ph]
        # Remaining values go to body
        body_params = {k: v for k, v in payload_values.items() if k not in path_replacements}

    # Build final URL with path replacements and query params
    final_url = endpoint
    for key, val in path_replacements.items():
        final_url = final_url.replace(f"{{{key}}}", urllib.parse.quote(str(val), safe=''))
    if query_params:
        final_url += ("&" if "?" in final_url else "?") + urllib.parse.urlencode(query_params)

    # Ensure URL doesn't have unencoded spaces or control chars
    final_url = final_url.replace(' ', '%20')

    # Build headers
    headers = {}
    if headers_str:
        try:
            headers = json.loads(headers_str)
        except json.JSONDecodeError:
            pass
    headers.update(header_params)

    # Build body
    body_data = json.dumps(body_params) if body_params else None
    if body_data and "Content-Type" not in headers:
        headers["Content-Type"] = "application/json"

    # Build request info for display
    request_info = {
        "url": final_url,
        "method": method,
        "headers": headers,
        "body": body_data or "",
    }

    # If mock response is set, return it without calling
    if mock_response:
        return response(200, {
            "result": mock_response,
            "status": "mocked",
            "note": "Returned mock response (endpoint not called)",
            "request": request_info,
        })

    if not endpoint:
        return response(400, {"error": "No endpoint URL configured"})

    try:
        import time
        start_time = time.time()

        data = body_data.encode() if body_data and method != "GET" else None

        req = urllib.request.Request(
            url=final_url,
            data=data,
            headers=headers,
            method=method,
        )

        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed_ms = int((time.time() - start_time) * 1000)
            resp_body = resp.read().decode()
            return response(200, {
                "result": resp_body,
                "status": "success",
                "statusCode": resp.status,
                "responseTimeMs": elapsed_ms,
                "request": request_info,
            })
    except urllib.error.HTTPError as e:
        elapsed_ms = int((time.time() - start_time) * 1000)
        return response(200, {
            "result": e.read().decode(),
            "status": "error",
            "statusCode": e.code,
            "responseTimeMs": elapsed_ms,
            "request": request_info,
        })
    except Exception as e:
        return response(200, {
            "result": str(e),
            "status": "error",
            "request": request_info,
        })


def test_lambda(tool, payload):
    """Test a Lambda tool by invoking it."""
    function_arn = tool.get("functionArn", "")
    if not function_arn:
        return response(400, {"error": "No function ARN configured"})

    request_info = {
        "url": function_arn,
        "method": "INVOKE",
        "headers": {},
        "body": payload,
    }

    try:
        import time
        start_time = time.time()

        invoke_response = lambda_client.invoke(
            FunctionName=function_arn,
            InvocationType="RequestResponse",
            Payload=payload.encode(),
        )
        elapsed_ms = int((time.time() - start_time) * 1000)
        resp_payload = invoke_response["Payload"].read().decode()
        status_code = invoke_response.get("StatusCode", 200)
        error = invoke_response.get("FunctionError", "")

        return response(200, {
            "result": resp_payload,
            "status": "error" if error else "success",
            "statusCode": status_code,
            "functionError": error,
            "responseTimeMs": elapsed_ms,
            "request": request_info,
        })
    except Exception as e:
        return response(200, {
            "result": str(e),
            "status": "error",
            "request": request_info,
        })


def list_lambdas():
    """List Lambda functions in the account."""
    try:
        functions = []
        paginator = lambda_client.get_paginator("list_functions")
        for page in paginator.paginate(MaxItems=100):
            for fn in page.get("Functions", []):
                functions.append({
                    "name": fn["FunctionName"],
                    "arn": fn["FunctionArn"],
                    "runtime": fn.get("Runtime", ""),
                    "description": fn.get("Description", ""),
                    "lastModified": fn.get("LastModified", ""),
                })
        return response(200, functions)
    except Exception as e:
        return response(500, {"error": f"Failed to list functions: {str(e)}"})


def list_gateways():
    """List AgentCore gateways in the account."""
    try:
        agentcore = boto3.client("bedrock-agentcore-control", region_name=REGION)
        result = agentcore.list_gateways(maxResults=50)
        gateways = []
        for gw in result.get("items", []):
            gateways.append({
                "id": gw.get("gatewayId", ""),
                "name": gw.get("name", ""),
                "status": gw.get("status", ""),
                "description": gw.get("protocolType", ""),
            })
        return response(200, gateways)
    except Exception as e:
        print(f"Error listing gateways: {e}")
        return response(200, [])


def get_gateway_detail(gateway_id):
    """Get detailed info about a specific AgentCore gateway including protocol config, targets, and MCP tools."""
    try:
        agentcore = boto3.client("bedrock-agentcore-control", region_name=REGION)
        gw = agentcore.get_gateway(gatewayIdentifier=gateway_id)
        mcp_config = gw.get("protocolConfiguration", {}).get("mcp", {})
        gateway_url = gw.get("gatewayUrl", "")

        # Fetch gateway targets
        targets = []
        try:
            targets_resp = agentcore.list_gateway_targets(gatewayIdentifier=gateway_id, maxResults=50)
            for t in targets_resp.get("items", []):
                targets.append({
                    "targetId": t.get("targetId", ""),
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "targetType": t.get("targetType", ""),
                    "status": t.get("status", ""),
                    "listingMode": t.get("listingMode", ""),
                })
        except Exception as te:
            print(f"Error listing gateway targets: {te}")

        # Fetch MCP tools via the gateway's MCP endpoint (only works for IAM-auth gateways)
        mcp_tools = []
        mcp_tools_note = ""
        if gateway_url:
            authorizer_type = gw.get("authorizerType", "")
            if authorizer_type == "CUSTOM_JWT":
                # For CUSTOM_JWT, get a client_credentials token from the gateway's Cognito config
                try:
                    import urllib.request
                    import base64

                    auth_config = gw.get("authorizerConfiguration", {}).get("customJWTAuthorizer", {})
                    discovery_url = auth_config.get("discoveryUrl", "")
                    allowed_clients = auth_config.get("allowedClients", [])

                    if discovery_url and allowed_clients:
                        # Derive token endpoint from discovery URL
                        # discovery_url: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX/.well-known/openid-configuration
                        # We need: https://<domain>.auth.<region>.amazoncognito.com/oauth2/token
                        # Get it from the OIDC discovery document
                        disc_req = urllib.request.Request(discovery_url)
                        with urllib.request.urlopen(disc_req, timeout=5) as disc_resp:
                            disc_data = json.loads(disc_resp.read().decode())
                            token_endpoint = disc_data.get("token_endpoint", "")

                        if token_endpoint and allowed_clients:
                            client_id = allowed_clients[0]
                            # Look up client secret from Cognito
                            cognito = boto3.client("cognito-idp", region_name=REGION)
                            # Extract user pool ID from discovery URL
                            # Format: https://cognito-idp.{region}.amazonaws.com/{poolId}/...
                            pool_id = discovery_url.split("/")[3] if "cognito-idp" in discovery_url else ""
                            if pool_id:
                                client_info = cognito.describe_user_pool_client(UserPoolId=pool_id, ClientId=client_id)
                                client_secret = client_info.get("UserPoolClient", {}).get("ClientSecret", "")
                                scopes = client_info.get("UserPoolClient", {}).get("AllowedOAuthScopes", [])

                                if client_secret and scopes:
                                    # Get token via client_credentials
                                    auth_header = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
                                    token_data = f"grant_type=client_credentials&scope={' '.join(scopes)}".encode()
                                    token_req = urllib.request.Request(
                                        token_endpoint,
                                        data=token_data,
                                        headers={
                                            "Content-Type": "application/x-www-form-urlencoded",
                                            "Authorization": f"Basic {auth_header}",
                                        },
                                        method="POST",
                                    )
                                    with urllib.request.urlopen(token_req, timeout=5) as token_resp:
                                        token_body = json.loads(token_resp.read().decode())
                                        access_token = token_body.get("access_token", "")

                                    if access_token:
                                        # Call tools/list with the obtained token
                                        mcp_endpoint = gateway_url if gateway_url.endswith("/mcp") else f"{gateway_url}/mcp"
                                        mcp_payload = json.dumps({"jsonrpc": "2.0", "id": "list-tools", "method": "tools/list"})
                                        mcp_req = urllib.request.Request(
                                            mcp_endpoint,
                                            data=mcp_payload.encode(),
                                            headers={
                                                "Content-Type": "application/json",
                                                "Authorization": f"Bearer {access_token}",
                                            },
                                            method="POST",
                                        )
                                        with urllib.request.urlopen(mcp_req, timeout=15) as mcp_resp:
                                            mcp_response = json.loads(mcp_resp.read().decode())
                                            tools_result = mcp_response.get("result", {}).get("tools", [])
                                            for tool in tools_result:
                                                mcp_tools.append({
                                                    "name": tool.get("name", ""),
                                                    "description": tool.get("description", ""),
                                                    "inputSchema": tool.get("inputSchema", {}),
                                                })
                                    else:
                                        mcp_tools_note = "Failed to obtain access token from Cognito"
                                else:
                                    mcp_tools_note = "Client credentials or scopes not configured"
                            else:
                                mcp_tools_note = "Could not determine User Pool ID from discovery URL"
                        else:
                            mcp_tools_note = "Could not determine token endpoint"
                    else:
                        mcp_tools_note = "Gateway JWT authorizer missing discovery URL or allowed clients"
                except Exception as mcp_err:
                    print(f"Error fetching MCP tools via client_credentials: {mcp_err}")
                    mcp_tools_note = f"Failed to list tools: {str(mcp_err)}"
            elif authorizer_type in ("AWS_IAM", "NONE"):
                try:
                    from botocore.auth import SigV4Auth
                    from botocore.awsrequest import AWSRequest
                    import urllib.request

                    session = boto3.Session()
                    credentials = session.get_credentials().get_frozen_credentials()
                    mcp_endpoint = gateway_url if gateway_url.endswith("/mcp") else f"{gateway_url}/mcp"
                    mcp_payload = json.dumps({"jsonrpc": "2.0", "id": "list-tools", "method": "tools/list"})

                    aws_request = AWSRequest(method="POST", url=mcp_endpoint, data=mcp_payload, headers={"Content-Type": "application/json"})
                    SigV4Auth(credentials, "bedrock-agentcore", REGION).add_auth(aws_request)

                    req = urllib.request.Request(
                        url=mcp_endpoint,
                        data=mcp_payload.encode(),
                        headers=dict(aws_request.headers),
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        mcp_response = json.loads(resp.read().decode())
                        tools_result = mcp_response.get("result", {}).get("tools", [])
                        for tool in tools_result:
                            mcp_tools.append({
                                "name": tool.get("name", ""),
                                "description": tool.get("description", ""),
                                "inputSchema": tool.get("inputSchema", {}),
                            })
                except Exception as mcp_err:
                    print(f"Error fetching MCP tools: {mcp_err}")
                    mcp_tools_note = f"Failed to list tools: {str(mcp_err)}"
            else:
                mcp_tools_note = f"Unsupported auth type: {authorizer_type}"

        detail = {
            "id": gw.get("gatewayId", ""),
            "name": gw.get("name", ""),
            "status": gw.get("status", ""),
            "description": gw.get("description", ""),
            "protocolType": gw.get("protocolType", ""),
            "gatewayUrl": gateway_url,
            "authorizerType": gw.get("authorizerType", ""),
            "instructions": mcp_config.get("instructions", ""),
            "supportedVersions": mcp_config.get("supportedVersions", []),
            "searchType": mcp_config.get("searchType", ""),
            "targets": targets,
            "mcpTools": mcp_tools,
            "mcpToolsNote": mcp_tools_note,
        }
        return response(200, detail)
    except Exception as e:
        print(f"Error getting gateway detail: {e}")
        return response(500, {"error": f"Failed to get gateway: {str(e)}"})


def call_mcp_tool(gateway_id, body):
    """Call an MCP tool on a gateway using client_credentials auth."""
    import urllib.request
    import base64

    tool_name = body.get("toolName", "")
    arguments = body.get("arguments", {})

    if not tool_name:
        return response(400, {"error": "toolName is required"})

    try:
        agentcore = boto3.client("bedrock-agentcore-control", region_name=REGION)
        gw = agentcore.get_gateway(gatewayIdentifier=gateway_id)
        gateway_url = gw.get("gatewayUrl", "")

        if not gateway_url:
            return response(400, {"error": "Gateway URL not available"})

        # Get token via client_credentials
        auth_config = gw.get("authorizerConfiguration", {}).get("customJWTAuthorizer", {})
        discovery_url = auth_config.get("discoveryUrl", "")
        allowed_clients = auth_config.get("allowedClients", [])
        authorizer_type = gw.get("authorizerType", "")

        headers = {"Content-Type": "application/json"}

        if authorizer_type == "CUSTOM_JWT" and discovery_url and allowed_clients:
            disc_req = urllib.request.Request(discovery_url)
            with urllib.request.urlopen(disc_req, timeout=5) as disc_resp:
                disc_data = json.loads(disc_resp.read().decode())
                token_endpoint = disc_data.get("token_endpoint", "")

            client_id = allowed_clients[0]
            pool_id = discovery_url.split("/")[3] if "cognito-idp" in discovery_url else ""
            cognito = boto3.client("cognito-idp", region_name=REGION)
            client_info = cognito.describe_user_pool_client(UserPoolId=pool_id, ClientId=client_id)
            client_secret = client_info.get("UserPoolClient", {}).get("ClientSecret", "")
            scopes = client_info.get("UserPoolClient", {}).get("AllowedOAuthScopes", [])

            auth_header = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
            token_data = f"grant_type=client_credentials&scope={' '.join(scopes)}".encode()
            token_req = urllib.request.Request(
                token_endpoint,
                data=token_data,
                headers={"Content-Type": "application/x-www-form-urlencoded", "Authorization": f"Basic {auth_header}"},
                method="POST",
            )
            with urllib.request.urlopen(token_req, timeout=5) as token_resp:
                token_body = json.loads(token_resp.read().decode())
                access_token = token_body.get("access_token", "")

            headers["Authorization"] = f"Bearer {access_token}"
        elif authorizer_type in ("AWS_IAM", "NONE"):
            from botocore.auth import SigV4Auth
            from botocore.awsrequest import AWSRequest
            mcp_endpoint = gateway_url if gateway_url.endswith("/mcp") else f"{gateway_url}/mcp"
            mcp_payload = json.dumps({"jsonrpc": "2.0", "id": "call-tool", "method": "tools/call", "params": {"name": tool_name, "arguments": arguments}})
            aws_request = AWSRequest(method="POST", url=mcp_endpoint, data=mcp_payload, headers={"Content-Type": "application/json"})
            session = boto3.Session()
            SigV4Auth(session.get_credentials().get_frozen_credentials(), "bedrock-agentcore", REGION).add_auth(aws_request)
            req = urllib.request.Request(url=mcp_endpoint, data=mcp_payload.encode(), headers=dict(aws_request.headers), method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                mcp_response = json.loads(resp.read().decode())
            return response(200, mcp_response.get("result", {}))

        # Call tools/call via MCP
        mcp_endpoint = gateway_url if gateway_url.endswith("/mcp") else f"{gateway_url}/mcp"
        mcp_payload = json.dumps({
            "jsonrpc": "2.0",
            "id": "call-tool",
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        })
        mcp_req = urllib.request.Request(mcp_endpoint, data=mcp_payload.encode(), headers=headers, method="POST")
        with urllib.request.urlopen(mcp_req, timeout=30) as mcp_resp:
            mcp_response = json.loads(mcp_resp.read().decode())

        if mcp_response.get("error"):
            return response(200, {"content": [{"type": "text", "text": json.dumps(mcp_response["error"])}], "isError": True})

        return response(200, mcp_response.get("result", {}))

    except Exception as e:
        print(f"Error calling MCP tool: {e}")
        return response(500, {"error": f"MCP call failed: {str(e)}"})


def list_runtimes():
    """List AgentCore runtimes (exclude obvious websocket ones) in the account."""
    try:
        agentcore = boto3.client("bedrock-agentcore-control", region_name=REGION)
        result = agentcore.list_agent_runtimes(maxResults=50)
        runtimes = []
        for rt in result.get("items", result.get("agentRuntimes", [])):
            name = rt.get("agentRuntimeName", "").lower()
            rt_id = rt.get("agentRuntimeId", "").lower()
            desc = rt.get("description", "").lower()
            # Filter out websocket/bidi-based runtimes
            ws_keywords = ["websocket", "ws_", "_ws_", "_ws-", "bidi_", "bidi-", "bidirectional"]
            if any(kw in name or kw in rt_id or kw in desc for kw in ws_keywords):
                continue
            runtimes.append({
                "id": rt.get("agentRuntimeId", ""),
                "name": rt.get("agentRuntimeName", rt.get("agentRuntimeId", "")),
                "status": rt.get("status", ""),
                "description": rt.get("description", ""),
            })
        return response(200, runtimes)
    except Exception as e:
        print(f"Error listing runtimes: {e}")
        return response(200, [])


def response(status_code, body):
    """Build an API Gateway response with CORS headers."""
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, default=str),
    }
