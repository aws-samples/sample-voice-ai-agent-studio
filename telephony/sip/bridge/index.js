/**
 * SIP-to-WebSocket Bridge — drachtio-srf + rtpengine
 *
 * Accepts inbound SIP calls, uses rtpengine to extract audio,
 * and streams it bidirectionally to the Nova Sonic voice agent.
 *
 * Audio flow:
 *   Caller → RTP (μ-law 8kHz) → rtpengine → RTP → this app (UDP recv)
 *   → convert to PCM 16kHz → base64 → AgentCore WebSocket
 *
 *   AgentCore → base64 PCM 16kHz → this app → convert to μ-law → RTP
 *   → rtpengine → RTP → Caller
 */

const Srf = require('drachtio-srf');
const RtpEngineClient = require('rtpengine-client').Client;
const WebSocket = require('ws');
const pino = require('pino');
const http = require('http');
const dgram = require('dgram');
const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const { DynamoDBClient, ScanCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

// --- Load config from AWS Secrets Manager (if configured) ------------------
// When CONFIG_SECRET_NAME is set, the bridge's configuration is stored as a JSON
// secret (written by configure.sh) rather than in env vars or on disk. We fetch
// it synchronously at startup and merge it into process.env so every existing
// process.env read below works unchanged. Env vars still work as a fallback for
// local development (no CONFIG_SECRET_NAME set).
(function loadConfigFromSecretsManager() {
  const secretName = process.env.CONFIG_SECRET_NAME;
  if (!secretName) return;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'aws',
      [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        secretName,
        '--region',
        region,
        '--query',
        'SecretString',
        '--output',
        'text',
      ],
      { encoding: 'utf8' }
    );
    const cfg = JSON.parse(out);
    // The bridge reads the public IP from SIP_PUBLIC_IP; the stored config uses
    // PUBLIC_IP (matching .env.example). Map it so both names work.
    if (cfg.PUBLIC_IP && cfg.SIP_PUBLIC_IP === undefined) {
      cfg.SIP_PUBLIC_IP = cfg.PUBLIC_IP;
    }
    for (const [k, v] of Object.entries(cfg)) {
      // Do not clobber an explicitly-set env var.
      if (process.env[k] === undefined && v !== null && v !== undefined) {
        process.env[k] = String(v);
      }
    }
    // eslint-disable-next-line no-console
    console.error(`Loaded bridge configuration from Secrets Manager: ${secretName}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `Failed to load config from Secrets Manager (${secretName}): ${e.message}`
    );
  }
})();

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Configuration
const DRACHTIO_HOST = process.env.DRACHTIO_HOST || 'localhost';
const DRACHTIO_PORT = parseInt(process.env.DRACHTIO_PORT || '9022');
const DRACHTIO_SECRET = process.env.DRACHTIO_SECRET || 'cymru';
const RTPENGINE_HOST = process.env.RTPENGINE_HOST || 'localhost';
const RTPENGINE_PORT = parseInt(process.env.RTPENGINE_PORT || '22222');
const AGENT_WS_URL = process.env.AGENT_WS_URL || '';
const AGENTCORE_RUNTIME_ARN = process.env.AGENTCORE_RUNTIME_ARN || '';
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const PORT = parseInt(process.env.PORT || '3000');
const DEMOS_TABLE = process.env.DEMOS_TABLE || 'voice-agent-poc-demos';

// DynamoDB client
const dynamoClient = new DynamoDBClient({ region: AWS_REGION });

/**
 * Look up agent config from DynamoDB by called number.
 * Returns the most recently updated demo with telephonyEnabled.
 */
async function getAgentConfig() {
  try {
    const result = await dynamoClient.send(new ScanCommand({ TableName: DEMOS_TABLE }));
    const items = (result.Items || []).map(item => unmarshall(item));

    const matching = items.filter(item => {
      const config = item.config || {};
      // Match by sipEnabled flag — just find the agent marked for SIP
      return config.sipEnabled === true;
    });

    matching.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    if (matching.length > 0) {
      const demo = matching[0];
      const config = demo.config || {};
      logger.info({ demoId: demo.id, name: demo.name }, 'Agent config loaded from DB');
      return {
        systemPrompt: config.systemPrompt || 'You are a helpful voice assistant.',
        greeting: config.greeting || 'Hi there! How can I help?',
        voiceId: config.voice?.voiceId || 'tiffany',
        tools: config.tools || [],
        agentStartFirst: config.agentStartFirst ?? true,
        model: config.model || ['nova-2-sonic'],
      };
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'DynamoDB lookup failed — using defaults');
  }
  return {
    systemPrompt: 'You are a helpful voice assistant. Keep responses very short — one or two sentences max.',
    greeting: 'Hi there! How can I help?',
    voiceId: 'tiffany',
    tools: [],
    agentStartFirst: true,
    model: ['nova-2-sonic'],
  };
}

// μ-law decoding table (ITU-T G.711)
const MULAW_DECODE = new Int16Array(256);
(function buildMulawTable() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xFF;
    let sign = (mu & 0x80) ? -1 : 1;
    let exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0F;
    let sample = (mantissa * 2 + 33) * (1 << exponent) - 33;
    MULAW_DECODE[i] = sign * sample;
  }
})();

// PCM 16-bit → μ-law encoding
function pcmToMulaw(pcmBuffer) {
  const samples = pcmBuffer.length / 2;
  const mulaw = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    let sample = pcmBuffer.readInt16LE(i * 2);
    // Bias
    let sign = (sample < 0) ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    sample = Math.min(sample + 132, 32767);
    // Find exponent and mantissa
    let exponent = 7;
    let mask = 0x4000;
    while (exponent > 0 && !(sample & mask)) {
      exponent--;
      mask >>= 1;
    }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    mulaw[i] = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  }
  return mulaw;
}

// μ-law → PCM 16-bit decoding
function mulawToPcm(mulawBuffer) {
  const pcm = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm.writeInt16LE(MULAW_DECODE[mulawBuffer[i]], i * 2);
  }
  return pcm;
}

// Linear interpolation between the 8 kHz phone boundary and the model rate.
function resamplePcm16(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inputSamples = Math.floor(pcm.length / 2);
  if (inputSamples === 0) return Buffer.alloc(0);
  const outputSamples = Math.max(1, Math.round(inputSamples * toRate / fromRate));
  const output = Buffer.alloc(outputSamples * 2);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outputSamples; i++) {
    const position = Math.min(i * ratio, inputSamples - 1);
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, inputSamples - 1);
    const fraction = position - lower;
    const a = pcm.readInt16LE(lower * 2);
    const b = pcm.readInt16LE(upper * 2);
    output.writeInt16LE(Math.round(a + (b - a) * fraction), i * 2);
  }
  return output;
}

/**
 * Generate a SigV4 presigned WebSocket URL for AgentCore.
 */
async function getPresignedAgentCoreUrl() {
  if (!AGENTCORE_RUNTIME_ARN) {
    return AGENT_WS_URL || 'ws://localhost:8081/ws';
  }

  const host = `bedrock-agentcore.${AWS_REGION}.amazonaws.com`;
  const path = `/runtimes/${AGENTCORE_RUNTIME_ARN}/ws`;

  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: host,
    path,
    headers: { host },
  });

  const signer = new SignatureV4({
    credentials: fromNodeProviderChain(),
    region: AWS_REGION,
    service: 'bedrock-agentcore',
    sha256: Sha256,
  });

  const signed = await signer.presign(request, { expiresIn: 300 });
  const query = Object.entries(signed.query || {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `wss://${host}${path}?${query}`;
}

// Initialize drachtio SRF
const srf = new Srf();
srf.connect({
  host: DRACHTIO_HOST,
  port: DRACHTIO_PORT,
  secret: DRACHTIO_SECRET,
});

srf.on('connect', (err, hp) => {
  if (err) {
    logger.error({ err }, 'Failed to connect to drachtio');
    process.exit(1);
  }
  logger.info({ hostport: hp }, 'Connected to drachtio');
});

// Initialize rtpengine client
const rtpEngine = new RtpEngineClient();
rtpEngine.on('error', (err) => {
  logger.warn({ err: err.message }, 'rtpengine client error (non-fatal)');
});

// Shared RTP socket — one socket for all calls (avoids port reuse issues)
const RTP_PORT = 20000;
const sharedRtpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sharedRtpSocket.bind(RTP_PORT, '0.0.0.0', () => {
  logger.info({ port: RTP_PORT }, 'Shared RTP socket bound');
});

// Active call state — tracks current call's message handler
let activeCallHandler = null;

/**
 * Parse SDP to extract media port and IP
 */
function parseSdpMedia(sdp) {
  const lines = sdp.split('\r\n');
  let ip = null;
  let port = null;
  for (const line of lines) {
    if (line.startsWith('c=IN IP4 ')) {
      ip = line.split(' ')[2];
    }
    if (line.startsWith('m=audio ')) {
      port = parseInt(line.split(' ')[1]);
    }
  }
  return { ip, port };
}

/**
 * Build a minimal RTP packet
 */
let rtpSeq = 0;
let rtpTimestamp = 0;
const RTP_SSRC = Math.floor(Math.random() * 0xFFFFFFFF);

function buildRtpPacket(payload) {
  // RTP header: V=2, P=0, X=0, CC=0, M=0, PT=0 (PCMU)
  const header = Buffer.alloc(12);
  header[0] = 0x80; // V=2
  header[1] = 0x00; // PT=0 (PCMU)
  header.writeUInt16BE(rtpSeq & 0xFFFF, 2);
  header.writeUInt32BE(rtpTimestamp & 0xFFFFFFFF, 4);
  header.writeUInt32BE(RTP_SSRC, 8);
  rtpSeq++;
  rtpTimestamp += payload.length; // 160 samples per 20ms at 8kHz
  return Buffer.concat([header, payload]);
}

/**
 * Handle incoming SIP INVITE
 */
srf.invite(async (req, res) => {
  const callId = req.get('Call-ID');
  const from = req.getParsedHeader('From').uri;
  const to = req.getParsedHeader('To').uri;
  const sdp = req.body;

  logger.info({ callId, from, to, hasSdp: !!sdp, sdpLen: sdp ? sdp.length : 0 }, 'Incoming SIP call');

  try {
    if (!sdp) {
      logger.error({ callId }, 'No SDP body in INVITE');
      return res.send(400);
    }

    // Send 180 Ringing while we warm up AgentCore
    res.send(180);
    logger.info({ callId }, 'Sent 180 Ringing — warming up AgentCore');

    // Look up agent config from DynamoDB (sipEnabled flag)
    const agentConfig = await getAgentConfig();

    // Step 1: Connect to AgentCore and send session config (warm-up)
    const agentUrl = await getPresignedAgentCoreUrl();
    const agentWs = new WebSocket(agentUrl);

    // Wait for WebSocket to open
    await new Promise((resolve, reject) => {
      agentWs.on('open', resolve);
      agentWs.on('error', reject);
      setTimeout(() => reject(new Error('Agent connection timeout')), 10000);
    });

    logger.info({ callId }, 'AgentCore WebSocket connected — sending config');

    // Send session config
    agentWs.send(JSON.stringify({
      type: 'sessionConfig',
      clientId: callId,
      source: 'sip',
      host: 'agentcore',
      framework: 'strands-bidiagent',
      model: agentConfig.model,
      apiKeys: {
        ...(process.env.OPENAI_API_KEY ? { openai: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.GOOGLE_API_KEY ? { gemini: process.env.GOOGLE_API_KEY } : {}),
      },
      systemPrompt: agentConfig.systemPrompt,
      pipeline: 'speech-to-speech',
      voice: { voiceId: agentConfig.voiceId, language: 'en-US', gender: 'female' },
      tools: agentConfig.tools,
      greeting: agentConfig.greeting,
      agentStartFirst: agentConfig.agentStartFirst,
      callHistoryEnabled: true,
      callerId: from,
      sip: { callId, from, to },
    }));

    // Wait for agent ready message
    const readyMessage = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Agent ready timeout')), 30000);
      agentWs.on('message', function onReady(data) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'system' || msg.type === 'ready') {
            clearTimeout(timeout);
            agentWs.removeListener('message', onReady);
            logger.info({ callId, msg: msg.message || msg.type }, 'Agent ready');
            resolve(msg);
          }
        } catch (e) { /* ignore parse errors */ }
      });
    });
    const inputSampleRate = Number(readyMessage.inputSampleRate) || 16000;
    const outputSampleRate = Number(readyMessage.outputSampleRate) || 16000;
    logger.info({ callId, inputSampleRate, outputSampleRate }, 'Negotiated agent audio rates');

    // Give the agent's internal run loop time to start accepting audio
    // Wait for first audio output (greeting) which confirms the loop is running
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000); // max 5s wait
      const earlyListener = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'bidi_audio_stream') {
            clearTimeout(timeout);
            agentWs.removeListener('message', earlyListener);
            logger.info({ callId }, 'Agent greeting audio started — loop confirmed running');
            resolve();
          }
        } catch (e) {}
      };
      agentWs.on('message', earlyListener);
    });

    // Step 2: Use shared RTP socket (persistent, avoids port reuse issues)
    const rtpSocket = sharedRtpSocket;
    const localRtpPort = RTP_PORT;

    // Remove any previous call's message handler
    if (activeCallHandler) {
      rtpSocket.removeListener('message', activeCallHandler);
      activeCallHandler = null;
    }

    // Step 3: Get public IP for SDP (resolve NLB DNS, or fallback to EC2 metadata)
    let publicIp = process.env.SIP_PUBLIC_IP || '';
    if (!publicIp && process.env.NLB_DNS) {
      // Resolve NLB DNS to get the public IP
      const dns = require('dns');
      try {
        const addresses = await new Promise((resolve, reject) => {
          dns.resolve4(process.env.NLB_DNS, (err, addrs) => err ? reject(err) : resolve(addrs));
        });
        publicIp = addresses[0];
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to resolve NLB DNS');
      }
    }
    if (!publicIp) {
      try {
        const tokenRes = await fetch('http://169.254.169.254/latest/api/token', {
          method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }
        });
        const token = await tokenRes.text();
        const ipRes = await fetch('http://169.254.169.254/latest/meta-data/public-ipv4', {
          headers: { 'X-aws-ec2-metadata-token': token }
        });
        publicIp = await ipRes.text();
      } catch (e) {
        publicIp = RTPENGINE_HOST;
      }
    }

    const ourSdp = [
      'v=0',
      `o=- ${Date.now()} 1 IN IP4 ${publicIp}`,
      's=-',
      `c=IN IP4 ${publicIp}`,
      't=0 0',
      `m=audio ${localRtpPort} RTP/AVP 0`,
      'a=rtpmap:0 PCMU/8000',
      'a=ptime:20',
      'a=sendrecv',
      '',
    ].join('\r\n');

    // Step 4: Answer the SIP call (200 OK) — agent is now ready
    // Use manual response to avoid drachtio's ACK timeout killing the call
    const dialog = await srf.createUAS(req, res, {
      localSdp: ourSdp,
      headers: {
        'Contact': `<sip:${publicIp}:5060;transport=udp>`,
      },
    });

    logger.info({ callId, publicIp, localRtpPort }, 'Call answered — audio bridge starting');

    // Parse caller's SDP for RTP send target
    const callerMedia = parseSdpMedia(sdp);
    let rtpRemotePort = callerMedia.port;
    let rtpRemoteAddr = callerMedia.ip;

    // Step 5: Audio bridge — RTP ↔ AgentCore
    let rtpPacketCount = 0;

    // Send silence (comfort noise) to Twilio every 20ms to prevent media timeout
    // Twilio disconnects if it doesn't receive RTP for ~30s
    const SILENCE_MULAW = Buffer.alloc(160, 0xFF); // 0xFF = silence in μ-law
    const silenceTimer = setInterval(() => {
      if (rtpRemotePort && rtpRemoteAddr && rtpSendQueue.length === 0) {
        // Only send silence when not actively sending agent audio
        const rtpPacket = buildRtpPacket(SILENCE_MULAW);
        rtpSocket.send(rtpPacket, rtpRemotePort, rtpRemoteAddr);
      }
    }, 20);

    // Receive RTP from caller → forward to AgentCore
    // Buffer into 100ms chunks to match Nova Sonic's expected input size
    let audioBuffer = Buffer.alloc(0);
    const BATCH_SIZE = 160 * 5; // 5 packets = 100ms at 8kHz = 1600 bytes PCM16k

    activeCallHandler = (msg, rinfo) => {
      rtpPacketCount++;
      if (rtpPacketCount === 1) {
        rtpRemotePort = rinfo.port;
        rtpRemoteAddr = rinfo.address;
        logger.info({ callId, rtpRemotePort, rtpRemoteAddr }, 'First RTP packet — audio flowing');
      }

      if (msg.length <= 12) return;
      const payload = msg.slice(12);
      if (payload.length === 0) return;

      // Accumulate μ-law samples
      audioBuffer = Buffer.concat([audioBuffer, payload]);

      // Send when we have 100ms worth
      if (audioBuffer.length >= BATCH_SIZE) {
        const batch = audioBuffer.slice(0, BATCH_SIZE);
        audioBuffer = audioBuffer.slice(BATCH_SIZE);
        const pcm8k = mulawToPcm(batch);
        const modelPcm = resamplePcm16(pcm8k, 8000, inputSampleRate);

        // Add comfort noise dither to pure silence — prevents near-zero PCM
        // that Nova Sonic may misinterpret (web/TAC always have ambient room noise)
        for (let i = 0; i < modelPcm.length; i += 2) {
          const sample = modelPcm.readInt16LE(i);
          if (sample > -10 && sample < 10) {
            modelPcm.writeInt16LE(Math.floor(Math.random() * 20) - 10, i);
          }
        }

        const pcmB64 = modelPcm.toString('base64');

        try {
          if (agentWs.readyState === WebSocket.OPEN) {
            agentWs.send(JSON.stringify({
              type: 'bidi_audio_input',
              audio: pcmB64,
              format: 'pcm',
              sample_rate: inputSampleRate,
              channels: 1,
            }));
          }
        } catch (e) { /* ignore */ }
      }
    };
    rtpSocket.on('message', activeCallHandler);

    // Receive audio from AgentCore → send as RTP to caller
    // Buffer and pace RTP packets at 20ms intervals (real-time playback)
    let rtpSendQueue = [];
    let rtpSendTimer = null;

    function startRtpPacing() {
      if (rtpSendTimer) return;
      rtpSendTimer = setInterval(() => {
        if (rtpSendQueue.length === 0) return;
        const chunk = rtpSendQueue.shift();
        const rtpPacket = buildRtpPacket(chunk);
        rtpSocket.send(rtpPacket, rtpRemotePort, rtpRemoteAddr);
      }, 20); // Send one packet every 20ms
    }

    agentWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'bidi_audio_stream' && msg.audio) {
          if (rtpRemotePort && rtpRemoteAddr) {
            const modelPcm = Buffer.from(msg.audio, 'base64');
            const pcm8k = resamplePcm16(modelPcm, outputSampleRate, 8000);
            const mulaw = pcmToMulaw(pcm8k);

            // Queue 20ms chunks (160 bytes each) for paced sending
            for (let offset = 0; offset < mulaw.length; offset += 160) {
              const chunk = mulaw.slice(offset, Math.min(offset + 160, mulaw.length));
              if (chunk.length === 160) {
                rtpSendQueue.push(chunk);
              }
            }
            startRtpPacing();
          }
        } else if (msg.type === 'bidi_interruption') {
          // User barged in — clear queued audio
          rtpSendQueue = [];
          logger.info({ callId }, 'Barge-in — cleared audio queue');
        } else if (msg.type === 'error') {
          logger.error({ callId, error: msg.message }, 'Agent error');
        }
      } catch (e) { /* ignore */ }
    });

    agentWs.on('error', (err) => {
      logger.error({ callId, err: err.message }, 'Agent WebSocket error');
    });

    agentWs.on('close', () => {
      logger.info({ callId }, 'Agent WebSocket closed');
    });

    // Step 6: Handle call hangup
    dialog.on('destroy', async () => {
      logger.info({ callId, rtpPacketCount }, 'Call ended');
      clearInterval(silenceTimer);
      if (rtpSendTimer) clearInterval(rtpSendTimer);
      rtpSendQueue = [];
      // Remove this call's message handler (don't close shared socket)
      if (activeCallHandler) {
        rtpSocket.removeListener('message', activeCallHandler);
        activeCallHandler = null;
      }
      if (agentWs.readyState === WebSocket.OPEN) {
        agentWs.send(JSON.stringify({ type: 'sessionEnd' }));
        agentWs.close();
      }
    });

  } catch (err) {
    logger.error({ callId, err: err.message, stack: err.stack }, 'Failed to handle call');
    try { res.send(500); } catch (e) { /* ignore */ }
  }
});

// Health check HTTP server
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      drachtio: srf._conn ? 'connected' : 'disconnected',
      agent_url: AGENTCORE_RUNTIME_ARN || AGENT_WS_URL || 'not configured',
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(PORT, () => {
  logger.info({ port: PORT, agentcore: AGENTCORE_RUNTIME_ARN || 'none', agent: AGENT_WS_URL || 'none' }, 'SIP bridge started');
});
