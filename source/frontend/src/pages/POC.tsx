import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useWizard } from '../context/WizardContext';
import { useAuth } from '../context/AuthContext';
import { createDemo, updateDemo, getDemo, wizardStateToConfig } from '../services/demosApi';
import { getAgentCoreWsUrl } from '../services/presignWs';
import { listTools } from '../services/toolsApi';
import type { SavedTool } from '../services/toolsApi';
import { notifyAgentListChanged } from '../events/agentEvents';
import PageWrapper from '../components/PageWrapper';
import styles from './POC.module.css';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface TranscriptEntry {
  role: 'user' | 'agent';
  text: string;
  timestamp: Date;
  type?: 'tool';
}

// Default WebSocket endpoint — reads from env or falls back to localhost
const DEFAULT_WS_URL = import.meta.env.VITE_AGENTCORE_WS_URL || 'ws://localhost:8081/ws';

function POC() {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, dispatch } = useWizard();
  const { user, refreshToken } = useAuth();
  const isFromSavedAgent = !!(location.state as any)?.fromSavedAgent;
  const agentName = (location.state as any)?.agentName || state.editingDemoName || '';

  // Persist editingDemoId to sessionStorage so page refresh can restore agent config
  useEffect(() => {
    if (state.editingDemoId) {
      sessionStorage.setItem('poc_editing_demo_id', state.editingDemoId);
      if (state.editingDemoName) sessionStorage.setItem('poc_editing_demo_name', state.editingDemoName);
    }
  }, [state.editingDemoId, state.editingDemoName]);

  // Restore agent from sessionStorage on mount if wizard state is empty (page refresh)
  useEffect(() => {
    if (!state.editingDemoId && !state.prompt.instructions) {
      const savedId = sessionStorage.getItem('poc_editing_demo_id');
      const savedName = sessionStorage.getItem('poc_editing_demo_name');
      if (savedId) {
        dispatch({ type: 'SET_EDITING_DEMO', payload: { id: savedId, name: savedName || '' } });
        getDemo(savedId).then((demo) => {
          const config = demo.config;
          dispatch({ type: 'SET_HOST', payload: (config.host || 'agentcore') as any });
          dispatch({ type: 'SET_FRAMEWORK', payload: (config.framework || 'strands-bidiagent') as any });
          dispatch({ type: 'SET_MODEL', payload: config.model || ['nova-2-sonic'] });
          dispatch({ type: 'SET_PIPELINE', payload: (config.pipeline || 'speech-to-speech') as any });
          dispatch({ type: 'SET_VOICE', payload: config.voice || { voiceId: '', language: 'en-US', gender: 'female' } });
          dispatch({ type: 'SET_AGENTS', payload: { selectedAgents: config.tools || [], customTools: config.customTools || [] } });
          dispatch({ type: 'SET_PROMPT', payload: config.prompt || { greeting: config.greeting || '', instructions: config.systemPrompt || '' } });
          dispatch({ type: 'SET_TELEPHONY_ENABLED', payload: config.telephonyEnabled ?? false });
          dispatch({ type: 'SET_AGENT_START_FIRST', payload: config.agentStartFirst ?? true });
          dispatch({ type: 'SET_PHONE', payload: config.telephony?.phoneNumber || '' });
          dispatch({ type: 'SET_USE_MOCK', payload: config.useMock ?? true });
          dispatch({ type: 'SET_CALL_HISTORY_ENABLED', payload: (config as any).callHistoryEnabled ?? true });
          dispatch({ type: 'SET_CALL_LOG_ENABLED', payload: (config as any).callLogEnabled ?? false });
        }).catch(() => {});
      }
    }
  }, []);

  const formatPhoneNumber = (phone: string) => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return phone;
  };

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [showReport, setShowReport] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [availableTools, setAvailableTools] = useState<SavedTool[]>([]);
  const [chatPopupOpen, setChatPopupOpen] = useState(false);

  useEffect(() => {
    listTools().then(setAvailableTools).catch(() => {});
    // Always fetch fresh agent config for display (avoid stale wizard state)
    if (state.editingDemoId) {
      getDemo(state.editingDemoId).then((demo) => {
        const config = demo.config;
        const prompt = config.prompt?.instructions || config.systemPrompt || '';
        const tools = config.tools || [];
        const customTools = config.customTools || [];
        // Update wizard state to match latest saved config
        dispatch({ type: 'SET_PROMPT', payload: { greeting: config.prompt?.greeting || '', instructions: prompt } });
        dispatch({ type: 'SET_AGENTS', payload: { selectedAgents: tools, customTools } });
        if (config.useMock !== undefined) dispatch({ type: 'SET_USE_MOCK', payload: config.useMock });
      }).catch(() => {});
    }
  }, []);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [textInput, setTextInput] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const audioPlayerRef = useRef<AudioContext | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const isRecordingRef = useRef(false);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  // Cleanup on unmount (navigating away)
  useEffect(() => {
    return () => {
      isRecordingRef.current = false;
      processorRef.current?.disconnect();
      audioContextRef.current?.close().catch(() => {});
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioPlayerRef.current?.close().catch(() => {});
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.onclose = null;
        wsRef.current.send(JSON.stringify({ type: 'sessionEnd' }));
        wsRef.current.close(1000, 'Navigation');
      }
    };
  }, []);

  const generateSystemPrompt = useCallback(() => {
    const parts: string[] = [];
    if (state.prompt.instructions) {
      parts.push(state.prompt.instructions);
    }
    if (state.prompt.greeting) {
      parts.push(`Greeting: "${state.prompt.greeting}"`);
    }
    return parts.join('\n') || 'You are a helpful voice agent.';
  }, [state.prompt]);

  const handleServerMessage = (data: any) => {
    switch (data.type) {
      case 'sessionReady':
      case 'system':
        console.log('System:', data.message || data.config);
        // The agent reports the model's output sample rate so we play audio back
        // at the right rate (Nova Sonic 16 kHz; OpenAI Realtime / Gemini Live 24 kHz).
        // Input/capture rate is set synchronously at connect time from the
        // selected model, so we don't override it here.
        if (typeof data.outputSampleRate === 'number' && data.outputSampleRate > 0) {
          outputSampleRateRef.current = data.outputSampleRate;
        }
        break;
      case 'bidi_audio_stream':
        // Audio response from Nova Sonic
        playAudioBase64(data.audio);
        setAgentSpeaking(true);
        break;
      case 'bidi_transcript_stream':
        // Display speculative transcripts only. Nova Sonic emits both a
        // speculative and a final transcript per turn (for both user and agent);
        // showing both duplicates every line, so skip the finals for both roles.
        if (data.is_final) break;
        if (data.text && data.text.trim()) {
          setTranscript((prev) => [
            ...prev,
            { role: (data.role === 'assistant' ? 'agent' : data.role) as 'user' | 'agent', text: data.text, timestamp: new Date() },
          ]);
        }
        if (data.role === 'assistant' || data.role === 'agent') {
          setAgentSpeaking(true);
        }
        break;
      case 'bidi_interruption':
        // User barged in — stop audio playback
        stopAudioPlayback();
        break;
      case 'transcript':
        // Legacy format (greeting)
        setTranscript((prev) => [
          ...prev,
          {
            role: data.role as 'user' | 'agent',
            text: data.text,
            timestamp: new Date(),
          },
        ]);
        break;
      case 'agentStartSpeaking':
        setAgentSpeaking(true);
        break;
      case 'agentStopSpeaking':
        setAgentSpeaking(false);
        break;
      case 'error':
        setError(data.message || 'Server error');
        break;
      case 'tool_call':
        // Debug: tool was invoked by the agent
        setTranscript((prev) => [
          ...prev,
          { role: 'agent', text: `🔧 [${data.tool}] ${Object.keys(data.args || {}).length > 0 ? JSON.stringify(data.args) : ''}`, timestamp: new Date(), type: 'tool' },
        ]);
        break;
      case 'tool_result':
        // Debug: tool returned a result
        // Skip protocol-level tool_result messages (from BidiAgent framework) that don't have our 'tool' field
        if (data.tool) {
          setTranscript((prev) => [
            ...prev,
            { role: 'agent', text: `✅ [${data.tool}] → ${data.result || ''}`, timestamp: new Date(), type: 'tool' },
          ]);
        }
        // else: protocol tool_result (has toolUseId/content) — already shown via our _notify_tool_result
        break;
      case 'sessionEnd':
        // Agent ended the call via end_call tool
        setTranscript((prev) => [
          ...prev,
          { role: 'agent', text: '📞 Call ended.', timestamp: new Date() },
        ]);
        stopAudioPlayback();
        setConnectionStatus('disconnected');
        if (wsRef.current) {
          wsRef.current.close(1000, 'agent_ended');
          wsRef.current = null;
        }
        break;
      case 'transfer':
        // Agent transferred to human via transfer_to_human tool
        setTranscript((prev) => [
          ...prev,
          { role: 'agent', text: `🔄 Transferring to a human agent${data.reason ? `: ${data.reason}` : ''}.`, timestamp: new Date() },
        ]);
        stopAudioPlayback();
        setConnectionStatus('disconnected');
        if (wsRef.current) {
          wsRef.current.close(1000, 'transfer');
          wsRef.current = null;
        }
        break;
    }
  };

  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef(0);
  // Sample rates negotiated with the agent's "system" ready message. Nova Sonic
  // is 16 kHz; OpenAI Realtime and Gemini Live are 24 kHz. Default to 16 kHz
  // until the agent tells us otherwise.
  const outputSampleRateRef = useRef(16000);
  const inputSampleRateRef = useRef(16000);

  const playAudioBase64 = async (base64Audio: string) => {
    try {
      if (!audioPlayerRef.current) {
        audioPlayerRef.current = new AudioContext({ sampleRate: outputSampleRateRef.current });
        nextPlayTimeRef.current = 0;
        activeSourcesRef.current = 0;
      }

      if (audioPlayerRef.current.state === 'suspended') {
        await audioPlayerRef.current.resume();
      }

      // Decode base64 to Int16 PCM
      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const int16Data = new Int16Array(bytes.buffer);

      // Convert Int16 to Float32
      const float32Data = new Float32Array(int16Data.length);
      for (let i = 0; i < int16Data.length; i++) {
        float32Data[i] = int16Data[i] / 32768.0;
      }

      // Create AudioBuffer at the model's output rate
      const buffer = audioPlayerRef.current.createBuffer(1, float32Data.length, outputSampleRateRef.current);
      buffer.getChannelData(0).set(float32Data);

      const currentTime = audioPlayerRef.current.currentTime;
      if (nextPlayTimeRef.current < currentTime) {
        nextPlayTimeRef.current = currentTime + 0.05;
      }

      // Schedule playback
      const source = audioPlayerRef.current.createBufferSource();
      source.buffer = buffer;
      source.connect(audioPlayerRef.current.destination);
      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += buffer.duration;

      activeSourcesRef.current++;
      source.onended = () => {
        activeSourcesRef.current--;
        if (activeSourcesRef.current <= 0) {
          activeSourcesRef.current = 0;
          setAgentSpeaking(false);
        }
      };
    } catch {
      // Audio playback error — non-fatal
    }
  };

  const stopAudioPlayback = () => {
    setAgentSpeaking(false);
    nextPlayTimeRef.current = 0;
    activeSourcesRef.current = 0;
    if (audioPlayerRef.current) {
      // Close immediately — this kills all scheduled/playing audio sources
      audioPlayerRef.current.close().catch(() => {});
      audioPlayerRef.current = null;
    }
  };

  const startAudioCapture = async () => {
    try {
      // Capture at the model's input rate (Nova 16 kHz; OpenAI/Gemini 24 kHz).
      const captureRate = inputSampleRateRef.current || 16000;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: captureRate,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: captureRate });
      audioContextRef.current = audioContext;

      // Resume context (required by some browsers after user gesture)
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!isRecordingRef.current) return;
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Calculate audio level for visualization
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        setAudioLevel(Math.min(1, rms * 10));

        // Resample to the model's input rate and convert to Int16 PCM
        const SAMPLE_RATE = captureRate;
        const downsampleRatio = audioContext.sampleRate / SAMPLE_RATE;
        const outputLength = Math.floor(inputData.length / downsampleRatio);
        const int16Data = new Int16Array(outputLength);

        for (let i = 0; i < outputLength; i++) {
          const sourceIndex = Math.floor(i * downsampleRatio);
          int16Data[i] = Math.max(-32768, Math.min(32767,
            inputData[sourceIndex] * 32768));
        }

        // Convert Int16Array to base64
        const bytes = new Uint8Array(int16Data.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64Audio = btoa(binary);

        // Send as JSON event (BidiAgent protocol)
        wsRef.current.send(JSON.stringify({
          type: 'bidi_audio_input',
          audio: base64Audio,
          format: 'pcm',
          sample_rate: SAMPLE_RATE,
          channels: 1,
        }));
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
      isRecordingRef.current = true;
      setIsRecording(true);
      console.log('Audio capture started');
    } catch (err) {
      setError(
        'Microphone access denied. Please allow microphone access and try again.'
      );
    }
  };

  const stopAudioCapture = () => {
    isRecordingRef.current = false;
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    setIsRecording(false);
    setAudioLevel(0);
  };

  const handleStartConversation = async () => {
    setError(null);
    setTranscript([]);

    // Clean up any existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    setConnectionStatus('connecting');

    try {
      // Refresh token before generating presigned URL (handles expired sessions)
      const freshToken = await refreshToken();

      // Generate a fresh presigned URL (or fall back to static URL for local dev)
      const connectionUrl = await getAgentCoreWsUrl(freshToken || user?.token || '');

      // Connect with retry for cold starts (AgentCore can take 30-60s on first invocation)
      let ws: WebSocket | null = null;
      let connected = false;
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts && !connected; attempt++) {
        const url = attempt === 1 ? connectionUrl : await getAgentCoreWsUrl(freshToken || user?.token || '');
        ws = new WebSocket(url);
        wsRef.current = ws;

        try {
          await new Promise<void>((resolve, reject) => {
            ws!.onopen = () => { connected = true; resolve(); };
            ws!.onerror = () => reject(new Error('WebSocket connection failed'));
            setTimeout(() => reject(new Error('Connection timeout')), 30000);
          });
        } catch (err) {
          if (attempt < maxAttempts) {
            console.log(`Attempt ${attempt} failed (cold start?), retrying...`);
            ws?.close();
            await new Promise(r => setTimeout(r, 2000));
          } else {
            throw err;
          }
        }
      }

      if (!ws || !connected) throw new Error('Failed to connect after retries');

      setConnectionStatus('connected');

      // Set up message handler
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleServerMessage(data);
        } catch {
          // Non-JSON data (shouldn't happen with BidiAgent)
          console.warn('Received non-JSON message:', event.data);
        }
      };

      // Set up close handler
      ws.onclose = (event) => {
        setConnectionStatus('disconnected');
        isRecordingRef.current = false;
        setIsRecording(false);
        setAudioLevel(0);
        if (event.code !== 1000) {
          setError(
            `Connection closed (code ${event.code}). ${event.reason || 'Check server status.'}`
          );
        }
      };

      ws.onerror = () => {
        setConnectionStatus('error');
        setError('WebSocket error occurred.');
      };

      // Send session config
      // Resolve tools: fetch fresh config from DB to avoid stale wizard state
      let agentConfig: any = null;
      if (state.editingDemoId) {
        try {
          const demo = await getDemo(state.editingDemoId);
          agentConfig = demo.config;
        } catch (e) {
          console.warn('Failed to fetch agent config from DB, using wizard state');
        }
      }

      // Use DB config if available, fall back to wizard state
      const configTools = agentConfig?.tools || state.agents.selectedAgents;
      const configCustomTools = agentConfig?.customTools || state.agents.customTools || [];
      const configSystemPrompt = agentConfig?.prompt?.instructions || agentConfig?.systemPrompt || generateSystemPrompt();
      const configVoice = agentConfig?.voice || state.voice;

      const configInferenceConfig = agentConfig?.inferenceConfig || state.inferenceConfig || undefined;

      // Resolve int:GUID tool references to full tool specs for the runtime
      const resolvedTools = configTools
        .filter((id: string) => id.startsWith('int:'))
        .map((id: string) => {
          const tool = availableTools.find((t) => `int:${t.id}` === id || t.id === id);
          if (!tool) return null;
          const spec: any = {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || '',
          };
          // Only include mockResponse when mock mode is enabled
          if (state.useMock) {
            spec.mockResponse = tool.mockResponse || 'Tool executed successfully.';
          } else {
            // In live mode, include endpoint/arn/gatewayId so the runtime can call it
            if (tool.endpoint) spec.endpoint = tool.endpoint;
            if (tool.method) spec.method = tool.method;
            if (tool.functionArn) spec.functionArn = tool.functionArn;
            // Route by tool type: subagent uses A2A, mcp uses gateway
            if (tool.type === 'subagent' && tool.gatewayId) {
              spec.subagentArn = tool.gatewayId; // gatewayId stores runtime name for subagents
            } else if (tool.gatewayId) {
              spec.gatewayId = tool.gatewayId;
            }
            if ((tool as any).subagentArn) spec.subagentArn = (tool as any).subagentArn;
            if ((tool as any).skillPath) spec.skillPath = (tool as any).skillPath;
            // If no real integration configured, still include mock as fallback
            if (!tool.endpoint && !tool.functionArn && !tool.gatewayId && !(tool as any).subagentArn && !(tool as any).skillPath) {
              spec.mockResponse = tool.mockResponse || 'Tool executed successfully.';
            }
          }
          return spec;
        })
        .filter(Boolean);

      // Combine with any existing customTools from DB config
      const allCustomTools = [
        ...configCustomTools,
        ...resolvedTools,
      ];

      // Non-int tools (built-in registry names like "crm", "transfer")
      const builtinTools = configTools.filter((id: string) => !id.startsWith('int:'));

      // Extract gateway IDs for auto-discovery (passed in tools array since AgentCore strips customTools)
      const gatewayIds = allCustomTools
        .filter((t: any) => t.gatewayId && !t.mockResponse)
        .map((t: any) => `gateway:${t.gatewayId}`);

      // Also embed gateway IDs in system prompt (most reliable passthrough)
      const gatewayTags = allCustomTools
        .filter((t: any) => t.gatewayId && !t.mockResponse)
        .map((t: any) => `[GATEWAY:${t.gatewayId}]`)
        .join(' ');
      const systemPromptWithGateways = gatewayTags
        ? `${configSystemPrompt}\n\n${gatewayTags}`
        : configSystemPrompt;

      // Encode tool config as JSON string in greeting field (AgentCore preserves string fields)
      // Truncate mockResponse to avoid exceeding AgentCore's 64KB WebSocket frame limit
      const toolConfigForGreeting = allCustomTools.map((t: any) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        mockResponse: t.mockResponse ? t.mockResponse.substring(0, 200) : '',
      }));
      const toolConfigPayload = toolConfigForGreeting.length > 0
        ? JSON.stringify({ customTools: toolConfigForGreeting })
        : '';

      const sessionConfig = {
        type: 'sessionConfig',
        clientId: crypto.randomUUID(),
        host: state.host,
        framework: state.framework,
        model: state.model,
        systemPrompt: systemPromptWithGateways,
        tools: [...builtinTools, ...gatewayIds],
        customTools: allCustomTools.map((t: any) => ({ name: t.name, description: t.description, parameters: t.parameters, mockResponse: (t.mockResponse || '').substring(0, 200) })),
        greeting: toolConfigPayload || state.prompt.greeting || '',
        useMock: state.useMock,
        voice: {
          voiceId: configVoice.voiceId,
          language: configVoice.language,
          gender: configVoice.gender,
        },
        pipeline: state.pipeline,
        agentStartFirst: state.agentStartFirst,
        telephony: state.phoneNumber ? {
          provider: 'twilio',
          phoneNumber: state.phoneNumber,
        } : undefined,
        apiKeys: (state.apiKeys.openai || state.apiKeys.gemini) ? {
          openai: state.apiKeys.openai || undefined,
          gemini: state.apiKeys.gemini || undefined,
        } : undefined,
        inferenceConfig: configInferenceConfig,
        callHistoryEnabled: state.callHistoryEnabled ?? true,
        callLogEnabled: state.callLogEnabled ?? false,
        agentId: state.editingDemoId || '',
        source: 'webchat',
        callerId: user?.username || user?.email || '',
      };
      console.log('[POC] Session config being sent:', { tools: builtinTools.length, customTools: allCustomTools.length, customToolNames: allCustomTools.map((t: any) => t.name) });
      ws.send(JSON.stringify(sessionConfig));

      // Determine the capture (input) rate synchronously from the selected model
      // so we can start the mic immediately — waiting on the server's ready
      // message delayed capture and clipped the start of the caller's first
      // words (garbling names/numbers for Nova). Nova = 16 kHz; OpenAI/Gemini = 24 kHz.
      const _selModel = (state.model || ['nova-2-sonic'])[0];
      inputSampleRateRef.current =
        _selModel === 'openai-realtime' || _selModel === 'gemini-live' ? 24000 : 16000;

      // Start audio capture immediately (as before the multi-provider change).
      // The server's "system" message still updates the playback rate on arrival.
      await startAudioCapture();
    } catch (err: any) {
      setConnectionStatus('error');
      setError(err?.message || 'Failed to connect to voice agent server.');
    }
  };

  // Save (or update) the current agent to the account. Available regardless of
  // whether telephony is configured — mirrors the Summary page's save logic.
  const handleSaveAgent = async () => {
    setSaving(true);
    try {
      if (state.editingDemoId) {
        // Editing an existing agent — update it in place.
        await updateDemo(state.editingDemoId, { config: wizardStateToConfig(state) });
      } else {
        // New agent — prompt for a name and create it.
        const name = window.prompt('Agent name:', state.editingDemoName || agentName || 'My Agent');
        if (!name) {
          setSaving(false);
          return;
        }
        const created = await createDemo({ name, config: wizardStateToConfig(state) });
        dispatch({ type: 'SET_EDITING_DEMO', payload: { id: created.id, name } });
      }
      setSaveSuccess(true);
      notifyAgentListChanged();
      // Reset the "Saved" confirmation after a moment so the button can be reused.
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  };

  const handleStopConversation = () => {
    if (!isRecordingRef.current && !wsRef.current) return;

    // Stop microphone capture immediately
    stopAudioCapture();

    // Stop audio playback immediately
    stopAudioPlayback();

    // Close WebSocket
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'sessionEnd' }));
      wsRef.current.onclose = null;
      wsRef.current.close(1000, 'User ended conversation');
    }
    wsRef.current = null;
    setConnectionStatus('disconnected');
    setAgentSpeaking(false);
  };

  const getSteps = () => {
    if (state.path === 'minimal') {
      return [
        { label: 'Voice', active: false, completed: true },
        { label: 'Flow', active: false, completed: true },
        { label: 'Summary', active: false, completed: true },
        { label: 'Try It', active: true, completed: false },
      ];
    }
    return [
      { label: 'Pipeline', active: false, completed: true },
      { label: 'Model', active: false, completed: true },
      { label: 'Voice', active: false, completed: true },
      { label: 'Flow', active: false, completed: true },
      { label: 'Summary', active: false, completed: true },
      { label: 'Try It', active: true, completed: false },
    ];
  };

  return (
    <PageWrapper
      title={agentName ? `Try: ${agentName}` : "Try Your Voice Agent"}
      subtitle={state.telephonyEnabled && state.phoneNumber
        ? `Test via browser mic below, or call ${formatPhoneNumber(state.phoneNumber)} from your phone.`
        : "Start a live voice conversation with your agent using your browser microphone."
      }
      steps={getSteps()}
      onBack={() => navigate('/summary')}
    >
      <div className={styles.container}>
        {/* Save agent — available regardless of telephony/channel */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginBottom: '12px' }}>
          {saveSuccess && (
            <span style={{ fontSize: '13px', color: '#16a34a', fontWeight: 600 }}>✓ Saved</span>
          )}
          <button
            className={styles.startBtn}
            onClick={handleSaveAgent}
            disabled={saving}
          >
            {saving
              ? 'Saving…'
              : state.editingDemoId
                ? '💾 Save Changes'
                : '💾 Save Agent'}
          </button>
        </div>

        {/* Channel options — side by side */}
        <div className={styles.demoInfo}>
          <div className={styles.channelGrid}>
            {/* Web Chat option */}
            <div className={`${styles.channelCard} ${!state.telephonyEnabled || !state.phoneNumber ? styles.channelActive : ''}`}>
              <div className={styles.channelIcon}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  <line x1="9" y1="10" x2="9.01" y2="10"/>
                  <line x1="12" y1="10" x2="12.01" y2="10"/>
                  <line x1="15" y1="10" x2="15.01" y2="10"/>
                </svg>
              </div>
              <h3 className={styles.channelTitle}>Web Chat</h3>
              <p className={styles.channelDesc}>Talk using your browser microphone</p>
              <button
                className={styles.startBtn}
                onClick={() => { setChatPopupOpen(true); }}
              >
                Open Chat
              </button>
            </div>

            {/* Telephony option — Twilio PSTN */}
            <div className={`${styles.channelCard} ${!(state.telephonyEnabled && state.phoneNumber) ? styles.channelDisabled : ''}`}>
              <div className={styles.channelIcon}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
              </div>
              <h3 className={styles.channelTitle}>Phone Call</h3>
              <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '-4px', marginBottom: '6px' }}>via Twilio PSTN</p>
              {!(state.telephonyEnabled && state.phoneNumber) ? (
                <p className={styles.channelDesc}>Phone number not configured</p>
              ) : !(saveSuccess || isFromSavedAgent || state.editingDemoId) ? (
                <>
                  <p className={styles.channelDesc}>
                    Call {formatPhoneNumber(state.phoneNumber)}
                  </p>
                  <button
                    className={styles.startBtn}
                    onClick={async () => {
                      const name = window.prompt('Agent name:', agentName || 'My Agent');
                      if (!name) return;
                      try {
                        setSaving(true);
                        await createDemo({ name, config: wizardStateToConfig(state) });
                        setSaveSuccess(true);
                        notifyAgentListChanged();
                      } catch (err) {
                        alert(err instanceof Error ? err.message : 'Failed to save');
                      } finally {
                        setSaving(false);
                      }
                    }}
                    disabled={saving}
                  >
                    {saving ? 'Saving...' : '💾 Save to Activate Phone'}
                  </button>
                </>
              ) : (
                <>
                  <p className={styles.channelDesc}>
                    Call {formatPhoneNumber(state.phoneNumber)}
                  </p>
                  <a href={`tel:${state.phoneNumber}`} className={styles.phoneCallBtn}>
                    Dial Now
                  </a>
                </>
              )}
            </div>

          </div>

        </div>

        {/* Collapsed config section */}
        <details style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px 16px', marginTop: '16px' }}>
          <summary style={{ fontSize: '13px', fontWeight: 600, color: '#94a3b8', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.3px' }}>Agent Configuration</summary>
          <div style={{ marginTop: '12px', display: 'flex', gap: '16px' }}>
            {/* Left: System Prompt (60%) */}
            <div style={{ flex: '0 0 60%' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }}>System Prompt</div>
              <pre style={{ fontSize: '12px', color: '#334155', lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0, background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px', maxHeight: '300px', overflow: 'auto' }}>
                {generateSystemPrompt() || '(no prompt configured)'}
              </pre>
            </div>
            {/* Right: Tools (40%) */}
            <div style={{ flex: '0 0 calc(40% - 16px)' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', marginBottom: '4px' }}>Tools ({state.agents.selectedAgents.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {state.agents.selectedAgents.length > 0 ? (
                  state.agents.selectedAgents.map((id: string) => {
                    const isReserved = id === 'endCallTool' || id === 'transferCall';
                    const tool = availableTools.find((t) => `int:${t.id}` === id || t.id === id);
                    const label = isReserved ? (id === 'endCallTool' ? 'End Call' : 'Transfer Call') : (tool ? tool.name : id.replace('int:', '').substring(0, 8) + '...');
                    const typeLabel = tool ? (tool.type === 'webhook' ? 'API' : tool.type) : '';
                    return (
                      <div key={id} style={{ fontSize: '11px', padding: '4px 8px', background: isReserved ? '#f0fdf4' : 'white', border: `1px solid ${isReserved ? '#bbf7d0' : '#e2e8f0'}`, borderRadius: '4px', color: isReserved ? '#166534' : '#475569', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>{label}</span>
                        {isReserved ? <span style={{ fontSize: '9px', color: '#16a34a', fontWeight: 600 }}>SYSTEM</span> : typeLabel ? <span style={{ fontSize: '10px', color: '#94a3b8' }}>{typeLabel}</span> : null}
                      </div>
                    );
                  })
                ) : (
                  <span style={{ fontSize: '11px', color: '#94a3b8' }}>No tools configured</span>
                )}
              </div>
            </div>
          </div>
          {/* Mock mode warning */}
          {state.useMock && (() => {
            const missing = availableTools.filter((t) =>
              state.agents.selectedAgents.includes(`int:${t.id}`) && !t.mockResponse
            );
            return missing.length > 0 ? (
              <div style={{ marginTop: '10px', padding: '8px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '6px', fontSize: '11px', color: '#92400e' }}>
                ⚠️ Mock mode is on but {missing.length} tool{missing.length > 1 ? 's' : ''} missing mock response: <strong>{missing.map(t => t.name).join(', ')}</strong>. Add mock responses in Tool Management for realistic testing.
              </div>
            ) : null;
          })()}
        </details>

        {error && (
          <div className={styles.errorBox}>
            <span>⚠️</span> {error}
          </div>
        )}

        {/* Webchat popup widget */}
        {(isRecording || connectionStatus === 'connected' || transcript.length > 0) && !chatPopupOpen && (
          <button
            onClick={() => setChatPopupOpen(true)}
            style={{ position: 'fixed', bottom: '24px', right: '24px', width: '56px', height: '56px', borderRadius: '50%', background: '#6366f1', border: 'none', boxShadow: '0 4px 16px rgba(99,102,241,0.4)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
        )}
        {chatPopupOpen && (
        <div style={{ position: 'fixed', bottom: '24px', right: '24px', width: '400px', height: '600px', background: '#fafbfc', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.2), 0 0 0 1px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 100 }}>
          {/* Popup header */}
          <div style={{ padding: '14px 20px', background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
              </div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, letterSpacing: '-0.2px' }}>{agentName || 'Voice Agent'}</div>
                <div style={{ fontSize: '11px', opacity: 0.7 }}>
                  {connectionStatus === 'connected' ? '● Connected' : connectionStatus === 'connecting' ? '○ Connecting...' : '○ Ready'}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div
                onClick={() => dispatch({ type: 'SET_USE_MOCK', payload: !state.useMock })}
                title={state.useMock ? 'Mock tools (click for live)' : 'Live tools (click for mock)'}
                style={{ width: '30px', height: '16px', borderRadius: '8px', background: state.useMock ? '#f59e0b' : 'rgba(255,255,255,0.25)', position: 'relative', cursor: 'pointer', transition: 'background 0.2s' }}
              >
                <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: 'white', position: 'absolute', top: '2px', left: state.useMock ? '16px' : '2px', transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
              </div>
              <span style={{ fontSize: '10px', opacity: 0.7 }}>{state.useMock ? 'Mock' : 'Live'}</span>
              <div style={{ position: 'relative', display: 'inline-flex' }}>
                <svg
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  style={{ opacity: 0.6, cursor: 'pointer' }}
                  onClick={(e) => {
                    const el = (e.currentTarget.parentElement as HTMLElement).querySelector('[data-mock-tip]') as HTMLElement;
                    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
                  }}
                >
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <div data-mock-tip="" style={{ display: 'none', position: 'absolute', top: '20px', right: 0, width: '240px', background: '#1e293b', color: 'white', fontSize: '11px', lineHeight: 1.5, padding: '10px 12px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', zIndex: 200 }}>
                  <strong>Mock Mode</strong> — For testing only. Tools return predefined responses instead of calling real endpoints. Does not affect phone calls, SIP, or other integrations. Only this session is affected. Toggle off for live integrations. Takes effect on next connection.
                </div>
              </div>
              <button onClick={() => { setChatPopupOpen(false); handleStopConversation(); }} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: 'white', cursor: 'pointer', fontSize: '16px', lineHeight: 1, padding: '4px 6px', borderRadius: '6px' }}>✕</button>
            </div>
          </div>

          {/* Call History & Log toggles */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '4px 16px', background: 'rgba(0,0,0,0.02)', borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <div
                onClick={() => dispatch({ type: 'SET_CALL_HISTORY_ENABLED', payload: !state.callHistoryEnabled })}
                style={{ width: '24px', height: '13px', borderRadius: '7px', background: state.callHistoryEnabled ? '#10b981' : '#d1d5db', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
              >
                <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: 'white', position: 'absolute', top: '2px', left: state.callHistoryEnabled ? '13px' : '2px', transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
              </div>
              <span style={{ fontSize: '10px', color: state.callHistoryEnabled ? '#10b981' : '#94a3b8' }}>Chat History</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <div
                onClick={() => dispatch({ type: 'SET_CALL_LOG_ENABLED', payload: !state.callLogEnabled })}
                style={{ width: '24px', height: '13px', borderRadius: '7px', background: state.callLogEnabled ? '#6366f1' : '#d1d5db', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
              >
                <div style={{ width: '9px', height: '9px', borderRadius: '50%', background: 'white', position: 'absolute', top: '2px', left: state.callLogEnabled ? '13px' : '2px', transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
              </div>
              <span style={{ fontSize: '10px', color: state.callLogEnabled ? '#6366f1' : '#94a3b8' }}>Raw Log</span>
            </div>
          </div>

          {/* Transcript */}
          {/* Mock mode warning for tools without mock responses */}
          {state.useMock && (() => {
            const toolsWithoutMock = availableTools.filter((t) =>
              state.agents.selectedAgents.includes(`int:${t.id}`) && !t.mockResponse
            );
            return toolsWithoutMock.length > 0 ? (
              <div style={{ padding: '8px 16px', background: '#fffbeb', borderBottom: '1px solid #fde68a', fontSize: '11px', color: '#92400e', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span>⚠️</span>
                <span>{toolsWithoutMock.length} tool{toolsWithoutMock.length > 1 ? 's' : ''} missing mock response: {toolsWithoutMock.map(t => t.name).join(', ')}</span>
              </div>
            ) : null;
          })()}
          <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px', background: 'white' }}>
            {connectionStatus === 'connecting' ? (
              <div style={{ textAlign: 'center', marginTop: '80px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                {/* Animated connecting rings */}
                <div style={{ position: 'relative', width: '80px', height: '80px' }}>
                  <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '3px solid transparent', borderTopColor: '#6366f1', animation: 'spin 1s linear infinite' }} />
                  <div style={{ position: 'absolute', inset: '8px', borderRadius: '50%', border: '3px solid transparent', borderTopColor: '#a5b4fc', animation: 'spin 1.5s linear infinite reverse' }} />
                  <div style={{ position: 'absolute', inset: '16px', borderRadius: '50%', border: '3px solid transparent', borderTopColor: '#c7d2fe', animation: 'spin 2s linear infinite' }} />
                  <div style={{ position: 'absolute', inset: '24px', borderRadius: '50%', background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
                  </div>
                </div>
                <div>
                  <p style={{ color: '#6366f1', fontSize: '14px', fontWeight: 600, margin: 0 }}>Connecting to agent...</p>
                  <p style={{ color: '#94a3b8', fontSize: '11px', marginTop: '6px' }}>Setting up voice channel</p>
                </div>
                {/* Animated dots */}
                <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#a5b4fc', animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite` }} />
                  ))}
                </div>
                <style>{`
                  @keyframes spin { to { transform: rotate(360deg); } }
                `}</style>
              </div>
            ) : transcript.length === 0 && !isRecording ? (
              <div style={{ textAlign: 'center', marginTop: '60px' }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: '#f1f5f9', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <p style={{ color: '#94a3b8', fontSize: '13px', margin: 0 }}>Start a conversation to begin</p>
                <p style={{ color: '#cbd5e1', fontSize: '11px', marginTop: '4px' }}>Click the microphone button below</p>
              </div>
            ) : transcript.length === 0 && isRecording ? (
              <div style={{ textAlign: 'center', marginTop: '60px' }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: '#eef2ff', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px', animation: 'pulse 2s infinite' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
                </div>
                <p style={{ color: '#6366f1', fontSize: '13px', margin: 0, fontWeight: 500 }}>Listening...</p>
                <p style={{ color: '#94a3b8', fontSize: '11px', marginTop: '4px' }}>Speak now or type below</p>
              </div>
            ) : (
              transcript.map((entry, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: entry.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div style={{
                    maxWidth: (entry as any).type === 'tool' ? '90%' : '75%',
                    padding: (entry as any).type === 'tool' ? '6px 10px' : '10px 14px',
                    borderRadius: entry.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    background: (entry as any).type === 'tool' ? 'transparent' : entry.role === 'user' ? 'linear-gradient(135deg, #6366f1, #4f46e5)' : '#f1f5f9',
                    color: (entry as any).type === 'tool' ? '#94a3b8' : entry.role === 'user' ? 'white' : '#1e293b',
                    fontSize: (entry as any).type === 'tool' ? '11px' : '13px',
                    lineHeight: 1.5,
                    boxShadow: entry.role === 'user' && (entry as any).type !== 'tool' ? '0 2px 8px rgba(99,102,241,0.2)' : 'none',
                    fontFamily: (entry as any).type === 'tool' ? 'monospace' : 'inherit',
                    borderLeft: (entry as any).type === 'tool' ? '2px solid #e2e8f0' : 'none',
                    wordBreak: (entry as any).type === 'tool' ? 'break-all' as any : 'normal' as any,
                  }}>
                    {entry.text}
                  </div>
                  {(entry as any).type !== 'tool' && (
                    <span style={{ fontSize: '10px', color: '#cbd5e1', marginTop: '3px', padding: '0 6px' }}>{entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  )}
                </div>
              ))
            )}
            {agentSpeaking && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px' }}>
                <div style={{ display: 'flex', gap: '2px' }}>
                  {[0, 1, 2].map((i) => (
                    <div key={i} style={{ width: '4px', height: '4px', borderRadius: '50%', background: '#6366f1', animation: `bounce 1.4s infinite ${i * 0.2}s` }} />
                  ))}
                </div>
                <span style={{ fontSize: '11px', color: '#6366f1', fontWeight: 500 }}>Agent speaking</span>
              </div>
            )}
            <div ref={transcriptEndRef} />
          </div>

          {/* Text input */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', background: 'white', display: 'flex', gap: '8px', flexShrink: 0 }}>
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && textInput.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'bidi_text_input', text: textInput.trim(), role: 'user' }));
                  setTranscript((prev) => [...prev, { role: 'user', text: textInput.trim(), timestamp: new Date() }]);
                  setTextInput('');
                }
              }}
              placeholder={connectionStatus === 'connected' ? 'Type a message...' : 'Connect first to chat'}
              style={{ flex: 1, padding: '10px 14px', border: '1px solid #e2e8f0', borderRadius: '10px', fontSize: '13px', outline: 'none', background: '#f8fafc', transition: 'border-color 0.2s' }}
              disabled={connectionStatus !== 'connected'}
            />
            <button
              onClick={() => {
                if (textInput.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'bidi_text_input', text: textInput.trim(), role: 'user' }));
                  setTranscript((prev) => [...prev, { role: 'user', text: textInput.trim(), timestamp: new Date() }]);
                  setTextInput('');
                }
              }}
              disabled={!textInput.trim() || connectionStatus !== 'connected'}
              style={{ padding: '10px 16px', background: (!textInput.trim() || connectionStatus !== 'connected') ? '#e2e8f0' : '#6366f1', border: 'none', borderRadius: '10px', color: 'white', fontSize: '13px', fontWeight: 600, cursor: 'pointer', transition: 'background 0.2s', display: 'flex', alignItems: 'center' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>

          {/* Start/Stop controls */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid #f1f5f9', background: '#fafbfc', display: 'flex', justifyContent: 'center', flexShrink: 0, borderRadius: '0 0 20px 20px' }}>
            {!isRecording ? (
              <button
                onClick={handleStartConversation}
                disabled={connectionStatus === 'connecting'}
                style={{ padding: '10px 24px', background: connectionStatus === 'connecting' ? '#94a3b8' : 'linear-gradient(135deg, #10b981, #059669)', border: 'none', borderRadius: '10px', color: 'white', fontSize: '13px', fontWeight: 600, cursor: connectionStatus === 'connecting' ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 2px 8px rgba(16,185,129,0.3)' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
                {connectionStatus === 'connecting' ? 'Connecting...' : 'Start Conversation'}
              </button>
            ) : (
              <button
                onClick={handleStopConversation}
                style={{ padding: '10px 24px', background: 'linear-gradient(135deg, #ef4444, #dc2626)', border: 'none', borderRadius: '10px', color: 'white', fontSize: '13px', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 2px 8px rgba(239,68,68,0.3)' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                End Conversation
              </button>
            )}
          </div>
        </div>
        )}

        {/* Original voice interface (hidden — transcripts only in popup now) */}
        <div className={styles.leftPanel} style={{ display: 'none' }}>
          {/* Main Voice Interface */}
          <div className={styles.voiceInterface}>
          {/* Compact controls bar at top */}
          <div className={styles.controlsBar}>
            <div className={styles.controls}>
              {isRecording && (
                <button
                  className={styles.stopBtn}
                  onClick={handleStopConversation}
                >
                  ⏹ End
                </button>
              )}
            </div>
            <div className={styles.visualizerCompact}>
              {isRecording && (
                <div className={styles.waveContainer}>
                  {[0.3, 0.2, 0.4, 0.15, 0.35].map((base, i) => (
                    <div
                      key={i}
                      className={styles.wave}
                      style={{
                        transform: `scaleY(${base + audioLevel * (1 - base)})`,
                        animationDelay: `${i * 0.08}s`,
                      }}
                    />
                  ))}
                </div>
              )}
              {agentSpeaking && !isRecording && (
                <span className={styles.speakingLabel}>Agent speaking...</span>
              )}
              {!isRecording && !agentSpeaking && connectionStatus === 'connected' && (
                <span className={styles.speakingLabel}>Connected</span>
              )}
            </div>
          </div>

          {/* Transcript area */}
          <div className={styles.transcriptArea}>
            <div className={styles.transcriptList}>
              {transcript.length === 0 ? (
                <p className={styles.placeholder}>
                  Conversation transcript will appear here...
                </p>
              ) : (
                transcript.map((entry, i) => (
                  <div
                    key={i}
                    className={`${styles.message} ${
                      entry.role === 'user' ? styles.userMsg : styles.agentMsg
                    }`}
                    style={(entry as any).type === 'tool' ? { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '5px 10px', fontSize: '10px', fontFamily: 'monospace', color: '#b0b8c4', maxWidth: '95%', alignSelf: 'center', boxShadow: 'none' } : undefined}
                  >
                    {(entry as any).type !== 'tool' && (
                      <div className={styles.msgHeader}>
                        <span className={styles.msgRole}>
                          {entry.role === 'user' ? 'You' : 'Agent'}
                        </span>
                        <span className={styles.msgTime}>
                          {entry.timestamp.toLocaleTimeString()}
                        </span>
                      </div>
                    )}
                    <p style={(entry as any).type === 'tool' ? { margin: 0, wordBreak: 'break-all', color: '#94a3b8', fontSize: '11px' } : undefined}>{entry.text}</p>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Text input */}
          <div className={styles.textInputArea}>
            <input
              className={styles.textInput}
              type="text"
              placeholder="Type a message..."
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && textInput.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'bidi_text_input', text: textInput.trim(), role: 'user' }));
                  setTranscript((prev) => [...prev, { role: 'user', text: textInput.trim(), timestamp: new Date() }]);
                  setTextInput('');
                }
              }}
              disabled={connectionStatus !== 'connected' && !isRecording}
            />
            <button
              className={styles.sendBtn}
              onClick={() => {
                if (textInput.trim() && wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'bidi_text_input', text: textInput.trim(), role: 'user' }));
                  setTranscript((prev) => [...prev, { role: 'user', text: textInput.trim(), timestamp: new Date() }]);
                  setTextInput('');
                }
              }}
              disabled={!textInput.trim() || (connectionStatus !== 'connected' && !isRecording)}
            >
              Send
            </button>
          </div>
        </div>
        </div>

        {/* Tech breakdown slide-over panel */}
        {showReport && (
          <div className={styles.overlay} onClick={() => setShowReport(false)}>
            <div className={styles.slidePanel} onClick={(e) => e.stopPropagation()}>
              <div className={styles.slidePanelHeader}>
                <h3>Technical Breakdown</h3>
                <button className={styles.closeBtn} onClick={() => setShowReport(false)}>✕</button>
              </div>
              <div className={styles.slidePanelBody}>
                <TechnicalReport state={state} />
              </div>
            </div>
          </div>
        )}

      </div>
    </PageWrapper>
  );
}

// Technical Breakdown Report Component
function TechnicalReport({ state }: { state: any }) {
  const [tools, setTools] = useState<any[]>([]);
  useEffect(() => { listTools().then(setTools).catch(() => {}); }, []);
  return (
    <div className={styles.report}>
      <h3 className={styles.reportTitle}>Technical Breakdown</h3>
      <p className={styles.reportSubtitle}>
        Architecture and service details for your configured voice agent POC.
      </p>

      <div className={styles.reportSections}>
        {/* Architecture Diagram */}
        <div className={styles.reportSection}>
          <h4>Architecture</h4>
          {state.pipeline === 'speech-to-speech' ? (
            <div className={styles.archDiagram}>
              <div className={styles.archNode}>
                <span className={styles.archIcon}>🌐</span>
                <strong>Browser Client</strong>
                <p>WebSocket + MediaStream API</p>
              </div>
              <div className={styles.archArrow}>⇄ WSS</div>
              <div className={styles.archNode}>
                <span className={styles.archIcon}>☁️</span>
                <strong>AgentCore Runtime</strong>
                <p>Strands BidiAgent</p>
              </div>
              <div className={styles.archArrow}>⇄</div>
              <div className={styles.archNodeHighlight}>
                <span className={styles.archIcon}>🎙️</span>
                <strong>Amazon Nova Sonic</strong>
                <p>Speech-to-Speech Model</p>
              </div>
            </div>
          ) : (
            <div className={styles.archDiagram}>
              <div className={styles.archNode}>
                <span className={styles.archIcon}>🌐</span>
                <strong>Browser Client</strong>
                <p>WebSocket Audio Stream</p>
              </div>
              <div className={styles.archArrow}>⇄ WSS</div>
              <div className={styles.archNode}>
                <span className={styles.archIcon}>☁️</span>
                <strong>AgentCore Runtime</strong>
                <p>Orchestrator</p>
              </div>
              <div className={styles.archArrow}>→</div>
              <div className={styles.archCascade}>
                <div className={styles.cascadeNode}>
                  <strong>
                    {state.cascaded.sttProvider === 'transcribe'
                      ? 'Amazon Transcribe'
                      : 'Deepgram'}
                  </strong>
                  <p>STT</p>
                </div>
                <span>→</span>
                <div className={styles.cascadeNode}>
                  <strong>
                    {state.cascaded.llmProvider === 'nova-lite'
                      ? 'Nova Lite'
                      : 'GPT'}
                  </strong>
                  <p>LLM (Bedrock)</p>
                </div>
                <span>→</span>
                <div className={styles.cascadeNode}>
                  <strong>
                    {state.cascaded.ttsProvider === 'polly'
                      ? 'Amazon Polly'
                      : 'Eleven Labs'}
                  </strong>
                  <p>TTS</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Services Breakdown */}
        <div className={styles.reportSection}>
          <h4>Services Used</h4>
          <table className={styles.serviceTable}>
            <thead>
              <tr>
                <th>Component</th>
                <th>Service</th>
                <th>Purpose</th>
                <th>Region</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Runtime</td>
                <td>Amazon Bedrock AgentCore</td>
                <td>WebSocket server hosting the voice agent</td>
                <td>us-east-1</td>
              </tr>
              <tr>
                <td>Agent Framework</td>
                <td>Strands Agents SDK (BidiAgent)</td>
                <td>Bidirectional streaming orchestration</td>
                <td>—</td>
              </tr>
              {state.pipeline === 'speech-to-speech' ? (
                <tr>
                  <td>Voice Model</td>
                  <td>Amazon Nova Sonic</td>
                  <td>End-to-end speech understanding and generation</td>
                  <td>us-east-1</td>
                </tr>
              ) : (
                <>
                  <tr>
                    <td>STT</td>
                    <td>
                      {state.cascaded.sttProvider === 'transcribe'
                        ? 'Amazon Transcribe'
                        : 'Deepgram'}
                    </td>
                    <td>Real-time speech-to-text transcription</td>
                    <td>us-east-1</td>
                  </tr>
                  <tr>
                    <td>LLM</td>
                    <td>
                      {state.cascaded.llmProvider === 'nova-lite'
                        ? 'Amazon Nova Lite (Bedrock)'
                        : 'GPT (via Bedrock)'}
                    </td>
                    <td>Natural language understanding and response generation</td>
                    <td>us-east-1</td>
                  </tr>
                  <tr>
                    <td>TTS</td>
                    <td>
                      {state.cascaded.ttsProvider === 'polly'
                        ? 'Amazon Polly'
                        : 'Eleven Labs'}
                    </td>
                    <td>Text-to-speech synthesis</td>
                    <td>us-east-1</td>
                  </tr>
                </>
              )}
              <tr>
                <td>Transport</td>
                <td>WebSocket (WSS)</td>
                <td>Bidirectional audio streaming</td>
                <td>—</td>
              </tr>
              <tr>
                <td>Client Audio</td>
                <td>Web Audio API + MediaStream</td>
                <td>Microphone capture (16kHz PCM) and playback (24kHz)</td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Configuration Details */}
        <div className={styles.reportSection}>
          <h4>Configuration</h4>
          <div className={styles.configGrid}>
            <div className={styles.configBlock}>
              <h5>Voice</h5>
              <ul>
                <li>
                  <strong>Voice ID:</strong> {state.voice.voiceId || '—'}
                </li>
                <li>
                  <strong>Language:</strong> {state.voice.language}
                </li>
                <li>
                  <strong>Gender:</strong> {state.voice.gender}
                </li>
              </ul>
            </div>
            <div className={styles.configBlock}>
              <h5>Agent Tools</h5>
              <ul>
                {state.agents.selectedAgents.length > 0 ? (
                  state.agents.selectedAgents.map((id: string) => {
                    const tool = tools.find((t: any) => `int:${t.id}` === id || t.id === id);
                    const label = tool ? tool.name : id.replace('int:', '').substring(0, 8) + '...';
                    const typeLabel = tool ? (tool.type === 'webhook' ? 'API' : tool.type) : '';
                    return <li key={id}>{typeLabel ? `${typeLabel}: ${label}` : label}</li>;
                  })
                ) : (
                  <li>None configured</li>
                )}
              </ul>
            </div>
            <div className={styles.configBlock}>
              <h5>Audio Settings</h5>
              <ul>
                <li>
                  <strong>Input:</strong> 16kHz, mono, PCM16
                </li>
                <li>
                  <strong>Output:</strong> 24kHz, mono
                </li>
                <li>
                  <strong>Echo Cancellation:</strong> Enabled
                </li>
                <li>
                  <strong>Noise Suppression:</strong> Enabled
                </li>
              </ul>
            </div>
            <div className={styles.configBlock}>
              <h5>Features</h5>
              <ul>
                <li>✓ Barge-in support</li>
                <li>✓ Real-time transcription</li>
                <li>✓ Automatic turn-taking</li>
                <li>
                  {state.pipeline === 'speech-to-speech'
                    ? '✓ Native speech understanding'
                    : '✓ Cascaded pipeline orchestration'}
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* System Prompt */}
        <div className={styles.reportSection}>
          <h4>System Prompt</h4>
          <pre className={styles.promptBlock}>
            {`${state.prompt.instructions || 'You are a helpful voice agent.'}${state.prompt.greeting ? `\nGreeting: "${state.prompt.greeting}"` : ''}`}
          </pre>
        </div>

        {/* Deployment Info */}
        <div className={styles.reportSection}>
          <h4>Deployment Details</h4>
          <div className={styles.deployInfo}>
            <div className={styles.deployRow}>
              <span>Hosting</span>
              <strong>Amazon Bedrock AgentCore (WebSocket Runtime)</strong>
            </div>
            <div className={styles.deployRow}>
              <span>Agent SDK</span>
              <strong>Strands Agents — BidiAgent</strong>
            </div>
            <div className={styles.deployRow}>
              <span>Protocol</span>
              <strong>WebSocket (WSS) — Bidirectional Streaming</strong>
            </div>
            <div className={styles.deployRow}>
              <span>Authentication</span>
              <strong>IAM SigV4 (via Cognito Identity Pool)</strong>
            </div>
            {state.path === 'some-technical' && (
              <>
                <div className={styles.deployRow}>
                  <span>Telephony</span>
                  <strong>Twilio + Harmonex</strong>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default POC;
