# SIP Server Design Guide

Self-managed SIP relay server that bridges inbound phone calls from SIP trunks (Twilio, Genesys, Five9) to the Nova Sonic voice agent running on Amazon Bedrock AgentCore.

## Architecture Diagram

![SIP Architecture](../assets/sip-architecture.svg)

## Overview

Enterprise contact centers and telephony providers deliver calls via SIP (Session Initiation Protocol). This server terminates inbound SIP, handles RTP media directly, converts audio between telephony format (G.711 μ-law, 8kHz) and Nova Sonic's format (PCM 16-bit, 16kHz), and streams bidirectionally to AgentCore over a SigV4-presigned WebSocket.

The architecture uses EKS with `hostNetwork` mode because SIP/RTP requires the server to be directly addressable on a public IP — the SDP (Session Description Protocol) in the SIP response advertises the server's IP and port where the caller should send RTP packets.

## Call Flow

```
1. Caller → SIP INVITE (UDP 5060) → NLB → drachtio → bridge
2. Bridge → 180 Ringing → caller (ringback tone)
3. Bridge → presign WSS URL → connect to AgentCore
4. Bridge → sessionConfig → AgentCore (voice, prompt, tools)
5. AgentCore → "ready" + greeting audio → bridge
6. Bridge → 200 OK (SDP with public_ip:rtp_port) → caller
7. Caller → RTP μ-law 8kHz (20ms packets) → bridge UDP socket
8. Bridge → convert μ-law→PCM, upsample 8→16kHz → AgentCore (WebSocket)
9. AgentCore → PCM 16kHz → bridge → downsample, encode μ-law → RTP → caller
10. Hang up → SIP BYE → bridge → sessionEnd → AgentCore
```

The bridge sends 180 Ringing first, then warms up AgentCore (connect + get greeting), and only answers with 200 OK once the agent is ready. This eliminates dead air at call start.

## Network Architecture

### Why Pods Must Be in the Public Subnet

Unlike typical EKS workloads (web APIs, microservices) that sit in private subnets behind a NAT Gateway, SIP servers require direct public IP addressability:

1. **RTP is bidirectional UDP** — the caller needs to send audio packets *to* the server on an advertised IP:port
2. **NAT Gateway is outbound-only** — it cannot expose stable inbound UDP ports for RTP
3. **SDP requires a real public IP** — the SIP 200 OK must contain the server's routable IP in the SDP answer
4. **Latency** — every 20ms audio packet through NAT adds jitter; direct routing is required for voice quality

This is the universal pattern for all self-hosted SIP infrastructure (Otel, Kamailio, FreeSWITCH, Asterisk).

### VPC Layout

```
VPC: 10.0.0.0/16
├── Public Subnet AZ-a: 10.0.0.0/24
│   ├── Internet Gateway (inbound + outbound)
│   ├── NAT Gateway (for private subnet egress)
│   ├── Network Load Balancer (SIP entry point)
│   └── EKS Node Group (SIP pods, hostNetwork)
│
├── Public Subnet AZ-b: 10.0.1.0/24
│   └── (same, for multi-AZ)
│
├── Private Subnet AZ-a: 10.0.2.0/24
│   └── EKS Control Plane ENIs (cross-account, kubelet communication)
│
└── Private Subnet AZ-b: 10.0.3.0/24
    └── EKS Control Plane ENIs
```

### Traffic Flows

| Flow | Path | Protocol |
|------|------|----------|
| Inbound SIP signaling | Caller → NLB → Node (port 5060) | UDP |
| Inbound RTP media | Caller → Node directly (port 20000-20100) | UDP |
| Outbound RTP media | Node → Caller's media IP | UDP |
| Bridge → AgentCore | Node → Internet Gateway → AgentCore endpoint | WSS (TLS) |
| Bridge → DynamoDB | Node → Internet Gateway → DynamoDB endpoint | HTTPS |
| EKS control plane → kubelet | Control Plane ENI (private subnet) → Node | TCP 10250 |
| kubectl → EKS API | Internet → EKS API endpoint (AWS-managed) | HTTPS |

### Why Private Subnets Exist

The private subnets serve the EKS control plane's cross-account ENIs. When you set `endpoint_access=PUBLIC_AND_PRIVATE`, AWS places ENIs in your private subnets so the managed control plane can communicate with kubelets over private IPs (no internet traversal for cluster management).

The NAT Gateway (in the public subnet) provides egress for these private subnet ENIs when the control plane needs to reach AWS APIs on behalf of the cluster.

## Components

### Network Load Balancer

- Internet-facing, deployed in public subnets
- UDP listener on port 5060 (SIP signaling)
- UDP listener on port 20000 (RTP — single port forwarding, not full range)
- Health check: TCP 3000 (bridge `/health` endpoint)
- Provides a stable DNS name / IP for SIP trunk configuration

### EKS Cluster (v1.31)

- Managed Node Group: `t3.medium`, AL2023, public subnet, 1-3 nodes
- `hostNetwork: true` — pods bind directly to the node's network interface
- Node selector: `role=sip` — ensures DaemonSet only targets SIP-labeled nodes

### DaemonSet: sip-bridge

One pod per node, containing 3 containers:

| Container | Role | Ports |
|-----------|------|-------|
| **drachtio** | SIP server — receives INVITE, manages SIP dialogs | UDP/TCP 5060, TCP 9022 (admin) |
| **rtpengine** | RTP media proxy (standby for future SRTP use) | UDP 20000-20100, TCP 22222 (control) |
| **bridge** | Node.js — orchestrates SIP↔AgentCore, handles audio conversion | TCP 3000 (health) |

### Security Group: SipNodeSG

| Rule | Protocol | Port | Source | Purpose |
|------|----------|------|--------|---------|
| Inbound | UDP | 5060 | 0.0.0.0/0 * | SIP signaling |
| Inbound | TCP | 5060 | 0.0.0.0/0 * | SIP over TCP |
| Inbound | UDP | 20000-20100 | 0.0.0.0/0 * | RTP media |
| Inbound | TCP | 3000 | VPC CIDR | Health check (NLB) |
| Outbound | All | All | 0.0.0.0/0 | AgentCore, DynamoDB, ECR |

\* Restrict to provider IPs in production (see Security section below).

### IAM: Node Role

```
bedrock-agentcore:*                    → Presign WebSocket URLs, invoke runtime
dynamodb:Scan/GetItem/Query            → Read agent config by phone number
ecr:GetDownloadUrlForLayer/BatchGet*   → Pull container images
```

## Audio Pipeline

### Inbound (caller → agent)

```
RTP μ-law 8kHz (160 bytes per 20ms packet)
  → batch 5 packets (100ms window, 800 bytes)
  → decode μ-law to PCM 16-bit (1600 bytes)
  → linear upsample 8kHz → 16kHz (3200 bytes)
  → base64 encode
  → WebSocket JSON: {"type": "bidi_audio_input", "audio": "...", "sample_rate": 16000}
```

### Outbound (agent → caller)

```
WebSocket JSON: {"type": "bidi_audio_stream", "audio": "..."}
  → base64 decode to PCM 16kHz
  → downsample 16kHz → 8kHz
  → encode to μ-law
  → split into 160-byte chunks (20ms each)
  → paced sending via setInterval(20ms)
  → RTP packets with sequential sequence numbers and timestamps
  → UDP to caller's media address (from SDP)
```

### Silence Handling

- Continuous silence (0xFF μ-law) sent to caller during agent thinking — prevents Twilio media timeout
- Audio sent continuously to AgentCore (including silence) — prevents Nova Sonic inactivity timeout (~30s)

## Deployment

The SIP relay is deployed separately from the main CDK app. See
[`telephony/sip/README.md`](../telephony/sip/README.md) for the full self-managed deployment
instructions (image build, EKS/NLB/security-group topology, IAM). The steps
below cover post-deploy wiring once the NLB and EKS node group exist.

Post-deploy (first time):
```bash
# Register EKS node in NLB target group
INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:eks:nodegroup-name,Values=*SipNodes*" "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].InstanceId" --output text)

TG_ARN=$(aws elbv2 describe-target-groups \
  --query "TargetGroups[?contains(TargetGroupName,'SipTa')].TargetGroupArn" --output text)

aws elbv2 register-targets --target-group-arn $TG_ARN --targets Id=$INSTANCE_ID
```

Get SIP endpoint (use the NLB DNS name from your deployment output):
```bash
NLB_DNS="<your-sip-nlb-dns-name>"
nslookup $NLB_DNS
```

## Security — Production Recommendations

### Threat Model

Open SIP ports attract:
- **SIP scanning bots** — mass INVITE/REGISTER probes to discover open servers
- **Toll fraud** — unauthorized calls routed through your server to premium-rate numbers
- **Eavesdropping** — unencrypted SIP/RTP intercepted in transit
- **Denial of service** — UDP flood on SIP/RTP ports

### Priority 1: IP Allowlisting

Restrict security group to your SIP provider's published source IPs:

```python
# In CDK — replace 0.0.0.0/0 with provider ranges
sip_sg.add_ingress_rule(
    ec2.Peer.ipv4("54.172.60.0/30"),  # Twilio signaling
    ec2.Port.udp(5060),
    "Twilio SIP",
)
```

Every provider publishes their IP ranges. This single change eliminates 99% of scanning attacks.

### Priority 2: SIP over TLS (Port 5061)

Encrypt signaling to prevent INVITE spoofing and metadata exposure:

```
drachtio --contact "sips:*:5061;transport=tls" --tls-cert-file /certs/cert.pem --tls-key-file /certs/key.pem
```

### Priority 3: SRTP for Media

Encrypt audio with SRTP. Re-enable rtpengine for SRTP termination:
- Caller sends SRTP → rtpengine decrypts → bridge receives plain RTP
- Required by most enterprise CCaaS in production

### Priority 4: SIP Digest Authentication

Challenge unknown INVITEs with 401/407 response requiring credentials. Stops unauthorized callers even if they reach the port.

### Priority 5: Rate Limiting

- Monitor call volume per source IP
- Auto-block IPs exceeding threshold (fail2ban pattern)
- CloudWatch alarms on anomalous traffic spikes
- VPC Flow Logs for forensics

### Priority 6: Network Isolation

| Improvement | Benefit |
|-------------|---------|
| VPC Gateway Endpoint for DynamoDB | Keeps DB traffic off public internet |
| EKS API private-only | Prevents cluster API exposure |
| IMDSv2 enforcement | Prevents SSRF-based credential theft |
| Elastic IP | Stable IP for SG rules + provider allowlisting |
| Separate SG per port | Granular control (SIP vs RTP vs health) |

### Hardening Checklist

| Item | Dev (current) | Production |
|------|---------------|------------|
| SIP source IPs | `0.0.0.0/0` | Provider CIDRs only |
| RTP source IPs | `0.0.0.0/0` | Provider CIDRs only |
| SIP transport | UDP plaintext | TLS (port 5061) |
| Media encryption | None (RTP) | SRTP |
| Authentication | None | Digest auth |
| DynamoDB access | Internet Gateway | VPC Gateway Endpoint |
| EKS API access | Public + Private | Private only (bastion) |
| Node SSH | Open | Disabled or bastion-only |
| IMDSv2 | Enabled | Enforced (disable v1) |
| Logging | Basic | VPC Flow Logs + SIP CDR |

## Related Documentation

- [SETUP-twilio-sip.md](SETUP-twilio-sip.md) — Twilio SIP Trunk configuration
- [SETUP-telnyx-sip.md](SETUP-telnyx-sip.md) — Telnyx SIP Trunk configuration
- [GUIDE-genesys-sip-integration.md](GUIDE-genesys-sip-integration.md) — Genesys Cloud CX integration
- [GUIDE-connect-integration.md](GUIDE-connect-integration.md) — Amazon Connect integration
