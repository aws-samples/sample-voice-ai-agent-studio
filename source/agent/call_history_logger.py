"""
CallHistoryLogger — Captures session data and uploads to S3 on session end.

Buffers audio chunks, transcript turns, and raw events during a voice session.
On session end (finalize), uploads everything to S3 and writes a metadata
record to DynamoDB for indexing.

This class is non-blocking and failure-tolerant — logging errors never
interrupt the active voice session.
"""

import io
import json
import logging
import os
import struct
import time
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Max audio buffer size (50MB) to prevent OOM on very long calls
MAX_AUDIO_BUFFER_BYTES = 50 * 1024 * 1024
DEFAULT_AUDIO_SAMPLE_RATE = 16000


def pcm_to_wav(raw_pcm: bytes, sample_rate: int) -> bytes:
    """Wrap 16-bit mono PCM in a WAV container at the supplied sample rate."""
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError("sample_rate must be a positive integer")
    bytes_per_sample = 2
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + len(raw_pcm)))
    buf.write(b"WAVEfmt ")
    buf.write(struct.pack(
        "<IHHIIHH",
        16,
        1,
        1,
        sample_rate,
        sample_rate * bytes_per_sample,
        bytes_per_sample,
        16,
    ))
    buf.write(b"data")
    buf.write(struct.pack("<I", len(raw_pcm)))
    buf.write(raw_pcm)
    return buf.getvalue()


class CallHistoryLogger:
    """Captures session data and uploads to S3 on session end."""

    def __init__(self, agent_id: str, session_id: str = None, s3_bucket: str = None, user_id: str = "", source: str = "webchat", caller_id: str = "", input_sample_rate: int = DEFAULT_AUDIO_SAMPLE_RATE, output_sample_rate: int = DEFAULT_AUDIO_SAMPLE_RATE):
        self.agent_id = agent_id
        self.session_id = session_id or str(uuid.uuid4())
        self.s3_bucket = s3_bucket or os.environ.get("CALL_HISTORY_BUCKET", "")
        # Auto-detect bucket name if not provided
        if not self.s3_bucket:
            try:
                import boto3
                sts = boto3.client("sts", region_name=os.environ.get("AWS_REGION", "us-east-1"))
                account_id = sts.get_caller_identity()["Account"]
                region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
                self.s3_bucket = f"voice-agent-poc-call-history-{account_id}-{region}"
            except Exception:
                pass
        self.user_id = user_id
        self.source = source  # "webchat", "telephony", "sip", "eval"
        self.caller_id = caller_id  # phone number, username, SIP URI — depends on source
        self.input_sample_rate = input_sample_rate
        self.output_sample_rate = output_sample_rate
        self.started_at = datetime.now(timezone.utc)
        self.transcript_turns: list = []
        self.audio_chunks: list = []
        self.audio_bytes_total = 0
        self.events: list = []  # JSONL lines
        self._current_turn_index = 0
        self._current_user_text = ""
        self._current_tool_calls: list = []
        self._finalized = False

    def log_event(self, direction: str, event_type: str, **kwargs):
        """Append a raw event to the JSONL buffer."""
        try:
            # Skip large audio data from event log (just record size)
            filtered = {k: v for k, v in kwargs.items() if k != "audio_data"}
            entry = {
                "ts": datetime.now(timezone.utc).isoformat(),
                "dir": direction,
                "type": event_type,
                **filtered,
            }
            self.events.append(json.dumps(entry, default=str))
        except Exception as e:
            logger.warning(f"CallHistoryLogger.log_event error: {e}")

    def log_user_text(self, text: str):
        """Record a user transcript turn."""
        try:
            self.transcript_turns.append({
                "turnIndex": self._current_turn_index,
                "role": "user",
                "text": text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            self._current_user_text = text
        except Exception as e:
            logger.warning(f"CallHistoryLogger.log_user_text error: {e}")

    def log_assistant_text(self, text: str, tool_calls: list = None):
        """Record an assistant transcript turn."""
        try:
            entry = {
                "turnIndex": self._current_turn_index,
                "role": "assistant",
                "text": text,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            if tool_calls:
                entry["toolCalls"] = tool_calls
            elif self._current_tool_calls:
                entry["toolCalls"] = self._current_tool_calls
            self.transcript_turns.append(entry)
            self._current_turn_index += 1
            self._current_tool_calls = []
        except Exception as e:
            logger.warning(f"CallHistoryLogger.log_assistant_text error: {e}")

    def log_tool_call(self, tool_name: str, args: dict = None, result: str = None):
        """Record a tool invocation within the current turn."""
        try:
            self._current_tool_calls.append({
                "name": tool_name,
                "args": args or {},
                "result": result or "",
            })
        except Exception as e:
            logger.warning(f"CallHistoryLogger.log_tool_call error: {e}")

    def log_audio_chunk(self, chunk: bytes):
        """Buffer an agent output audio chunk."""
        try:
            if self.audio_bytes_total + len(chunk) > MAX_AUDIO_BUFFER_BYTES:
                return  # Cap reached — skip to prevent OOM
            self.audio_chunks.append(chunk)
            self.audio_bytes_total += len(chunk)
        except Exception as e:
            logger.warning(f"CallHistoryLogger.log_audio_chunk error: {e}")

    async def finalize(self, end_reason: str = "completed"):
        """Upload all session data to S3 and write DynamoDB metadata. Non-blocking."""
        if self._finalized:
            return
        self._finalized = True
        import asyncio
        try:
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, self._upload_sync, end_reason)
        except Exception as e:
            logger.error(f"CallHistoryLogger.finalize error: {e}")

    def _upload_sync(self, end_reason: str):
        """Synchronous S3 upload + DynamoDB write. Called in thread pool."""
        import boto3

        if not self.s3_bucket:
            logger.warning("CallHistoryLogger: No S3 bucket configured, skipping upload")
            return

        try:
            s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
            dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION", "us-east-1"))
            table = dynamodb.Table(os.environ.get("CALL_HISTORY_TABLE", "voice-agent-poc-call-history"))

            prefix = f"sessions/{self.agent_id}/{self.session_id}/"
            ended_at = datetime.now(timezone.utc)
            duration = int((ended_at - self.started_at).total_seconds())
            turn_count = len(self.transcript_turns)
            # A "turn" is a user+assistant exchange pair
            pair_count = (turn_count + 1) // 2

            # 1. Upload transcript.json (annotate with per-turn audio paths)
            agent_turn_audio = getattr(self, '_agent_turn_audio', [])
            user_turn_audio = getattr(self, '_user_turn_audio', [])
            agent_audio_turns = {idx for idx, _ in agent_turn_audio}
            user_audio_turns = {idx for idx, _ in user_turn_audio}

            # Annotate turns with audio file references
            for i, turn in enumerate(self.transcript_turns):
                turn["turnIndex"] = i  # Fix: use sequential index
                if turn.get("role") == "assistant" and i in agent_audio_turns:
                    turn["audioFile"] = f"audio/turn_{i}_agent.wav"
                elif turn.get("role") == "user" and i in user_audio_turns:
                    turn["audioFile"] = f"audio/turn_{i}_user.wav"

            transcript = {
                "sessionId": self.session_id,
                "agentId": self.agent_id,
                "turns": self.transcript_turns,
            }
            s3.put_object(
                Bucket=self.s3_bucket,
                Key=f"{prefix}transcript.json",
                Body=json.dumps(transcript, default=str),
                ContentType="application/json",
            )
            logger.info(f"Uploaded transcript: {len(self.transcript_turns)} turns")

            # 2. Upload events.jsonl
            if self.events:
                s3.put_object(
                    Bucket=self.s3_bucket,
                    Key=f"{prefix}events.jsonl",
                    Body="\n".join(self.events),
                    ContentType="application/x-ndjson",
                )
                logger.info(f"Uploaded events: {len(self.events)} entries")

            # 3. Upload per-turn audio files
            def _trim_silence(raw_pcm: bytes, threshold: int = 500) -> bytes:
                """Trim leading and trailing silence from 16-bit PCM audio."""
                import array
                samples = array.array('h')
                samples.frombytes(raw_pcm)
                if not samples:
                    return raw_pcm
                # Find first non-silent sample
                start = 0
                for i, s in enumerate(samples):
                    if abs(s) > threshold:
                        start = max(0, i - 800)  # Keep 50ms before voice starts
                        break
                # Find last non-silent sample
                end = len(samples)
                for i in range(len(samples) - 1, -1, -1):
                    if abs(samples[i]) > threshold:
                        end = min(len(samples), i + 800)  # Keep 50ms after voice ends
                        break
                trimmed = samples[start:end]
                return trimmed.tobytes()

            # Upload per-turn agent audio
            agent_turn_audio = getattr(self, '_agent_turn_audio', [])
            for turn_idx, chunks in agent_turn_audio:
                if chunks:
                    raw = b"".join(chunks)
                    s3.put_object(
                        Bucket=self.s3_bucket,
                        Key=f"{prefix}audio/turn_{turn_idx}_agent.wav",
                        Body=pcm_to_wav(raw, self.output_sample_rate),
                        ContentType="audio/wav",
                    )

            # Upload per-turn user audio (with silence trimming)
            user_turn_audio = getattr(self, '_user_turn_audio', [])
            for turn_idx, chunks in user_turn_audio:
                if chunks:
                    raw = b"".join(chunks)
                    trimmed = _trim_silence(raw)
                    if len(trimmed) > self.input_sample_rate // 50:  # At least 10ms
                        s3.put_object(
                            Bucket=self.s3_bucket,
                            Key=f"{prefix}audio/turn_{turn_idx}_user.wav",
                            Body=pcm_to_wav(trimmed, self.input_sample_rate),
                            ContentType="audio/wav",
                        )

            # Also upload combined files for backward compatibility
            if self.audio_chunks:
                raw = b"".join(self.audio_chunks)
                s3.put_object(
                    Bucket=self.s3_bucket,
                    Key=f"{prefix}audio/agent_output.wav",
                    Body=pcm_to_wav(raw, self.output_sample_rate),
                    ContentType="audio/wav",
                )

            user_chunks_all = getattr(self, '_current_user_chunks', [])
            # Combine all user turn audio into one file (trimmed)
            all_user_raw = b""
            for _, chunks in user_turn_audio:
                all_user_raw += b"".join(chunks)
            if user_chunks_all:
                all_user_raw += b"".join(user_chunks_all)
            if all_user_raw:
                trimmed_all = _trim_silence(all_user_raw)
                if len(trimmed_all) > self.input_sample_rate // 50:
                    s3.put_object(
                        Bucket=self.s3_bucket,
                        Key=f"{prefix}audio/user_input.wav",
                        Body=pcm_to_wav(trimmed_all, self.input_sample_rate),
                        ContentType="audio/wav",
                    )

            audio_turn_count = len(agent_turn_audio) + len(user_turn_audio)
            if audio_turn_count:
                logger.info(f"Uploaded {audio_turn_count} per-turn audio files")

            # 4. Upload session_metadata.json
            metadata = {
                "sessionId": self.session_id,
                "agentId": self.agent_id,
                "userId": self.user_id,
                "callerId": self.caller_id,
                "source": self.source,
                "inputSampleRate": self.input_sample_rate,
                "outputSampleRate": self.output_sample_rate,
                "startedAt": self.started_at.isoformat(),
                "endedAt": ended_at.isoformat(),
                "durationSeconds": duration,
                "turnCount": pair_count,
                "endReason": end_reason,
                "s3Prefix": prefix,
            }
            s3.put_object(
                Bucket=self.s3_bucket,
                Key=f"{prefix}session_metadata.json",
                Body=json.dumps(metadata),
                ContentType="application/json",
            )

            # 5. Write DynamoDB index record
            table.put_item(Item=metadata)
            logger.info(f"Call history saved: {self.session_id} ({duration}s, {pair_count} turns)")

        except Exception as e:
            # Never raise — logging failures must not crash the session
            logger.error(f"CallHistoryLogger upload failed: {e}")
