import os
import json
import torch
import subprocess
import sys

def install(package):
    subprocess.check_call([sys.executable, "-m", "pip", "install", package, "-q"])

print("[1/4] Installing dependencies...")
try:
    import transformers
    import onnx
except ImportError:
    install("transformers")
    install("torch")
    install("onnx")

print("[1/4] Dependency check done.")

from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

MODEL_ID = "MahmoudAshraf/mms-300m-1130-forced-aligner"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "models")
os.makedirs(OUTPUT_DIR, exist_ok=True)

print(f"[2/4] Downloading multi-lingual alignment model: {MODEL_ID}")
model = Wav2Vec2ForCTC.from_pretrained(MODEL_ID)
processor = Wav2Vec2Processor.from_pretrained(MODEL_ID)
model.eval()

print("[3/4] Exporting to ONNX...")
dummy_input = torch.randn(1, 16000 * 5)
onnx_path = os.path.join(OUTPUT_DIR, "model.onnx")

torch.onnx.export(
    model,
    dummy_input,
    onnx_path,
    input_names=["input_values"],
    output_names=["logits"],
    dynamic_axes={
        "input_values": {0: "batch", 1: "sequence"},
        "logits": {0: "batch", 1: "time"},
    },
    opset_version=18,
)

print("[4/4] Creating tokens file...")
vocab = processor.tokenizer.get_vocab()
sorted_vocab = sorted(vocab.items(), key=lambda x: x[1])
tokens_path = os.path.join(OUTPUT_DIR, "tokens.txt")
with open(tokens_path, "w", encoding="utf-8") as f:
    for token, idx in sorted_vocab:
        # Standard format: token id
        f.write(f"{token} {idx}\n")

vocab_path = os.path.join(OUTPUT_DIR, "vocab.json")
with open(vocab_path, "w", encoding="utf-8") as f:
    json.dump(vocab, f, ensure_ascii=False, indent=2)

print(f"\n✅ All done!")
print(f"   model.onnx  -> {onnx_path}")
print(f"   tokens.txt  -> {tokens_path}")
