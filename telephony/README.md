# Telephony

Phone connectivity for the voice agent. Callers reach the same Nova Sonic agent
that runs in the browser, either over the public phone network (Twilio) or via a
direct SIP trunk from an enterprise contact center.

> **Deployed separately from the main CDK app.** Both paths provision
> internet-facing network infrastructure (public load balancers, and — for SIP —
> open UDP ports) that is subject to a higher security review bar than the rest
> of the solution. They are **not** created by `deployment/deploy.sh`; deploy
> them on your own account using the instructions in each sub-folder.

## Two paths

| | [`pstn/`](pstn/) — PSTN (Twilio) | [`sip/`](sip/) — SIP (direct trunk) |
|---|---|---|
| Provider | Twilio (manages PSTN + RTP) | Any SIP trunk (Genesys, Five9, NICE, Twilio SIP) |
| Media | WebSocket (Twilio abstracts RTP) | Raw UDP/RTP (self-managed) |
| Infrastructure | ECS Fargate + ALB + CloudFront | EKS node group + NLB |
| Open ports | None (HTTPS only via CloudFront) | UDP 5060 + 20000-20100 |
| Agents per number | Multiple (DTMF menu) | One per trunk |
| Latency | Higher (Twilio relay in path) | Lower (direct RTP) |
| Security surface | Small | Large (open UDP) |
| Best for | Quick phone testing, Twilio users | Enterprise CCaaS, low latency |

Both connect to the same Bedrock AgentCore runtime via a SigV4-presigned
WebSocket and read agent configs from the `voice-agent-poc-demos` DynamoDB table.

> **Deploy telephony into the same AWS account and region as the main solution.**
> Although these components live outside the CDK app for security isolation, at
> runtime each bridge depends on resources the main solution owns:
> - the **AgentCore runtime** it presigns a WebSocket to (unavoidable — that's
>   where the agent runs),
> - the **`voice-agent-poc-demos`** table (agent voice/prompt/tools), and
> - the **`voice-agent-poc-phone-mappings`** table, which the web UI's *Phone
>   Numbers* page writes — this is how a dialed number is routed to an agent.
>
> A bridge in a different account reads a different (empty) mappings table and
> will not find the numbers you configured in the UI. Cross-account access is
> possible but is not covered by these instructions. Each sub-folder's README
> lists the exact tables, secret, and IAM permissions the bridge needs.

## Sub-folders

- [`pstn/`](pstn/) — Twilio TAC bridge (FastAPI). Source + self-managed
  deployment instructions and architecture diagram.
- [`sip/`](sip/) — drachtio + rtpengine + Node.js bridge (Jambonz style).
  Source, local `docker compose` dev, and self-managed deployment instructions.

## Design & integration guides

| Guide | Description |
|-------|-------------|
| [`docs/GUIDE-pstn-relay-server.md`](../docs/GUIDE-pstn-relay-server.md) | PSTN relay design, network architecture, security |
| [`docs/GUIDE-sip-server.md`](../docs/GUIDE-sip-server.md) | SIP server design, network architecture, production security |
| [`docs/SETUP-twilio-sip.md`](../docs/SETUP-twilio-sip.md) | Twilio SIP Trunk setup |
| [`docs/SETUP-telnyx-sip.md`](../docs/SETUP-telnyx-sip.md) | Telnyx SIP Trunk setup |
| [`docs/SETUP-chime-sdk-sip.md`](../docs/SETUP-chime-sdk-sip.md) | Amazon Chime SDK SIP setup |
| [`docs/GUIDE-genesys-sip-integration.md`](../docs/GUIDE-genesys-sip-integration.md) | Genesys Cloud CX integration |
| [`docs/GUIDE-connect-integration.md`](../docs/GUIDE-connect-integration.md) | Amazon Connect integration |
