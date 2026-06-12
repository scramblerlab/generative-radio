"""Quantize the ACE-Step 5Hz LM checkpoint to 8-bit MLX (plan item 1D).

This produced `acestep-5Hz-lm-1.7B-q8`, the checkpoint both start scripts
point at via ACESTEP_LM_MODEL_PATH. Measured result (2026-06-12, Mac mini
M4 Pro 64GB): Phase 2 decode 27.4 -> 43.8 tok/s, total -19%/track — see
"Phase D" in docs/apple-silicon-performance-tuning.md.

Why this script exists (instead of `mlx_lm convert`)
----------------------------------------------------
The ACE-Step 5Hz LM checkpoints store safetensors keys WITHOUT the "model."
prefix (e.g. "layers.0..." instead of "model.layers.0...") and have no
lm_head (tied embeddings), so plain `mlx_lm convert` fails on key names.
This script replicates the remap that ACE-Step itself applies at load time
(acestep/llm_inference.py, _load_mlx_model), then quantizes and saves an
mlx-lm-native directory that loads through the standard `mlx_lm.utils.load`
fast path — no ACE-Step code changes needed.

How to run
----------
The script needs ACE-Step's venv (mlx + mlx_lm). From this repo:

    cd ../ACE-Step-1.5
    uv run python ../generative-radio/scripts/quantize_5hz_lm_q8.py

Options:
    --src         source checkpoint dir
                  (default: <ACE-Step repo>/checkpoints/acestep-5Hz-lm-1.7B)
    --bits        quantization bits (default 8; 4 would be smaller/faster
                  but is unproven for audio-code quality — A/B before use)
    --group-size  quantization group size (default 64, mlx_lm's default)

Output goes to a sibling dir named <src>-q<bits> (e.g.
checkpoints/acestep-5Hz-lm-1.7B-q8, ~1.9 GB for q8). The script refuses to
overwrite an existing output dir — delete it first to re-convert.

When you might need to re-run this
----------------------------------
- After pulling a new/retrained 5Hz LM checkpoint from upstream.
- To produce a different bit width for an A/B experiment.
- After deleting the q8 dir to reclaim disk.

Afterwards, verify and (if new) point the radio at it:
1. Smoke test (from ACE-Step repo):
       uv run python -c "from mlx_lm.utils import load; from mlx_lm import generate; \
           m,t = load('checkpoints/acestep-5Hz-lm-1.7B-q8'); \
           print(generate(m, t, prompt='The quick brown fox', max_tokens=20))"
   Expect <|audio_code_NNNNN|> tokens; standard load must succeed WITHOUT
   the prefix-remap fallback (that proves ACE-Step's fast path will work).
2. Set ACESTEP_LM_MODEL_PATH=<dir name> in scripts/start.sh and
   scripts/start_prod.sh, restart, and check /health reports the new
   loaded_lm_model.
3. Measure with scripts/acestep_baseline.py against the Phase D tables.

Revert: set ACESTEP_LM_MODEL_PATH back to acestep-5Hz-lm-1.7B (one line in
each start script) and restart ACE-Step.

Caveat: the quantized output is MLX-only. The Gradio UI's PMI scoring panel
(get_hf_model_for_scoring) loads the same path via HF transformers/torch and
cannot read a quantized dir — the radio's API flow never calls it, but for a
Gradio scoring session run on the bf16 checkpoint.
"""
import argparse
import glob
from pathlib import Path

import mlx.core as mx
from mlx_lm.utils import (
    _get_classes,
    load_config,
    load_tokenizer,
    quantize_model,
    save,
)

# Default ACE-Step location: sibling of this repo (…/dev/ai/ACE-Step-1.5).
ACESTEP_REPO = Path(__file__).resolve().parent.parent.parent / "ACE-Step-1.5"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--src",
        default=str(ACESTEP_REPO / "checkpoints/acestep-5Hz-lm-1.7B"),
        help="source bf16 checkpoint directory",
    )
    ap.add_argument("--bits", type=int, default=8)
    ap.add_argument("--group-size", type=int, default=64)
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_dir():
        raise SystemExit(f"Source checkpoint not found: {src}")
    dst = src.with_name(f"{src.name}-q{args.bits}")
    if dst.exists():
        raise SystemExit(f"Destination already exists (delete to re-convert): {dst}")

    config = load_config(src)

    weights = {}
    for wf in glob.glob(str(src / "model*.safetensors")):
        weights.update(mx.load(wf))
    if not weights:
        raise SystemExit(f"No model*.safetensors found in {src}")
    print(f"Loaded {len(weights)} tensors from {src}")

    if not next(iter(weights)).startswith("model."):
        print("Adding 'model.' prefix to weight keys (ACE-Step checkpoint quirk)")
        weights = {f"model.{k}": v for k, v in weights.items()}

    model_class, model_args_class = _get_classes(config=config)
    model = model_class(model_args_class.from_dict(config))
    if hasattr(model, "sanitize"):
        weights = model.sanitize(weights)
    model.load_weights(list(weights.items()), strict=True)
    mx.eval(model.parameters())
    print("bf16 model built and weights verified (strict load)")

    model, config = quantize_model(
        model, config, group_size=args.group_size, bits=args.bits
    )
    print(f"Quantized to {args.bits}-bit (group_size={args.group_size})")

    tokenizer = load_tokenizer(src)
    save(dst, src, model, tokenizer, config)
    print(f"Saved quantized model to {dst}")


if __name__ == "__main__":
    main()
