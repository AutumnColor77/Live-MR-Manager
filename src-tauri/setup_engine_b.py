import os
import json
import torch
import subprocess
import sys

def install(package):
    subprocess.check_call([sys.executable, "-m", "pip", "install", package, "-q"])

print("Installing dependencies...")
try:
    import transformers
except ImportError:
    install("transformers")
    install("torch")

from transformers import WhisperForConditionalGeneration, WhisperProcessor

MODEL_ID = "openai/whisper-base"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "models", "whisper-base")
os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f"Downloading {MODEL_ID}...")
model = WhisperForConditionalGeneration.from_pretrained(MODEL_ID)
processor = WhisperProcessor.from_pretrained(MODEL_ID)
model.eval()

# We only need the encoder for basic forced alignment features
encoder = model.get_encoder()
encoder.eval()

print("Exporting Engine B (Encoder) to ONNX...")
# Whisper encoder input is [batch, feature_size (80), sequence_length (3000)]
dummy_input = torch.randn(1, 80, 3000)
onnx_path = os.path.join(OUTPUT_DIR, "encoder.onnx")

torch.onnx.export(
    encoder,
    dummy_input,
    onnx_path,
    input_names=["input_features"],
    output_names=["last_hidden_state"],
    dynamic_axes={
        "input_features": {0: "batch"},
        "last_hidden_state": {0: "batch", 1: "time"},
    },
    opset_version=14,
)

print("Saving vocab info for Whisper...")
# Whisper uses a different tokenization, but for alignment (DTW) we mostly care about the features.
# We'll save the processor's tokenizer vocab just in case.
vocab = processor.tokenizer.get_vocab()
vocab_path = os.path.join(OUTPUT_DIR, "vocab.json")
with open(vocab_path, "w", encoding="utf-8") as f:
    json.dump(vocab, f, ensure_ascii=False, indent=2)

print(f"Engine B Ready: {onnx_path}")
