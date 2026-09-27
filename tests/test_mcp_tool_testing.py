import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
sys.path.insert(0, str(Path(__file__).parents[1] / "source" / "api"))

import tools_handler


def api_response(status_code, body):
    return {"statusCode": status_code, "body": json.dumps(body)}


class McpToolTestingTests(unittest.TestCase):
    def test_missing_gateway_is_rejected(self):
        result = tools_handler.test_mcp_gateway({})

        self.assertEqual(result["statusCode"], 400)
        self.assertIn("No AgentCore gateway", result["body"])

    @patch("tools_handler.get_gateway_detail")
    def test_success_reports_discovered_tools(self, get_gateway_detail):
        get_gateway_detail.return_value = api_response(200, {
            "gatewayUrl": "https://example.test/mcp",
            "status": "READY",
            "mcpTools": [{"name": "lookup"}, {"name": "create"}],
            "mcpToolsNote": "",
        })

        result = tools_handler.test_mcp_gateway({"gatewayId": "gateway-123"})
        body = json.loads(result["body"])

        self.assertEqual(body["status"], "success")
        self.assertIn("discovered 2 MCP tool(s)", body["result"])
        self.assertEqual(body["request"]["method"], "MCP tools/list")

    @patch("tools_handler.get_gateway_detail")
    def test_gateway_error_is_returned_as_test_result(self, get_gateway_detail):
        get_gateway_detail.return_value = api_response(500, {"error": "unavailable"})

        result = tools_handler.test_mcp_gateway({"gatewayId": "gateway-123"})
        body = json.loads(result["body"])

        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(body["status"], "error")
        self.assertEqual(body["result"], "unavailable")


if __name__ == "__main__":
    unittest.main()
