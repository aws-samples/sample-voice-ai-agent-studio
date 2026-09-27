"""Audio conversion helpers for the PSTN bridge."""

import audioop


def mulaw_8k_to_pcm(mulaw_data: bytes, output_sample_rate: int = 16000) -> bytes:
    """Convert 8 kHz mulaw to signed 16-bit PCM at the negotiated rate."""
    pcm_8k = audioop.ulaw2lin(mulaw_data, 2)
    pcm, _ = audioop.ratecv(pcm_8k, 2, 1, 8000, output_sample_rate, None)
    return pcm


def pcm_to_mulaw_8k(pcm_data: bytes, input_sample_rate: int = 16000) -> bytes:
    """Convert signed 16-bit PCM at the negotiated rate to 8 kHz mulaw."""
    pcm_8k, _ = audioop.ratecv(pcm_data, 2, 1, input_sample_rate, 8000, None)
    return audioop.lin2ulaw(pcm_8k, 2)
