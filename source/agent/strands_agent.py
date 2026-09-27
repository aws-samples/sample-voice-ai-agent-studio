"""
Voice Agent Server — Strands BidiAgent with Amazon Nova 2 Sonic

WebSocket server that accepts configuration from the frontend UI and creates
a BidiAgent session with Nova Sonic for real-time bidirectional voice streaming.

Reference: https://github.com/aws-samples/sample-nova-sonic-websocket-agentcore
"""

import logging
import traceback
import os
import json

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from strands.experimental.bidi import BidiAgent

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Environment configuration
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
DEFAULT_MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-2-sonic-v1:0")
# Concrete provider model IDs for the wizard's abstract selections.
OPENAI_REALTIME_MODEL_ID = os.environ.get("OPENAI_REALTIME_MODEL_ID", "gpt-realtime")
GEMINI_LIVE_MODEL_ID = os.environ.get("GEMINI_LIVE_MODEL_ID", "gemini-2.5-flash-native-audio-preview-09-2025")


def create_model(selected_model, api_keys, voice_id, sonic_model_id, params=None):
    """Create the bidirectional model for the selected provider.

    Returns ``(model, output_sample_rate)``. Nova Sonic = 16 kHz;
    OpenAI Realtime and Gemini Live = 24 kHz. Raises ValueError if the selected
    provider's API key is missing (no silent fallback to Nova Sonic).
    """
    from strands.experimental.bidi.models import (
        BedrockNovaSonicModel,
        OpenAIRealtimeModel,
        GoogleGeminiLiveModel,
    )

    params = params or {}
    _extra = {"params": params} if params else {}

    if selected_model == "openai-realtime":
        api_key = (api_keys or {}).get("openai") or os.environ.get("OPENAI_API_KEY", "")
        if not api_key:
            raise ValueError("OpenAI Realtime selected but no OpenAI API key was provided.")
        model = OpenAIRealtimeModel(
            api_key=api_key,
            voice=voice_id or "alloy",
            model_id=OPENAI_REALTIME_MODEL_ID,
            **_extra,
        )
        return model, 24000

    if selected_model == "gemini-live":
        api_key = (api_keys or {}).get("gemini") or os.environ.get("GOOGLE_API_KEY", "")
        if not api_key:
            raise ValueError("Gemini Live selected but no Google API key was provided.")
        model = GoogleGeminiLiveModel(
            client_args={"api_key": api_key},
            voice=voice_id or None,
            audio={"input": {"sample_rate": 16000}},
            model_id=GEMINI_LIVE_MODEL_ID,
            **_extra,
        )
        return model, 24000

    model = BedrockNovaSonicModel(
        region=BEDROCK_REGION,
        model_id=sonic_model_id,
        voice=voice_id,
        audio={
            "input": {"sample_rate": 16000},
            "output": {"sample_rate": 16000},
        },
        **_extra,
    )
    return model, 16000
DEFAULT_VOICE = os.environ.get("VOICE", "tiffany")

# Large-event splitting threshold
MAX_WS_MESSAGE_SIZE = 10000


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

def get_tool_functions(tool_ids: list[str]) -> list:
    """Resolve pre-built tool IDs to implementations. Always includes reserved tools."""
    try:
        from tools import TOOL_REGISTRY, RESERVED_TOOL_IDS
    except ImportError:
        logger.warning("Could not import TOOL_REGISTRY — no tools available")
        return []

    resolved = []
    # Always include reserved tools (endCallTool, transferCall)
    for reserved_id in RESERVED_TOOL_IDS:
        if reserved_id in TOOL_REGISTRY:
            resolved.append(TOOL_REGISTRY[reserved_id])

    # Add any additional requested tools
    for tool_id in tool_ids:
        if tool_id in RESERVED_TOOL_IDS:
            continue  # Already included
        if tool_id in TOOL_REGISTRY:
            resolved.append(TOOL_REGISTRY[tool_id])
        else:
            logger.warning(f"Unknown tool ID: {tool_id} — skipping")
    return resolved


def build_dynamic_tools(custom_tool_specs: list[dict]) -> list:
    """Build callable tool functions from user-defined specs (mock responses)."""
    from strands import tool as strands_tool

    dynamic_tools = []

    for spec in custom_tool_specs:
        name = spec.get("name", "").strip()
        description = spec.get("description", "")
        mock_response = spec.get("mockResponse", "Tool executed successfully.")

        if not name:
            continue

        # Sanitize name to match Bedrock's pattern: ^[a-zA-Z0-9_-]+$
        safe_name = name.replace(" ", "_").replace("-", "_")
        safe_name = ''.join(c for c in safe_name if c.isalnum() or c == '_')
        if not safe_name:
            safe_name = "unnamed_tool"

        # Create a tool function with the Strands @tool decorator
        def make_tool(tool_name, tool_desc, response):
            @strands_tool
            def dynamic_tool(**kwargs) -> str:
                f"""{tool_desc}"""
                logger.info(f"Dynamic tool '{tool_name}' called with: {kwargs}")
                return response

            dynamic_tool.__name__ = tool_name
            dynamic_tool.__doc__ = tool_desc
            return dynamic_tool

        fn = make_tool(safe_name, description, mock_response)
        dynamic_tools.append(fn)
        logger.info(f"Built dynamic tool: {safe_name}")

    return dynamic_tools


def build_integration_tools(integration_ids: list[str], api_url: str = "") -> list:
    """Fetch integration tool configs from the API and build callable Strands tools.

    Integration IDs are prefixed with 'int:' followed by the tool's DynamoDB ID.
    Each tool is resolved to a callable that invokes the webhook/lambda/subagent.
    """
    import urllib.request
    import urllib.error
    from strands import tool as strands_tool

    if not api_url:
        api_url = os.environ.get("API_URL", "")

    if not api_url:
        logger.warning("API_URL not set — cannot resolve integration tools")
        return []

    # Fetch all tools from the API
    try:
        req = urllib.request.Request(f"{api_url}/tools")
        with urllib.request.urlopen(req, timeout=10) as resp:
            all_tools = json.loads(resp.read().decode())
    except Exception as e:
        logger.error(f"Failed to fetch integration tools: {e}")
        return []

    # Build a lookup by ID
    tools_by_id = {t["id"]: t for t in all_tools}

    integration_tools = []
    for int_id in integration_ids:
        # Strip the 'int:' prefix
        tool_id = int_id.replace("int:", "")
        tool_config = tools_by_id.get(tool_id)
        if not tool_config:
            logger.warning(f"Integration tool not found: {tool_id}")
            continue

        tool_type = tool_config.get("type", "")
        tool_name = tool_config.get("name", tool_id).replace("-", "_").replace(" ", "_")
        tool_desc = tool_config.get("description", f"{tool_type} tool: {tool_name}")

        if tool_type == "webhook":
            fn = _make_webhook_tool(tool_name, tool_desc, tool_config)
        elif tool_type == "lambda":
            fn = _make_lambda_tool(tool_name, tool_desc, tool_config)
        elif tool_type == "subagent":
            fn = _make_subagent_tool(tool_name, tool_desc, tool_config)
        elif tool_type == "mcp":
            fn = _make_mock_tool(tool_name, tool_desc, "MCP gateway invocation not yet implemented")
        else:
            fn = _make_mock_tool(tool_name, tool_desc, tool_config.get("mockResponse", "Tool executed."))

        if fn:
            integration_tools.append(fn)
            logger.info(f"Built integration tool: {tool_name} ({tool_type})")

    return integration_tools


def _make_webhook_tool(name, description, config):
    """Create a tool that calls a webhook endpoint."""
    import urllib.request
    import urllib.error
    from strands import tool as strands_tool

    endpoint = config.get("endpoint", "")
    method = config.get("method", "POST")
    timeout = int(config.get("timeout", "30"))
    headers_str = config.get("headers", "")
    mock_response = config.get("mockResponse", "")

    @strands_tool
    def webhook_tool(payload: str = "{}") -> str:
        f"""{description}"""
        # If mock response is set, return it
        if mock_response:
            return mock_response

        if not endpoint:
            return "Error: No endpoint configured for this webhook tool."

        try:
            headers = {}
            if headers_str:
                try:
                    headers = json.loads(headers_str)
                except json.JSONDecodeError:
                    pass
            if "Content-Type" not in headers:
                headers["Content-Type"] = "application/json"

            data = payload.encode() if method != "GET" else None
            req = urllib.request.Request(url=endpoint, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode()
        except Exception as e:
            return f"Webhook call failed: {str(e)}"

    webhook_tool.__name__ = name
    webhook_tool.__doc__ = description
    return webhook_tool


def _make_lambda_tool(name, description, config):
    """Create a tool that invokes a Lambda function.
    
    Sends the tool arguments directly as the Lambda payload (matching
    the MCP server's direct invocation format).
    """
    import boto3 as _boto3
    from strands import tool as strands_tool

    function_arn = config.get("functionArn", "")

    @strands_tool
    def lambda_tool(**kwargs) -> str:
        f"""{description}"""
        if not function_arn:
            return "Error: No function ARN configured."
        try:
            # Send arguments directly — Lambda MCP servers handle both
            # direct arg format and JSON-RPC wrapped format
            client = _boto3.client("lambda")
            payload = json.dumps(kwargs)
            resp = client.invoke(
                FunctionName=function_arn,
                InvocationType="RequestResponse",
                Payload=payload.encode("utf-8"),
            )
            result = resp["Payload"].read().decode("utf-8")
            # Parse the Lambda response to extract tool result
            try:
                parsed = json.loads(result)
                body = parsed.get("body", result)
                if isinstance(body, str):
                    body_json = json.loads(body)
                    # Handle MCP JSON-RPC response format
                    if "result" in body_json:
                        content = body_json["result"].get("content", [])
                        texts = [c.get("text", "") for c in content if c.get("type") == "text"]
                        if texts:
                            return "\n".join(texts)
                    elif "error" in body_json:
                        return f"Tool error: {body_json['error'].get('message', 'Unknown error')}"
                    return body
                return result
            except (json.JSONDecodeError, TypeError):
                return result
        except Exception as e:
            return f"Lambda invocation failed: {str(e)}"

    lambda_tool.__name__ = name
    lambda_tool.__doc__ = description
    return lambda_tool


def _make_subagent_tool(name, description, config):
    """Create a tool that delegates to another AgentCore runtime."""
    from strands import tool as strands_tool

    runtime_id = config.get("gatewayId", "")  # stored in gatewayId field

    @strands_tool
    def subagent_tool(task: str = "") -> str:
        f"""{description}"""
        if not runtime_id:
            return "Error: No runtime ID configured for this sub-agent."
        # For now, return a placeholder — full implementation would invoke the runtime
        return f"Delegated task to sub-agent '{name}' (runtime: {runtime_id}): {task}"

    subagent_tool.__name__ = name
    subagent_tool.__doc__ = description
    return subagent_tool


def _make_mock_tool(name, description, mock_response):
    """Create a tool that returns a mock response."""
    from strands import tool as strands_tool

    @strands_tool
    def mock_tool(**kwargs) -> str:
        f"""{description}"""
        return mock_response

    mock_tool.__name__ = name
    mock_tool.__doc__ = description
    return mock_tool


def build_rag_tools(rag_ids: list[str], api_url: str = "") -> list:
    """Build callable tools for RAG knowledge base queries.

    RAG IDs are prefixed with 'rag:' followed by the knowledge base ID.
    Each creates a tool that queries the knowledge base via the RAG API.
    """
    import urllib.request
    import urllib.error
    from strands import tool as strands_tool

    if not api_url:
        api_url = os.environ.get("API_URL", "")

    if not api_url:
        logger.warning("API_URL not set — cannot resolve RAG tools")
        return []

    # Fetch RAG source metadata to get names/descriptions
    rag_sources = {}
    try:
        req = urllib.request.Request(f"{api_url}/rag")
        with urllib.request.urlopen(req, timeout=10) as resp:
            sources = json.loads(resp.read().decode())
            for src in sources:
                rag_sources[src["id"]] = src
    except Exception as e:
        logger.warning(f"Failed to fetch RAG sources: {e}")

    rag_tools = []
    for rag_ref in rag_ids:
        kb_id = rag_ref.replace("rag:", "")
        source_info = rag_sources.get(kb_id, {})
        kb_name = source_info.get("name", f"knowledge_base_{kb_id[:8]}")
        kb_description = source_info.get("description", "")

        # Sanitize name for use as function name
        func_name = "search_" + "".join(c if c.isalnum() else "_" for c in kb_name.lower()).strip("_")

        tool_description = f"Search the '{kb_name}' knowledge base for relevant information. {kb_description}".strip()

        rag_tool = _make_rag_tool(func_name, tool_description, kb_id, api_url)
        rag_tools.append(rag_tool)
        logger.info(f"RAG tool created: {func_name} (kb={kb_id})")

    return rag_tools


def _make_rag_tool(name, description, kb_id, api_url):
    """Create a tool that queries a RAG knowledge base."""
    import urllib.request
    from strands import tool as strands_tool

    @strands_tool
    def rag_query_tool(question: str) -> str:
        f"""{description}"""
        try:
            payload = json.dumps({"question": question}).encode("utf-8")
            req = urllib.request.Request(
                f"{api_url}/rag/{kb_id}/query",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode())
                answer = result.get("answer", "No answer found.")
                citations = result.get("citations", [])
                if citations:
                    citation_text = "\n".join([f"- {c.get('text', '')}" for c in citations[:3]])
                    return f"{answer}\n\nSources:\n{citation_text}"
                return answer
        except Exception as e:
            return f"Knowledge base query failed: {str(e)}"

    rag_query_tool.__name__ = name
    rag_query_tool.__doc__ = description
    return rag_query_tool


# ---------------------------------------------------------------------------
# Large-event splitting
# ---------------------------------------------------------------------------

def split_large_event(event_dict, max_size=MAX_WS_MESSAGE_SIZE):
    """Split a large event into smaller chunks by dividing the audio field."""
    event_json = json.dumps(event_dict)
    event_size = len(event_json.encode("utf-8"))

    if event_size <= max_size:
        return [event_dict]

    if "audio" not in event_dict or not isinstance(event_dict["audio"], str):
        return [event_dict]

    audio_content = event_dict["audio"]
    template = {k: v for k, v in event_dict.items() if k != "audio"}
    template["audio"] = ""
    overhead = len(json.dumps(template).encode("utf-8"))

    max_content_size = max_size - overhead - 100
    max_content_size = (max_content_size // 4) * 4  # Align to base64

    if max_content_size <= 0:
        return [event_dict]

    chunks = []
    for i in range(0, len(audio_content), max_content_size):
        chunk_audio = audio_content[i:i + max_content_size]
        chunk_event = {k: v for k, v in event_dict.items() if k != "audio"}
        chunk_event["audio"] = chunk_audio
        chunks.append(chunk_event)

    logger.info(f"Split audio event ({event_size} bytes) into {len(chunks)} chunks")
    return chunks


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------

app = FastAPI(title="Voice Agent POC-in-a-Box")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    logger.info("🚀 Starting Nova Sonic Voice Agent server...")
    logger.info(f"📍 Region: {BEDROCK_REGION}")
    logger.info(f"🎙️ Default voice: {DEFAULT_VOICE}")


@app.get("/health")
async def health():
    return {"status": "healthy", "model": DEFAULT_MODEL_ID, "region": BEDROCK_REGION}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket connection established")

    async def chunked_send_json(event_dict):
        """Send output events, splitting large audio payloads."""
        chunks = split_large_event(event_dict)
        for chunk in chunks:
            await websocket.send_json(chunk)

    await handle_websocket_session(websocket, send_output=chunked_send_json)


# ---------------------------------------------------------------------------
# Session Handler
# ---------------------------------------------------------------------------

async def handle_websocket_session(websocket: WebSocket, send_output):
    """Handle a single WebSocket voice session with BidiAgent."""
    call_logger = None
    try:
        # Phase 1: Wait for sessionConfig from frontend
        config = await wait_for_config(websocket)
        logger.info(f"Session configured: {config_summary(config)}")

        # Phase 2: Create BidiAgent from config
        agent, model_sample_rate = create_agent(config)
        logger.info(f"✅ Agent ready: model={config.get('model', [])}, voice={config.get('voice', {}).get('voiceId', DEFAULT_VOICE)}, sample_rate={model_sample_rate}")

        # Phase 2b: Initialize call history logger if enabled
        if config.get("callHistoryEnabled", True) is not False:
            try:
                from call_history_logger import CallHistoryLogger
                call_history_bucket = os.environ.get("CALL_HISTORY_BUCKET", "")
                # Determine source from session config
                source = "webchat"
                if config.get("telephony") or config.get("sipEnabled"):
                    source = "telephony"
                elif config.get("source"):
                    source = config["source"]
                call_logger = CallHistoryLogger(
                    agent_id=config.get("agentId", "unknown"),
                    s3_bucket=call_history_bucket,
                    user_id=config.get("userId", ""),
                    source=source,
                    caller_id=config.get("callerId", ""),
                    input_sample_rate=model_sample_rate,
                    output_sample_rate=model_sample_rate,
                )
                logger.info(f"📝 Call history logging enabled (session={call_logger.session_id}, source={source})")
            except Exception as e:
                logger.warning(f"Call history logger init failed: {e}")
                call_logger = None

        # Wrap send_output to emit tool_call/tool_result events from tool_use_stream
        _pending_tool = {}
        _sonic_completion_id_sent = False

        async def send_output_with_tools(event_dict):
            """Intercept tool_use_stream events and emit tool_call/tool_result."""
            nonlocal _pending_tool, _sonic_completion_id_sent

            if isinstance(event_dict, dict):
                event_type = event_dict.get("type", "")

                # Emit sonic_session_id from the model's completion tracking
                if not _sonic_completion_id_sent and event_type == "bidi_transcript_stream":
                    try:
                        completion_id = getattr(agent._model, "_current_completion_id", None)
                        if completion_id:
                            _sonic_completion_id_sent = True
                            await send_output({
                                "type": "sonic_session_info",
                                "sonic_session_id": completion_id,
                            })
                    except Exception:
                        pass

            if isinstance(event_dict, dict):
                event_type = event_dict.get("type", "")

                if event_type == "tool_use_stream":
                    # BidiAgent is streaming a tool use — extract tool info
                    current_tool_use = event_dict.get("current_tool_use", {})
                    tool_name = current_tool_use.get("name", "")
                    tool_args = current_tool_use.get("input", {})

                    if tool_name and tool_name != _pending_tool.get("name"):
                        # New tool call started — emit tool_call event
                        _pending_tool = {"name": tool_name, "args": tool_args}
                        await send_output({
                            "type": "tool_call",
                            "tool": tool_name,
                            "args": tool_args if len(json.dumps(tool_args, default=str)) < 10000 else {"_truncated": True},
                        })
                        if call_logger:
                            call_logger.log_event("out", "tool_call", tool=tool_name, args=tool_args)
                    return  # Never forward raw tool_use_stream to client (can be >64KB)

                elif "message" in event_dict and "type" not in event_dict:
                    # ToolResultMessageEvent: {"message": {"role": "user", "content": [{"toolResult": {...}}]}}
                    message = event_dict.get("message", {})
                    content = message.get("content", [])
                    for block in content if isinstance(content, list) else []:
                        if isinstance(block, dict) and "toolResult" in block:
                            tr = block["toolResult"]
                            tr_content = tr.get("content", [])
                            texts = [c.get("text", "") for c in tr_content if isinstance(c, dict) and c.get("text")]
                            result_text = "\n".join(texts) if texts else str(tr_content)
                            tool_name = _pending_tool.get("name", "unknown")
                            await send_output({
                                "type": "tool_result",
                                "tool": tool_name,
                                "result": result_text or "(no result)",
                            })
                            if call_logger:
                                call_logger.log_tool_call(tool_name, _pending_tool.get("args"), result_text)
                                call_logger.log_event("out", "tool_result", tool=tool_name, result=result_text[:500])
                            _pending_tool = {}
                    return  # Don't forward raw tool_result_message to client

            # Forward all other events normally
            # Log text/audio output for call history
            if call_logger and isinstance(event_dict, dict):
                evt_type = event_dict.get("type", "")
                if evt_type == "text" and event_dict.get("text"):
                    call_logger.log_assistant_text(event_dict["text"])
                    call_logger.log_event("out", "text_output", text=event_dict["text"][:500])
                elif evt_type == "audio" and event_dict.get("data"):
                    import base64
                    try:
                        audio_bytes = base64.b64decode(event_dict["data"])
                        call_logger.log_audio_chunk(audio_bytes)
                        call_logger.log_event("out", "audio_chunk", size=len(audio_bytes))
                    except Exception:
                        pass
            await send_output(event_dict)

        # Acknowledge. Include the model's output sample rate so the client can
        # play audio back at the correct rate (Nova 16 kHz, OpenAI/Gemini 24 kHz).
        _selected = (config.get("model") or ["nova-2-sonic"])[0]
        await send_output({
            "type": "system",
            "message": f"Ready: {_selected} with voice={config.get('voice', {}).get('voiceId', DEFAULT_VOICE)}",
            "provider": _selected,
            "outputSampleRate": model_sample_rate,
            "inputSampleRate": model_sample_rate,
        })

        # Phase 3: Run bidirectional audio loop
        async def handle_input():
            """Read messages from WebSocket and pass to agent."""
            while True:
                message = await websocket.receive_json()

                if message.get("type") == "sessionEnd":
                    logger.info("Client requested session end")
                    raise WebSocketDisconnect()

                if message.get("type") == "text_input":
                    text = message.get("text", "")
                    logger.info(f"Text input: {text}")
                    if call_logger:
                        call_logger.log_user_text(text)
                        call_logger.log_event("in", "text_input", text=text)
                    # strands 1.57.0 accepts a plain string as a text block.
                    return text

                # Audio input — strands 1.57.0 input contract: an audio_delta dict
                # with RAW audio bytes (base64-decoded).
                if message.get("type") in ("bidi_audio_input", "audio_input"):
                    import base64 as _b64
                    try:
                        _audio_bytes = _b64.b64decode(message.get("audio", ""))
                    except Exception:
                        _audio_bytes = b""
                    return {
                        "audio_delta": {
                            "format": message.get("format", "pcm"),
                            "source": {"bytes": _audio_bytes},
                        }
                    }

                # Unknown message type — skip it and read the next message
                continue

        await agent.run(inputs=[handle_input], outputs=[send_output_with_tools])

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        if "CANCELLED" in str(e):
            logger.warning(f"Cleanup error (ignored): {e}")
        else:
            logger.error(f"Session error: {e}")
            traceback.print_exc()
            try:
                await send_output({"type": "error", "message": str(e)})
            except Exception:
                pass
    finally:
        if call_logger:
            try:
                import asyncio
                await call_logger.finalize(end_reason="session_ended")
            except Exception as e:
                logger.warning(f"Call history finalize error: {e}")
        logger.info("Session closed")


async def wait_for_config(websocket: WebSocket) -> dict:
    """Wait for the client to send a sessionConfig event."""
    while True:
        message = await websocket.receive_json()

        if message.get("type") in ("sessionConfig", "config"):
            return message
        else:
            await websocket.send_json({
                "type": "system",
                "message": "Please send a sessionConfig event first.",
            })


def create_agent(config: dict) -> BidiAgent:
    """Create a BidiAgent from the frontend session config.

    Supports three speech-to-speech models:
    - nova-2-sonic: Amazon Nova 2 Sonic via Bedrock (default, no API key needed)
    - openai-realtime: OpenAI Realtime API (requires an OpenAI API key in config)
    - gemini-live: Google Gemini Live API (requires a Google API key in config)

    Returns ``(agent, output_sample_rate)`` — the sample rate lets the caller
    tell the client which rate to play audio back at.
    """
    voice_config = config.get("voice", {})
    voice_id = voice_config.get("voiceId", DEFAULT_VOICE) or DEFAULT_VOICE
    system_prompt = config.get("systemPrompt", "You are a helpful voice assistant.")
    tool_ids = config.get("tools", [])
    custom_tool_specs = config.get("customTools", [])
    api_keys = config.get("apiKeys", {})
    selected_model = (config.get("model") or ["nova-2-sonic"])[0]
    sonic_model_id = config.get("modelId", DEFAULT_MODEL_ID) or DEFAULT_MODEL_ID

    # Log what was requested
    requested_host = config.get("host", "agentcore")
    requested_framework = config.get("framework", "strands-bidiagent")
    if requested_host != "agentcore" or requested_framework != "strands-bidiagent":
        logger.info(
            f"⚠️ Config requests host={requested_host}, framework={requested_framework} "
            f"— using Strands BidiAgent for demo"
        )

    # Resolve tools
    tools = get_tool_functions(tool_ids)
    dynamic_tools = build_dynamic_tools(custom_tool_specs)
    tools.extend(dynamic_tools)

    # Resolve integration tools (webhooks, lambdas, sub-agents from the tools API)
    integration_ids = [tid for tid in tool_ids if tid.startswith("int:")]
    if integration_ids:
        api_url = os.environ.get("API_URL", "")
        integration_tools = build_integration_tools(integration_ids, api_url)
        tools.extend(integration_tools)
        logger.info(f"Integration tools loaded: {len(integration_tools)}")

    # Resolve RAG knowledge base tools
    rag_ids = [tid for tid in tool_ids if tid.startswith("rag:")]
    if rag_ids:
        api_url = os.environ.get("API_URL", "")
        rag_tools = build_rag_tools(rag_ids, api_url)
        tools.extend(rag_tools)
        logger.info(f"RAG tools loaded: {len(rag_tools)}")

    logger.info(f"Tools loaded: {len(tools)} total")

    # Create the model for the selected provider (Nova Sonic / OpenAI / Gemini).
    model, model_sample_rate = create_model(
        selected_model=selected_model,
        api_keys=api_keys,
        voice_id=voice_id,
        sonic_model_id=sonic_model_id,
    )
    logger.info(f"Model created: provider={selected_model}, output_sample_rate={model_sample_rate}")

    agent = BidiAgent(
        model=model,
        tools=tools if tools else [],
        system_prompt=system_prompt,
    )

    return agent, model_sample_rate


def config_summary(config: dict) -> dict:
    """Sanitized summary for logging."""
    return {
        "client_id": config.get("clientId", ""),
        "host": config.get("host", "agentcore"),
        "framework": config.get("framework", "strands-bidiagent"),
        "model": config.get("model", []),
        "pipeline": config.get("pipeline"),
        "voice_id": config.get("voice", {}).get("voiceId", ""),
        "language": config.get("voice", {}).get("language", ""),
        "tools": config.get("tools", []),
        "custom_tools_count": len(config.get("customTools", [])),
        "has_greeting": bool(config.get("greeting")),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8081))
    uvicorn.run(app, host="0.0.0.0", port=port)
