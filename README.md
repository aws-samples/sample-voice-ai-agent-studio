# Conversational AI Agent Studio

Design, build, and prototype voice AI agents on AWS. A guided studio for configuring real-time speech agents — from industry template to live phone call — powered by Amazon Nova Sonic, Strands Agents BidiAgent, and Amazon Bedrock AgentCore.

> **Sample / proof-of-concept.** This project is a reference implementation for learning and prototyping. Review and harden it (security, error handling, scaling, cost controls) before using it for production workloads.

## The Voice Agent Stack

![Voice AI Agent Stack](assets/voice-ai-agent-stack.png)

A real-time voice agent isn't a single model — it's a stack of decisions. Each layer is chosen independently, and the trade-offs at one layer ripple into the others:

- **Model** — what hears, thinks, and speaks (speech-to-speech like Nova Sonic, or STT + LLM + TTS).
- **Framework** — what orchestrates the session: streaming, turn detection, and tool calls (Strands BidiAgent, LiveKit, Pipecat).
- **Integrations** — what the agent can actually do (knowledge bases/RAG, APIs, MCP, other agents).
- **Channel** — how callers reach it: the protocol and transport (WebSocket, WebRTC, PSTN, SIP).
- **Hosting** — where it runs and how it scales (managed runtimes, containers, on-prem).

For the concepts behind these layers, see [Building Real-Time Voice Agents: Choosing Models, Frameworks, Protocols, and Hosting](https://medium.com/generative-ai/building-real-time-voice-agents-choosing-models-frameworks-protocols-and-hosting-5dc0a28f98e2).

This studio turns those layers into a guided workflow: you pick a model and voice, wire up tools and RAG, choose a channel (browser, PSTN, or SIP), and deploy to a managed runtime on AWS — without hand-assembling the stack yourself. The current build uses Amazon Nova 2 Sonic (speech-to-speech) on the Strands BidiAgent framework, hosted on Amazon Bedrock AgentCore.

## Architecture

![Architecture Diagram](assets/architecture.png)

The solution has four deployable components. The core app is deployed by the CDK
(`deployment/deploy.sh`); the two telephony paths are deployed independently
because they provision internet-facing network infrastructure subject to a
higher security review bar.

| # | Component | How it's deployed |
|---|-----------|-------------------|
| 1 | **Frontend app** (React UI + demos/tools/RAG API, Cognito) | CDK — `deploy.sh` |
| 2 | **Voice agent on AgentCore** (Nova Sonic BidiAgent runtime) | CDK — `deploy.sh` |
| 3 | **PSTN relay** (Twilio TAC bridge) | Independent — [`telephony/pstn/`](telephony/pstn/) |
| 4 | **SIP relay** (drachtio + bridge) | Independent — [`telephony/sip/`](telephony/sip/) |

## Features

### Agent Builder
- Guided wizard — choose template, pipeline, model, voice, tools, prompt, and workflow
- Industry templates — insurance, banking, contact center training, drive-through, automotive, healthcare
- Visual workflow designer with per-step tool assignment
- Live voice test with real-time transcript

### Speech & Reasoning
- Bidirectional streaming (speech-to-speech) — Amazon Nova 2 Sonic (no key needed), plus OpenAI Realtime and Google Gemini Live (bring your own API key)

### Integrations
- Built-in reserved tools (end call, transfer to human) available to every agent
- Custom tools defined in UI with mock responses
- Webhooks, Lambda functions, AgentCore MCP gateways, AgentCore sub-agent runtimes
- RAG against an existing Bedrock Knowledge Base, with document upload and data-source sync
- Telephony — PSTN (Twilio) and direct SIP trunk (Genesys, Five9, NICE)

### Evaluation
- Eval suites — group reusable test cases (prompt, model, and simulated-caller scenarios) for an agent
- LLM-as-judge scoring against configurable aspects and rubrics, with PASS/FAIL verdicts and reasoning
- Real or mock tools — run test cases against live tool integrations (HTTP/Lambda/MCP/sub-agent) or dummy mock responses
- Performance metrics — TTFT (time to first token), TTFB (time to first audio byte), and tool-execution latency, with min/max/avg/p50/p95

### Platform
- Voice agent deployed on AgentCore Bidirectional Runtime
- Agent dashboard — metrics, conversation history, cost tracking
- Cognito auth with SigV4 presigned WebSocket URLs
- Multi-tenant — each user sees only their own agents, tools, and evals (admins see all)
- One-command CDK deployment to AWS

## Deployment

The core app (frontend + voice agent on AgentCore) is deployed with CDK via `deployment/deploy.sh`. Prerequisites, supported regions, CDK stacks, IAM permissions, environment variables, and step-by-step instructions live in the deployment guide:

- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — full deployment guide
- **[docs/LOCAL-DEVELOPMENT.md](docs/LOCAL-DEVELOPMENT.md)** — running locally without a full deploy

The two telephony paths (PSTN and SIP) are optional and deployed separately — see [`telephony/pstn/`](telephony/pstn/) and [`telephony/sip/`](telephony/sip/).

## Telephony

Real-world voice agents need phone connectivity. The studio provides two telephony paths, letting you test agents over actual phone calls during development, with a direct SIP integration path for enterprise-style deployments.

> **Deployed separately from the main CDK app.** Both telephony paths provision
> internet-facing network infrastructure (public load balancers, open UDP ports)
> that is subject to a higher security review bar than the rest of the solution.
> Their source and self-managed deployment instructions live under the top-level
> [`telephony/`](telephony/) folder ([`telephony/pstn/`](telephony/pstn/) and
> [`telephony/sip/`](telephony/sip/)) — they are not created by `deploy.sh`.

### PSTN (Twilio Conversation Relay)

Callers dial a Twilio number and talk to the same voice agent that runs in the browser. Multiple agents can share one phone number with DTMF menu selection.

- **Infrastructure**: ECS Fargate + ALB + CloudFront (HTTPS/WSS only)
- **Network**: Public-only VPC (no private subnets, no NAT Gateway) — Fargate tasks get public IPs directly
- **Media**: Twilio handles all RTP/codec; bridge receives audio as base64 WebSocket messages
- **Security boundary**: CloudFront TLS termination, no open UDP ports

### SIP (Direct Trunk)

Direct SIP integration for enterprise contact centers (Genesys, Five9, NICE) or Twilio SIP Trunking. Lower latency with direct RTP media handling.

- **Infrastructure**: EKS Managed Node Group + NLB (UDP)
- **Network**: Nodes in public subnet with `hostNetwork` — RTP requires direct public IP addressability (NAT Gateway cannot forward inbound UDP)
- **Media**: Self-managed RTP — bridge receives raw UDP packets, converts μ-law 8kHz ↔ PCM 16kHz
- **Security boundary**: Security group (restrict to provider IPs in production), SIP TLS + SRTP recommended

### Why Different Network Designs

| | PSTN Relay | SIP Relay |
|---|---|---|
| VPC | Public subnets only, no NAT | Public + private subnets, NAT for EKS control plane ENIs |
| Inbound protocol | HTTPS/WSS (Twilio manages RTP) | Raw UDP 5060 + 20000-20100 |
| Compute | Fargate (no host access needed) | EKS with hostNetwork (must bind UDP ports on host IP) |
| Load balancer | ALB (HTTP/WebSocket) | NLB (UDP) |
| Public IP exposure | Only via CloudFront | Node's public IP in SDP (directly addressable) |

### Documentation

| Guide | Description |
|-------|-------------|
| [telephony/README.md](telephony/README.md) | Telephony overview — PSTN vs SIP, deployed separately |
| [telephony/pstn/README.md](telephony/pstn/README.md) | PSTN relay source + self-managed deployment instructions |
| [telephony/sip/README.md](telephony/sip/README.md) | SIP relay source + self-managed deployment instructions |
| [GUIDE-pstn-relay-server.md](docs/GUIDE-pstn-relay-server.md) | PSTN relay design, network architecture, and security |
| [GUIDE-sip-server.md](docs/GUIDE-sip-server.md) | SIP server design, network architecture, and production security |
| [SETUP-twilio-sip.md](docs/SETUP-twilio-sip.md) | Twilio SIP Trunk setup (UI + CLI) |
| [SETUP-telnyx-sip.md](docs/SETUP-telnyx-sip.md) | Telnyx SIP Trunk setup (UI + CLI) |
| [GUIDE-genesys-sip-integration.md](docs/GUIDE-genesys-sip-integration.md) | Genesys Cloud CX integration |
| [GUIDE-connect-integration.md](docs/GUIDE-connect-integration.md) | Amazon Connect integration |

## Speech Pipelines

### Bidirectional Streaming (Speech-to-Speech)

The implemented pipeline. A single model handles speech input, reasoning, and speech output in one stream. Lowest latency — audio goes in, audio comes out, no intermediate text step required.

The agent runtime (`source/agent/main.py`) builds a **Strands BidiAgent** with the selected speech-to-speech model, which manages bidirectional WebSocket streaming, tool orchestration, and turn detection.

Three providers are supported (chosen in the wizard):

| Provider | Model | API key | Audio rate |
|----------|-------|---------|------------|
| Amazon Nova 2 Sonic | `amazon.nova-2-sonic-v1:0` | Not needed (uses the AgentCore role) | 16 kHz |
| OpenAI Realtime | `gpt-realtime` | Required (entered in the wizard) | 24 kHz |
| Google Gemini Live | `gemini-2.5-flash-native-audio-preview-09-2025` | Required (entered in the wizard) | 24 kHz |

The runtime selects the model via `create_model()` (in `main.py` / `strands_agent.py`) and reports the model's audio sample rate to the client in the session-ready message, so the browser plays and captures audio at the right rate. Provider model IDs are overridable via the `OPENAI_REALTIME_MODEL_ID` / `GEMINI_LIVE_MODEL_ID` env vars.

> **Note:** If you select OpenAI or Gemini without providing that provider's API
> key, the session fails with a clear error (no silent fallback to Nova Sonic).
> The **telephony** bridges (PSTN/SIP) currently assume 16 kHz audio, so OpenAI/
> Gemini over a phone call would need the bridge sample rates updated first —
> browser testing supports all three today.

> **Cascaded pipeline (STT → LLM → TTS) is not implemented.** The wizard contains
> disabled UI scaffolding for a cascaded workflow (a hidden `CascadedSpeech`
> page and unused `pipeline: 'cascaded'` / `framework: 'pipecat' | 'livekit'`
> type options), but there is no backend for it — the agent runtime only creates
> a Nova Sonic BidiAgent, and no STT/LLM/TTS or Pipecat/LiveKit code or
> dependencies exist in the source. Speech-to-Speech is the only working pipeline.

## Agent Tools

**Reserved**: `endCallTool` (end the call gracefully) and `transferCall` (transfer to a live agent/department) — always available to every agent. All other tools (knowledge base, CRM, calendar, etc.) are configured as custom tools via the Tools UI, not pre-built.

**Integrations**: Webhooks (HTTP), Lambda functions, MCP gateways (AgentCore), sub-agents

**Custom**: Define tools in the UI with name, description, parameters, and mock response — dynamically created at session start.

**RAG**: Upload documents to a Bedrock Knowledge Base and query them as a tool during conversations.

## Evaluation

Test voice agents before they reach production. The studio runs an agent against a simulated caller and scores the resulting conversation, so you can compare prompts and models and catch regressions.

### Eval Suites

An eval suite groups reusable **test cases** for an agent. Each test case captures a base prompt, target model, and a set of simulated-caller scenarios, so the same checks can be re-run as the agent evolves. Suites are per-user (admins can see all), and every run is stored for later comparison.

### Real vs Mock Tools

Each run chooses how the agent's tools behave:

- **Live** — the agent calls the real integration (HTTP webhook, Lambda, AgentCore MCP gateway, or sub-agent). Tools with no real integration fall back to their mock response.
- **Mock** — every tool returns its configured dummy response, so you can exercise conversation logic without hitting external systems.

### LLM-as-Judge Scoring

After the simulated conversation completes, an LLM judge evaluates the transcript against configurable **evaluation aspects** and **rubrics**, producing per-metric PASS/FAIL verdicts with reasoning, an overall pass rate, and strengths/weaknesses. Runs execute asynchronously and report `PENDING → RUNNING → EVALUATING → COMPLETED`.

### Performance Metrics

Every run captures voice-latency metrics from the AgentCore session, aggregated as min / max / avg / p50 / p95:

| Metric | Meaning |
|--------|---------|
| TTFT | Time to first token — user input end → first text from the agent |
| TTFB | Time to first byte — user input end → first audio byte from the agent |
| Tool execution | Time from tool call to tool result |

Additional per-turn measurements (turn-taking gap, tool-to-speech, total tool time) are recorded in the interaction log.

Backend: `source/api/eval_handler.py` and `eval_suites_handler.py` (API), `source/eval-runner/` (async runner + AgentCore adapter). UI: the **Eval Suites** pages under `source/frontend/src/pages/`.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | React 19, TypeScript, Vite, CSS Modules |
| Agent Runtime | Python, Strands BidiAgent, AgentCore Bidirectional Runtime |
| Speech-to-Speech | Amazon Nova 2 Sonic, OpenAI Realtime, Google Gemini Live (Strands BidiAgent) |
| Agent Hosting | Amazon Bedrock AgentCore (WebSocket, bidirectional streaming) |
| Tool Gateways | AgentCore MCP Gateways |
| Sub-agents | AgentCore Runtime (delegated agent invocation) |
| RAG | Existing Bedrock Knowledge Base (via `retrieve` API) — not created by this app |
| Evaluation | Async eval runner (container Lambda) + LLM-as-judge harness, S3 results, DynamoDB job/suite tables |
| Auth | Cognito User Pool + Identity Pool, SigV4 presigned URLs |
| API | Lambda + API Gateway + DynamoDB |
| Infrastructure | AWS CDK (Python), CloudFormation |
| Frontend Hosting | CloudFront + S3 |
| Telephony (PSTN) | Twilio Conversation Relay + TAC Bridge (ECS Fargate) — deployed separately (`telephony/pstn/`) |
| Telephony (SIP) | drachtio + Node.js bridge (EKS, NLB) — deployed separately (`telephony/sip/`) |

## Project Structure

```
voice-agent-poc-in-a-box/
├── deployment/                          # CDK infrastructure-as-code
│   ├── app.py                           # CDK app entry point
│   ├── deploy.sh                        # Full deployment script
│   ├── deploy-backend.sh                # Backend stacks only
│   ├── deploy-frontend.sh               # Frontend build + deploy
│   ├── pre_stack/                       # Cognito, S3, ECR
│   ├── agent_stack/                     # AgentCore Runtime
│   ├── demos_stack/                     # DynamoDB + API (demos, tools, RAG, Knowledge Base)
│   ├── frontend/                        # CloudFront + S3
│   └── post_stack/                      # Cognito user creation
├── source/
│   ├── agent/                           # Voice agent server
│   │   ├── main.py                      # AgentCore entrypoint
│   │   ├── strands_agent.py             # Local dev server (FastAPI)
│   │   ├── rag_tools.py                 # RAG / Knowledge Base tool
│   │   ├── call_history_logger.py       # Call history logging
│   │   └── tools/                       # Reserved-tool registry (endCallTool, transferCall)
│   ├── api/                             # Lambda handlers
│   │   ├── demos_handler.py             # Demos CRUD
│   │   ├── tools_handler.py             # Tools CRUD + testing
│   │   ├── rag_handler.py               # RAG / Knowledge Base operations
│   │   ├── phone_mappings_handler.py    # Phone → agent mapping
│   │   ├── call_history_handler.py      # Call history API
│   │   ├── eval_handler.py              # Eval runs
│   │   ├── eval_suites_handler.py       # Eval suites
│   │   ├── generate_agent_handler.py    # Agent generation
│   │   ├── generate_prompt_handler.py   # Prompt generation
│   │   ├── skills_handler.py            # Prompt best-practice skills
│   │   ├── auth_utils.py                # Shared auth helpers
│   │   ├── prompt_best_practices/       # Model-specific prompt skills
│   │   └── sample_tools/                # Sample custom-tool definitions
│   ├── eval-runner/                     # Standalone eval runner (AgentCore adapter)
│   └── frontend/                        # React UI
│       └── src/
│           ├── config/                  # Templates, voices, reserved tools, wizard steps
│           ├── context/                 # Auth + Wizard state
│           ├── services/                # API clients, presigned URLs
│           ├── pages/                   # Wizard steps, dashboard, integrations, telephony
│           ├── components/              # Shared UI (workflow canvas, sidebar)
│           ├── events/                  # Event handling
│           ├── hooks/                   # React hooks
│           └── styles/                  # Shared styles
├── telephony/                           # Phone connectivity — deployed separately from CDK
│   ├── pstn/                            # PSTN relay (Twilio TAC Bridge, ECS Fargate)
│   └── sip/                             # SIP relay (drachtio + bridge, EKS/NLB)
├── tools/                               # Voice recording utilities (Polly / Nova Sonic)
├── docs/                                # Telephony and integration guides
└── README.md
```

## Cleanup

```bash
cd deployment && source .venv/bin/activate && npx cdk destroy --all
```

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
