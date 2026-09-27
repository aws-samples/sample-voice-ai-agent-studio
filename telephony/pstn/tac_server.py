"""
Telephony Bridge — Raw Audio Streaming (Twilio ↔ AgentCore/BidiAgent)

Streams raw audio between Twilio Media Streams and AgentCore BidiAgent.
No Twilio AI — Nova Sonic on AgentCore handles STT + TTS natively.

Audio conversion:
  Twilio → mulaw 8kHz → Bridge → PCM 16kHz → AgentCore (BidiAgent/Nova Sonic)
  AgentCore → PCM 24kHz → Bridge → mulaw 8kHz → Twilio
"""

import asyncio
import base64
import json
import logging
import os
import urllib.parse
import xml.sax.saxutils

import boto3
import uvicorn
import websockets
from botocore.auth import SigV4QueryAuth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import Response

from audio import mulaw_8k_to_pcm, pcm_to_mulaw_8k

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _load_config() -> dict:
    """Load bridge configuration.

    If CONFIG_SECRET_NAME is set, fetch a JSON config from AWS Secrets Manager
    and use it as the source of truth (this is how the configure.sh setup stores
    it — no secrets on disk). Otherwise fall back to environment variables, which
    keeps local development working with no AWS dependency.
    """
    secret_id = os.environ.get("CONFIG_SECRET_NAME", "")
    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
    if not secret_id:
        return {}
    try:
        sm = boto3.client("secretsmanager", region_name=region)
        config_json = sm.get_secret_value(SecretId=secret_id).get("SecretString", "{}")
        cfg = json.loads(config_json)
        # Log only the secret's identifier (name/ARN), never its value.
        logger.info("Loaded bridge configuration from Secrets Manager id=%s", secret_id)
        return cfg if isinstance(cfg, dict) else {}
    except Exception as e:  # pragma: no cover - startup diagnostics
        # Only the identifier and the error are logged, not the secret contents.
        logger.error("Failed to load config from Secrets Manager id=%s: %s", secret_id, e)
        return {}


_CONFIG = _load_config()


def _cfg(key: str, default: str = "") -> str:
    """Config lookup: Secrets Manager value first, then env var, then default."""
    return _CONFIG.get(key) or os.environ.get(key, default)


AGENTCORE_RUNTIME_ARN = _cfg("AGENTCORE_RUNTIME_ARN", "")
AWS_REGION = _cfg("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
DEFAULT_VOICE = _cfg("DEFAULT_VOICE", "tiffany")
DEFAULT_SYSTEM_PROMPT = _cfg(
    "DEFAULT_SYSTEM_PROMPT",
    "You are a helpful voice assistant. Keep responses concise and conversational.",
)

app = FastAPI(title="Voice Agent Telephony Bridge")


DEMOS_TABLE_NAME = _cfg("DEMOS_TABLE_NAME", "voice-agent-poc-demos")
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)

# In-memory cache of demo configs (populated when DTMF menu is built)
_demo_cache: dict = {}
# Active demo selection per phone number (set by /connect, read by /media-stream)
_active_demo: dict = {}
# Pre-warmed AgentCore connections (started during DTMF menu, used by /media-stream)
_warm_connections: dict = {}  # key: phone_number, value: websockets connection


def get_demos_for_phone(phone_number: str) -> list:
    """Get all demos with telephonyEnabled that match this phone number. Caches results."""
    table = dynamodb.Table(DEMOS_TABLE_NAME)
    result = table.scan()
    items = result.get("Items", [])

    def normalize(p):
        return (p or "").strip().replace(" ", "").replace("-", "").replace("+", "")

    normalized_called = normalize(phone_number)

    matching = []
    for item in items:
        config = item.get("config", {})
        if config.get("telephonyEnabled"):
            tel = config.get("telephony", {})
            demo_phone = normalize(tel.get("phoneNumber", ""))
            if demo_phone == normalized_called or not demo_phone:
                matching.append(item)
                # Cache the config by demo ID
                _demo_cache[item["id"]] = item

    matching.sort(key=lambda x: x.get("updatedAt", ""), reverse=True)
    return matching


@app.post("/twiml")
@app.get("/twiml")
async def twiml_webhook(request: Request):
    """Return TwiML with DTMF menu of available demos, or connect directly if only one."""
    host = request.headers.get("host", "localhost")
    called, caller = "", ""
    if request.method == "POST":
        try:
            form_data = await request.form()
            called = form_data.get("Called", form_data.get("To", ""))
            caller = form_data.get("Caller", form_data.get("From", ""))
        except Exception:
            pass
    if not called:
        called = request.query_params.get("Called", "")
    if not caller:
        caller = request.query_params.get("Caller", "")

    logger.info(f"Incoming call: {caller} → {called}")

    # Look up demos for this phone number
    demos = get_demos_for_phone(called)

    if len(demos) == 0:
        # No demos configured — connect with defaults
        ws_url = f"wss://{host}/media-stream?called={urllib.parse.quote(called or '')}&amp;caller={urllib.parse.quote(caller or '')}"
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{ws_url}">
      <Parameter name="called" value="{called or ''}" />
      <Parameter name="caller" value="{caller or ''}" />
    </Stream>
  </Connect>
  <Pause length="120"/>
</Response>"""

    elif len(demos) == 1:
        # Single demo — connect directly
        demo_id = demos[0]["id"]
        ws_url = f"wss://{host}/media-stream?demoId={demo_id}&amp;called={urllib.parse.quote(called or '')}&amp;caller={urllib.parse.quote(caller or '')}"
        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{ws_url}">
      <Parameter name="demoId" value="{demo_id}" />
    </Stream>
  </Connect>
  <Pause length="120"/>
</Response>"""

    else:
        # Multiple demos — present DTMF menu
        connect_url = f"https://{host}/connect?called={urllib.parse.quote(called or '')}&amp;caller={urllib.parse.quote(caller or '')}"
        say_options = "Welcome to Voice AI POC. Please select a demo. "
        for i, demo in enumerate(demos[:9], 1):  # Max 9 options
            name = xml.sax.saxutils.escape(demo.get("name", f"Demo {i}"))
            say_options += f"Press {i} for {name}. "

        twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" action="{connect_url}" method="POST" numDigits="1" timeout="10">
    <Say voice="Polly.Joanna">{say_options}</Say>
  </Gather>
  <Say voice="Polly.Joanna">No selection made. Connecting to the most recent demo.</Say>
  <Connect>
    <Stream url="wss://{host}/media-stream?demoId={demos[0]['id']}&amp;called={urllib.parse.quote(called or '')}&amp;caller={urllib.parse.quote(caller or '')}">
      <Parameter name="demoId" value="{demos[0]['id']}" />
    </Stream>
  </Connect>
  <Pause length="120"/>
</Response>"""

    return Response(content=twiml, media_type="application/xml")


@app.post("/connect")
async def connect_demo(request: Request):
    """Handle DTMF selection — connect to the chosen demo."""
    host = request.headers.get("host", "localhost")
    called = request.query_params.get("called", "")
    caller = request.query_params.get("caller", "")

    digit = ""
    if request.method == "POST":
        try:
            form_data = await request.form()
            digit = form_data.get("Digits", "")
        except Exception:
            pass

    logger.info(f"DTMF selection: {digit}")

    demos = get_demos_for_phone(called)
    idx = int(digit) - 1 if digit.isdigit() else 0
    idx = max(0, min(idx, len(demos) - 1))

    demo_id = demos[idx]["id"] if demos else ""
    demo_name = demos[idx].get("name", "Demo") if demos else "Default"

    # Store active selection for this phone number
    if called:
        _active_demo[called] = demo_id

    # Pre-warm disabled — connect only when call media starts (saves cost)
    # asyncio.create_task(_prewarm_with_config(demo_id))

    ws_url = f"wss://{host}/media-stream?demoId={demo_id}&amp;called={urllib.parse.quote(called or '')}&amp;caller={urllib.parse.quote(caller or '')}"

    twiml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="{ws_url}">
      <Parameter name="demoId" value="{demo_id}" />
    </Stream>
  </Connect>
  <Pause length="120"/>
</Response>"""
    return Response(content=twiml, media_type="application/xml")


async def _prewarm_agentcore(called: str):
    """Pre-warm AgentCore connection in background during DTMF menu."""
    try:
        url = await generate_presigned_ws_url()
        ws = await websockets.connect(url)
        _warm_connections["latest"] = (ws, {})
        logger.info("AgentCore pre-warmed")
    except Exception as e:
        logger.warning(f"Pre-warm failed (non-fatal): {e}")


async def _prewarm_with_config(demo_id: str):
    """Pre-warm AgentCore and send session config so it's fully ready."""
    try:
        # Load config
        item = _demo_cache.get(demo_id, {})
        config = item.get("config", {})
        voice_id = config.get("voice", {}).get("voiceId", DEFAULT_VOICE) or DEFAULT_VOICE
        agent_start_first = config.get("agentStartFirst", True)
        greeting = config.get("greeting", "")
        tools = config.get("tools", [])
        custom_tools = config.get("customTools", [])
        reasoner_model = config.get("reasonerModel", "")
        use_mock = config.get("useMock", True)
        inference_config = config.get("inferenceConfig", {}) if isinstance(config.get("inferenceConfig"), dict) else {}
        selected_model = (config.get("model") or ["nova-2-sonic"])[0]
        prompt_parts = []
        if config.get("systemPrompt"):
            prompt_parts.append(config["systemPrompt"])
        if greeting:
            prompt_parts.append(f"Greet the caller with: {greeting}")
        system_prompt = "\n".join(prompt_parts) if prompt_parts else DEFAULT_SYSTEM_PROMPT

        # Connect and send session config
        url = await generate_presigned_ws_url()
        ws = await websockets.connect(url)
        await ws.send(json.dumps({
            "type": "sessionConfig",
            "clientId": f"twilio-{demo_id}",
            "host": "agentcore",
            "framework": "strands-bidiagent",
            "model": [selected_model],
            "apiKeys": {
                key: value for key, value in {
                    "openai": _cfg("OPENAI_API_KEY"),
                    "gemini": _cfg("GOOGLE_API_KEY"),
                }.items() if value
            },
            "systemPrompt": system_prompt,
            "tools": tools,
            "customTools": custom_tools,
            "voice": {"voiceId": voice_id},
            "agentStartFirst": agent_start_first,
            "greeting": greeting or "Hello! How can I help you today?",
            "reasonerModel": reasoner_model,
            "useMock": use_mock,
            "inferenceConfig": inference_config,
            "agentId": demo_id or "telephony-default",
            "callHistoryEnabled": True,
            "source": "telephony",
        }))
        # Wait for ready
        ready = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
        _warm_connections["latest"] = (ws, ready)
        logger.info(f"AgentCore pre-warmed with config: {item.get('name', demo_id)}")
    except Exception as e:
        logger.warning(f"Pre-warm with config failed (non-fatal): {e}")


@app.websocket("/media-stream")
async def media_stream(websocket: WebSocket):
    """Bridge raw audio between Twilio and AgentCore BidiAgent."""
    await websocket.accept()
    logger.info("Twilio Media Stream connected")

    stream_sid = None
    agentcore_ws = None

    # Get demo config — try query params, then active selection cache
    demo_id = websocket.query_params.get("demoId", "")
    called = websocket.query_params.get("called", "")
    caller = websocket.query_params.get("caller", "")

    # If no demoId from params, check active selection (set by /connect DTMF handler)
    if not demo_id:
        # Try all known called numbers in the active demo map
        for phone, did in _active_demo.items():
            demo_id = did
            break  # Use most recent selection

    logger.info(f"WebSocket params: demoId={demo_id}, called={called}, caller={caller}")

    # Load demo config from cache or DynamoDB
    voice_id = DEFAULT_VOICE
    system_prompt = DEFAULT_SYSTEM_PROMPT
    agent_start_first = True
    greeting = ""
    tools = []
    custom_tools = []
    reasoner_model = ""
    use_mock = True
    inference_config = {}
    selected_model = "nova-2-sonic"

    def load_demo_config():
        nonlocal voice_id, system_prompt, agent_start_first, greeting, tools, custom_tools, reasoner_model, use_mock, inference_config, selected_model
        if not demo_id:
            return
        try:
            item = _demo_cache.get(demo_id)
            if not item:
                table = dynamodb.Table(DEMOS_TABLE_NAME)
                result = table.get_item(Key={"id": demo_id})
                item = result.get("Item", {})
            config = item.get("config", {})
            voice_id = config.get("voice", {}).get("voiceId", DEFAULT_VOICE) or DEFAULT_VOICE
            agent_start_first = config.get("agentStartFirst", True)
            greeting = config.get("greeting", "")
            tools = config.get("tools", [])
            custom_tools = config.get("customTools", [])
            reasoner_model = config.get("reasonerModel", "")
            use_mock = config.get("useMock", True)
            inference_config = config.get("inferenceConfig", {}) if isinstance(config.get("inferenceConfig"), dict) else {}
            selected_model = (config.get("model") or ["nova-2-sonic"])[0]
            prompt_parts = []
            if config.get("systemPrompt"):
                prompt_parts.append(config["systemPrompt"])
            if greeting:
                prompt_parts.append(f"Greet the caller with: {greeting}")
            system_prompt = "\n".join(prompt_parts) if prompt_parts else DEFAULT_SYSTEM_PROMPT
            logger.info(f"Demo loaded: {item.get('name', demo_id)}, voice={voice_id}, tools={len(tools)}, reasoner={reasoner_model or 'direct'}, prompt_len={len(system_prompt)}")
        except Exception as e:
            logger.error(f"Failed to load demo {demo_id}: {e}")

    load_demo_config()

    try:
        # Use pre-warmed connection if available, otherwise connect fresh
        warm_connection = _warm_connections.pop("latest", None)
        ready = {}
        if warm_connection:
            agentcore_ws, ready = warm_connection
        if agentcore_ws and agentcore_ws.open:
            logger.info("Using pre-warmed AgentCore connection (already configured)")
        else:
            url = await generate_presigned_ws_url()
            agentcore_ws = await websockets.connect(url)
            logger.info("Connected to AgentCore (fresh)")

            # Send session config (only for fresh connections)
            await agentcore_ws.send(json.dumps({
                "type": "sessionConfig",
                "clientId": f"twilio-{demo_id or 'phone'}",
                "host": "agentcore",
                "framework": "strands-bidiagent",
                "model": [selected_model],
                "apiKeys": {
                    key: value for key, value in {
                        "openai": _cfg("OPENAI_API_KEY"),
                        "gemini": _cfg("GOOGLE_API_KEY"),
                    }.items() if value
                },
                "systemPrompt": system_prompt,
                "tools": tools,
                "customTools": custom_tools,
                "voice": {"voiceId": voice_id},
                "agentStartFirst": agent_start_first,
                "greeting": greeting or "Hello! How can I help you today?",
                "reasonerModel": reasoner_model,
                "useMock": use_mock,
                "inferenceConfig": inference_config,
                "agentId": demo_id or "telephony-default",
                "callHistoryEnabled": True,
                "source": "telephony",
                "callerId": caller,
            }))

            # Wait for ready
            ready = json.loads(await asyncio.wait_for(agentcore_ws.recv(), timeout=30))
            logger.info("AgentCore ready")

        if isinstance(ready, str):
            ready = json.loads(ready)
        input_sample_rate = int(ready.get("inputSampleRate", 16000))
        output_sample_rate = int(ready.get("outputSampleRate", 16000))
        logger.info("Negotiated agent audio rates: input=%s output=%s", input_sample_rate, output_sample_rate)

        async def twilio_to_agent():
            """Receive mulaw from Twilio, convert to PCM 16kHz, send to BidiAgent."""
            nonlocal stream_sid
            try:
                while True:
                    raw = await websocket.receive_text()
                    data = json.loads(raw)
                    event = data.get("event", "")

                    if event == "connected":
                        continue
                    elif event == "start":
                        stream_sid = data.get("streamSid", data.get("start", {}).get("streamSid"))
                        logger.info(f"Stream started: {stream_sid}")
                    elif event == "media":
                        payload = data.get("media", {}).get("payload", "")
                        if payload and agentcore_ws:
                            mulaw_bytes = base64.b64decode(payload)
                            pcm = mulaw_8k_to_pcm(mulaw_bytes, input_sample_rate)
                            pcm_b64 = base64.b64encode(pcm).decode()
                            await agentcore_ws.send(json.dumps({
                                "type": "bidi_audio_input",
                                "audio": pcm_b64,
                                "format": "pcm",
                                "sample_rate": input_sample_rate,
                                "channels": 1,
                            }))
                    elif event == "stop":
                        logger.info("Stream stopped")
                        break
            except WebSocketDisconnect:
                pass
            except Exception as e:
                if "closed" not in str(e).lower():
                    logger.error(f"Twilio→Agent: {e}")

        async def agent_to_twilio():
            """Receive audio from BidiAgent, convert to mulaw, send to Twilio."""
            try:
                async for raw in agentcore_ws:
                    data = json.loads(raw)
                    msg_type = data.get("type", "")

                    if msg_type == "bidi_audio_stream" and stream_sid:
                        audio_b64 = data.get("audio", "")
                        if audio_b64:
                            pcm_bytes = base64.b64decode(audio_b64)
                            mulaw_bytes = pcm_to_mulaw_8k(pcm_bytes, output_sample_rate)
                            mulaw_b64 = base64.b64encode(mulaw_bytes).decode()
                            await websocket.send_text(json.dumps({
                                "event": "media",
                                "streamSid": stream_sid,
                                "media": {"payload": mulaw_b64},
                            }))
                    elif msg_type == "bidi_interruption" and stream_sid:
                        # User barged in — clear queued audio on Twilio side
                        logger.info("Barge-in detected — clearing Twilio audio")
                        await websocket.send_text(json.dumps({
                            "event": "clear",
                            "streamSid": stream_sid,
                        }))
                    elif msg_type == "error":
                        logger.error(f"Agent error: {data.get('message', '')}")
            except Exception as e:
                if "closed" not in str(e).lower():
                    logger.error(f"Agent→Twilio: {e}")

        await asyncio.gather(twilio_to_agent(), agent_to_twilio())

    except Exception as e:
        logger.error(f"Bridge error: {e}")
    finally:
        if agentcore_ws:
            try:
                await agentcore_ws.send(json.dumps({"type": "sessionEnd"}))
                await agentcore_ws.close()
            except Exception:
                pass
        logger.info("Session closed")


# ─── SigV4 presign ──────────────────────────────────────────────────────────

async def generate_presigned_ws_url() -> str:
    session = boto3.Session(region_name=AWS_REGION)
    creds = session.get_credentials().get_frozen_credentials()
    host = f"bedrock-agentcore.{AWS_REGION}.amazonaws.com"
    url = f"https://{host}/runtimes/{AGENTCORE_RUNTIME_ARN}/ws"
    bc_creds = Credentials(creds.access_key, creds.secret_key, creds.token)
    signer = SigV4QueryAuth(bc_creds, "bedrock-agentcore", AWS_REGION, expires=300)
    request = AWSRequest(method="GET", url=url, headers={"Host": host})
    signer.add_auth(request)
    return request.url.replace("https://", "wss://", 1)


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "telephony-bridge"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
