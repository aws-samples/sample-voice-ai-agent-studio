# Telnyx SIP Trunk Setup

Connect the Voice Agent SIP relay server to Telnyx SIP Trunking for inbound phone calls.

## Prerequisites

- SIP relay server deployed (see [`telephony/sip/README.md`](../telephony/sip/README.md))
- Telnyx Mission Control Portal account ([sign up](https://telnyx.com/sign-up))
- NLB IP from deployment output (e.g., `203.0.113.10`)
- A purchased Telnyx number (or the intent to buy one in step 3)

## How Telnyx models trunks

Telnyx splits what other providers call a "trunk" into two objects:

- **SIP Connection** — authenticates inbound traffic and carries the phone number(s). For a static NLB IP, use an **IP Authentication** connection (no registration needed; Telnyx sends INVITEs to your endpoint).
- **Outbound Voice Profile** — required for outbound calls. Attach it to your SIP Connection (on the connection's Outbound tab); a connection with no profile rejects outbound calls with `D38` (403).

## Console UI Setup

### 1. Create the SIP Connection

1. Go to the [Mission Control Portal](https://portal.telnyx.com) → **Voice → SIP Trunking** → **Add SIP Connection**
2. Name it (e.g., `voice-agent-sip`) and pick **IP Authentication** as the type
3. Add your NLB IP under the connection's allowed IPs (e.g., `203.0.113.10`)
4. Leave the connection's inbound timeouts at their defaults (`timeout_1xx_secs`: 3s, `timeout_2xx_secs`: 90s). The bridge sends `180 Ringing` immediately, and the 90s answer window comfortably covers the ~3-5s AgentCore warm-up
5. Save the connection

### 2. Create the Outbound Voice Profile

1. Go to **Voice → Outbound Voice Profiles** → **Add New Profile**
2. Name it (e.g., `voice-agent-outbound`), set allowed destinations (e.g., US only for a POC) and a daily spend limit
3. Open the `voice-agent-sip` connection, switch to its **Outbound** tab, and select the `voice-agent-outbound` profile
4. Save

### 3. Buy a number and route it

1. Go to **Voice → My Numbers**, buy a number under **Buy Numbers**, and set its **SIP connection** to `voice-agent-sip`
2. Inbound calls to this number now hit your NLB

## CLI Setup

Requires a Telnyx API v2 key (`TELNYX_API_KEY`) created in the [Mission Control Portal under **API Keys**](https://portal.telnyx.com/#/app/api-keys).

```bash
# Get your NLB IP (use the NLB DNS name from your SIP deployment output)
NLB_DNS="<your-sip-nlb-dns-name>"
NLB_IP=$(dig +short $NLB_DNS | tail -1)
echo "SIP endpoint your connection will target: ${NLB_IP}:5060"

# 1. Create an Outbound Voice Profile
PROFILE_ID=$(curl -s -X POST https://api.telnyx.com/v2/outbound_voice_profiles \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "voice-agent-outbound"}' \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])")

# 2. Create an IP-authenticated SIP connection attached to the profile
CONNECTION_ID=$(curl -s -X POST https://api.telnyx.com/v2/ip_connections \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"connection_name\": \"voice-agent-sip\", \"outbound\": {\"outbound_voice_profile_id\": \"${PROFILE_ID}\"}}" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['data']['id'])")

# 3. Point the connection at your NLB (authorized IP)
curl -s -X POST https://api.telnyx.com/v2/ips \
  -H "Authorization: Bearer $TELNYX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"connection_id\": \"${CONNECTION_ID}\", \"ip_address\": \"${NLB_IP}\", \"port\": 5060}"

echo "Connection: $CONNECTION_ID | Profile: $PROFILE_ID"
# 4. Buy/assign a number to this connection in the Mission Control Portal
#    (portal action; number purchase is done in the UI)
```

## Verification

1. Call the Telnyx number assigned to the `voice-agent-sip` connection
2. You should hear ringback while AgentCore warms up (~3-5 seconds)
3. The AI agent greets you and conversation begins

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Call hangs up immediately | Connection's 1XX timeout (`timeout_1xx_secs`, default 3s) expired with no ringing response from your endpoint | Check the NLB target is healthy and UDP 5060 is open to Telnyx signaling IPs |
| One-way or no audio | RTP ports not open both directions | Telnyx media uses UDP `16384-32768`, not the common `10000-20000` range |
| 403 on outbound calls | No Outbound Voice Profile attached | Attach the profile (see step 2) |
| 403 channel limit reached | Connection channel cap | Raise the **Channel Limit** on the SIP Connection |
| 488 Not Acceptable | Encrypted media set on connection but bridge sends plain RTP | Enable Encrypted Media (SRTP) on both ends, or disable it on the connection |

## Architecture

```
Phone → Telnyx PSTN → SIP Connection (IP-authenticated)
    → SIP INVITE (UDP 5060, from Telnyx signaling IPs)
    → NLB → EKS Node (drachtio) → Bridge (Node.js) → AgentCore (Nova Sonic)
```

## Securing the SG (production)

Restrict your security group to Telnyx's published [SIP signaling and media IP ranges](https://sip.telnyx.com). In [`GUIDE-sip-server.md`](GUIDE-sip-server.md), swap the Twilio example for Telnyx's ranges on both the 5060 signaling rule and the 20000-20100 RTP rule.

## Related Documentation

- [SETUP-twilio-sip.md](SETUP-twilio-sip.md) - Twilio SIP Trunk configuration
- [SETUP-chime-sdk-sip.md](SETUP-chime-sdk-sip.md) - Amazon Chime SDK SIP setup
- [GUIDE-sip-server.md](GUIDE-sip-server.md) - SIP server design and production security
