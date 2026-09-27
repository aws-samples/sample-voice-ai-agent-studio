import struct
import unittest

from source.agent.call_history_logger import pcm_to_wav


class PcmToWavTests(unittest.TestCase):
    def test_wav_header_uses_requested_sample_rate(self):
        raw_pcm = b"\x00\x00" * 240

        for sample_rate in (16000, 24000):
            with self.subTest(sample_rate=sample_rate):
                wav = pcm_to_wav(raw_pcm, sample_rate)
                self.assertEqual(wav[:4], b"RIFF")
                self.assertEqual(wav[8:12], b"WAVE")
                self.assertEqual(struct.unpack_from("<I", wav, 24)[0], sample_rate)
                self.assertEqual(struct.unpack_from("<I", wav, 28)[0], sample_rate * 2)
                self.assertEqual(struct.unpack_from("<I", wav, 40)[0], len(raw_pcm))
                self.assertEqual(wav[44:], raw_pcm)

    def test_invalid_sample_rate_is_rejected(self):
        for sample_rate in (0, -1, 16000.0, None):
            with self.subTest(sample_rate=sample_rate):
                with self.assertRaises(ValueError):
                    pcm_to_wav(b"", sample_rate)


if __name__ == "__main__":
    unittest.main()
