import os
import json

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "models", "whisper-base")
vocab_path = os.path.join(OUTPUT_DIR, "vocab.json")
tokens_path = os.path.join(OUTPUT_DIR, "tokens.txt")

if os.path.exists(vocab_path):
    with open(vocab_path, "r", encoding="utf-8") as f:
        vocab = json.load(f)
    
    # Sort by ID
    sorted_vocab = sorted(vocab.items(), key=lambda x: x[1])
    
    with open(tokens_path, "w", encoding="utf-8") as f:
        for token, idx in sorted_vocab:
            # Replace special whisper symbols with something readable if needed
            # But mostly we just need the mapping for Aligner
            # Standard formatting: token_string id
            clean_token = token.replace(" ", "__").replace("\n", "[NL]")
            if not clean_token: clean_token = "[EMPTY]"
            f.write(f"{clean_token} {idx}\n")
    print(f"Tokens saved to {tokens_path}")
else:
    print(f"Vocab file not found at {vocab_path}")
