import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "telephony" / "pstn" / "audio.py"
SPEC = importlib.util.spec_from_file_location("pstn_audio", MODULE_PATH)
audio = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audio)


def test_phone_audio_converts_at_supported_model_rates():
    mulaw = bytes([255]) * 800  # 100 ms at 8 kHz

    for sample_rate in (16000, 24000):
        pcm = audio.mulaw_8k_to_pcm(mulaw, sample_rate)
        assert abs(len(pcm) - sample_rate // 5) <= 4

        restored = audio.pcm_to_mulaw_8k(pcm, sample_rate)
        assert 790 <= len(restored) <= 810
