# Local AI Music Generation on Mac — Research Document

> **Date:** February 20, 2026
> **Target Hardware:** Mac mini with Apple Silicon, 64GB Unified Memory
> **Goal:** Generate full songs (vocals + instrumentals) locally, no cloud dependency

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Model Comparison Matrix](#model-comparison-matrix)
3. [Top Recommended Models (Detailed)](#top-recommended-models-detailed)
   - [ACE-Step 1.5 — Best Overall](#1-ace-step-15--best-overall)
   - [HeartMuLa — Best for Vocal Songs](#2-heartmula--best-for-vocal-songs)
   - [DiffRhythm — Fastest Full-Length Songs](#3-diffrhythm--fastest-full-length-songs)
   - [YuE — Best for Lyrics-to-Song](#4-yue--best-for-lyrics-to-song)
   - [Stable Audio Open — Best for Sound Design](#5-stable-audio-open--best-for-sound-design)
   - [MusicGen (Meta) — Solid Instrumental Baseline](#6-musicgen-meta--solid-instrumental-baseline)
4. [Mac-Specific Setup Guide](#mac-specific-setup-guide)
   - [Prerequisites](#prerequisites)
   - [ACE-Step 1.5 Installation (Recommended)](#ace-step-15-installation-recommended)
   - [HeartMuLa Installation](#heartmula-installation)
   - [DiffRhythm Installation](#diffrhythm-installation)
   - [Stable Audio Open Installation](#stable-audio-open-installation)
5. [Performance Tips for Mac (64GB)](#performance-tips-for-mac-64gb)
6. [Recommended Workflow & Tool Stack](#recommended-workflow--tool-stack)
7. [Licensing Summary](#licensing-summary)
8. [Verdict & Recommendations](#verdict--recommendations)

---

## Executive Summary

As of early 2026, several open-source AI models can generate full songs — with vocals, lyrics, and instrumentals — entirely locally on a Mac. The landscape has matured dramatically since late 2025, with models like **ACE-Step 1.5**, **HeartMuLa**, and **DiffRhythm** achieving quality comparable to commercial services like Suno and Udio, while running offline with zero subscription fees.

With **64GB of unified memory**, a Mac mini with Apple Silicon is exceptionally well-positioned: most models require only 4–24GB of VRAM, meaning you can run even the most demanding configurations comfortably with room to spare.

**Top pick: ACE-Step 1.5** — the most versatile, efficient, and Mac-friendly option available today.

---

## Model Comparison Matrix

| Model | Params | Min VRAM | Max Duration | Vocals | Mac MPS | License | Quality vs. Suno |
|---|---|---|---|---|---|---|---|
| **ACE-Step 1.5** | 3.5B | ~4 GB | 10 min | Yes | Yes | Apache 2.0 | v4.5 – v5 |
| **HeartMuLa** | 3B | ~8 GB (int4) | 6 min | Yes | Yes | Apache 2.0 | ~v4.5 |
| **DiffRhythm** | — | ~8 GB | 4 min 45s | Yes | Partial | Apache 2.0 | ~v4 |
| **YuE** | — | 24 GB+ | 5 min | Yes | No (CUDA) | Apache 2.0 | ~v4 |
| **Stable Audio Open** | — | ~8 GB | 47 sec | No | Yes | Community* | N/A (SFX) |
| **MusicGen (Meta)** | 3.3B | ~8 GB | 30 sec | No | No (CPU) | CC-BY-NC 4.0 | N/A (Instru.) |

*\* Stability AI Community License — free for non-commercial use and commercial use under $1M revenue.*

---

## Top Recommended Models (Detailed)

### 1. ACE-Step 1.5 — Best Overall

**Repository:** [github.com/ace-step/ACE-Step-1.5](https://github.com/ace-step/ACE-Step-1.5)
**HuggingFace:** [ACE-Step/Ace-Step1.5](https://huggingface.co/ACE-Step/Ace-Step1.5)

ACE-Step 1.5 is the standout model for local music generation in 2026. It uses a hybrid architecture combining a Language Model (LM) planner with a Diffusion Transformer (DiT) renderer, plus a Deep Compression AutoEncoder (DCAE) for efficient audio encoding.

**Capabilities:**
- Text-to-music with lyrics, genre tags, and style descriptions
- Cover generation from reference audio
- Vocal-to-BGM conversion and track separation
- Multi-track generation and audio repainting
- Duration control from 10 seconds to 10 minutes
- BPM, key/scale, and time signature specification
- 50+ languages supported for lyrics
- 1,000+ instrument styles and timbres
- Batch generation of up to 8 songs simultaneously
- LoRA fine-tuning for personalized styles

**Performance:**
- ~4 GB VRAM minimum (fits easily in 64GB unified memory)
- ~5–10 minutes per track on Apple Silicon (MPS)
- Under 2 seconds per track on A100 (for reference)

**Why it wins:** Lowest VRAM requirements, confirmed Mac MPS support, Apache 2.0 license, broadest feature set, and commercial-grade output quality.

---

### 2. HeartMuLa — Best for Vocal Songs

**Repository:** [github.com/HeartMuLa/heartlib](https://github.com/HeartMuLa/heartlib)

HeartMuLa is a 3B-parameter model from researchers at CUHK and Peking University, designed specifically for full-song generation with synchronized vocals and lyrics. It has been praised for lyric accuracy and style consistency.

**Capabilities:**
- Full song generation with vocals and lyrics
- 10+ languages with multilingual lyrics
- Fine-grained style control via tags
- Custom model fine-tuning
- Multiple precision modes: int4 (~8GB), int8 (~12GB), float16 (~16GB), float32 (~24GB)

**Latest Models (January 2026):**
- `HeartMuLa-RL-oss-3B-20260123` — optimized for precise style/tag control
- `HeartMuLa-oss-3B` — standard version
- `HeartCodec-oss-20260123` — optimized audio decoder

**Mac Requirements:**
- macOS 15+, Apple Silicon (M-series)
- 32GB RAM recommended (you have 64GB — excellent)
- 30GB+ storage for model weights

---

### 3. DiffRhythm — Fastest Full-Length Songs

**Repository:** [github.com/ASLP-lab/DiffRhythm](https://github.com/ASLP-lab/DiffRhythm)

DiffRhythm is a diffusion-based model that generates full-length songs (~4 min 45 sec) in approximately 10 seconds on supported hardware. Developed by ASLP Lab and released under Apache 2.0.

**Capabilities:**
- Text-to-music with style prompts
- Two model variants: `base` (1m35s) and `full` (4m45s)
- Instrumental/pure music mode (no vocals)
- macOS support added March 2025

**Limitations on Mac:**
- MPS support is partial; some operations may fall back to CPU
- Docker-based setup requires NVIDIA Container Toolkit (not applicable on Mac)
- Best experience is via direct Python installation

---

### 4. YuE — Best for Lyrics-to-Song

**Repository:** [github.com/multimodal-art-projection/YuE](https://github.com/multimodal-art-projection/YuE)

YuE transforms lyrics into complete songs with vocals and accompaniment. Capable of generating 5-minute songs. However, it is heavily CUDA-dependent.

**Limitations on Mac:**
- Requires NVIDIA GPU with 24GB+ VRAM (80GB+ recommended)
- Depends on FlashAttention 2, which requires CUDA
- **Not recommended for Mac** — listed here for completeness
- Consider running via cloud GPU (RunPod, Lambda) if needed

---

### 5. Stable Audio Open — Best for Sound Design

**Repository:** [github.com/Stability-AI/stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools)
**HuggingFace:** [stabilityai/stable-audio-open-1.0](https://huggingface.co/stabilityai/stable-audio-open-1.0)

Stable Audio Open generates high-quality stereo audio at 44.1kHz from text prompts. Limited to 47 seconds — best for sound effects, ambient textures, and short musical loops rather than full songs.

**Architecture:** Autoencoder + T5 text embedding + transformer-based diffusion model.

**Good for:** Sound design layers, ambient pads, percussion loops, transitions, and supplementary audio to layer with outputs from other models.

---

### 6. MusicGen (Meta) — Solid Instrumental Baseline

**Repository:** [github.com/facebookresearch/audiocraft](https://github.com/facebookresearch/audiocraft)

Meta's MusicGen generates instrumental music from text prompts. The model is well-documented and widely used, but has significant Mac limitations.

**Limitations on Mac:**
- CPU-only execution (no MPS/GPU acceleration)
- Limited to ~30 seconds of audio per generation
- CC-BY-NC 4.0 license (non-commercial only)
- AudioGen (sound effects sibling) does support MPS, but MusicGen does not

---

## Mac-Specific Setup Guide

### Prerequisites

Install these foundational tools first:

```bash
# 1. Install Homebrew (if not already installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Install Python 3.10+ and essential tools
brew install python@3.11 ffmpeg git git-lfs

# 3. Install uv (fast Python package manager — recommended)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 4. Enable git-lfs for large model downloads
git lfs install

# 5. Verify PyTorch MPS support
python3 -c "import torch; print(torch.backends.mps.is_available())"
# Should print: True
```

---

### ACE-Step 1.5 Installation (Recommended)

This is the smoothest local experience on Mac with full MPS GPU acceleration.

```bash
# Clone the repository
git clone https://github.com/ace-step/ACE-Step-1.5.git
cd ACE-Step-1.5

# Install dependencies with uv (handles virtual env automatically)
uv sync

# Set MPS memory environment variable (prevents OOM errors)
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0

# Launch the Gradio web UI
uv run acestep
```

**First run:**
1. Open `http://localhost:7860/` in your browser
2. Click **"Initialize Service"** — this downloads the model weights (~first time takes ~40 min)
3. Enter your prompt with lyrics, genre, and style tags
4. Generate! Expect ~5–10 minutes per track on Apple Silicon

**Example prompt:**
```
[Genre: Indie Rock]
[Style: Dreamy, reverb-heavy guitars, soft vocals]
[BPM: 120] [Key: C Major]

(Verse 1)
Walking through the city lights
Every shadow hums a song tonight
The neon signs are whispering low
About the places we used to go
```

**Pro tips for 64GB Mac:**
- You can safely increase batch size to generate multiple variations at once
- With `PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`, the model can use as much unified memory as needed
- Add the export to your shell profile (`~/.zshrc`) to make it permanent:
  ```bash
  echo 'export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0' >> ~/.zshrc
  ```

---

### HeartMuLa Installation

**Option A: LM Downloader (One-Click)**

Download LM Downloader from [daiyl.com](https://daiyl.com/lm-downloader-heartmula.html), navigate to "Local Apps," find HeartMuLa, and click Install. Fully automated.

**Option B: Manual Installation**

```bash
# Clone the repository
git clone https://github.com/HeartMuLa/heartlib.git
cd heartlib

# Create a virtual environment
python3.11 -m venv .venv
source .venv/bin/activate

# Install the library
pip install -e .

# Download model weights (choose precision based on your needs)
# With 64GB RAM, you can comfortably use float16 or even float32
python -c "from heartlib import HeartMuLa; model = HeartMuLa.from_pretrained('HeartMuLa/HeartMuLa-RL-oss-3B-20260123')"
```

**Precision recommendations for 64GB Mac:**

| Precision | VRAM Usage | Quality | Recommended? |
|---|---|---|---|
| int4 | ~8 GB | Good | Fastest, lower quality |
| int8 | ~12 GB | Better | Good balance |
| float16 | ~16 GB | Great | **Best for 64GB system** |
| float32 | ~24 GB | Best | Max quality, still fits easily |

---

### DiffRhythm Installation

```bash
# Clone the repository
git clone https://github.com/ASLP-lab/DiffRhythm.git
cd DiffRhythm

# Create a virtual environment
python3.11 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Install espeak-ng (required for text processing)
brew install espeak-ng

# Download model weights from HuggingFace
# (Follow repository README for specific download instructions)

# Run the generation script
python generate.py --prompt "Jazzy Nightclub Vibe, smooth saxophone, walking bass"
```

---

### Stable Audio Open Installation

```bash
# Clone the repository
git clone https://github.com/Stability-AI/stable-audio-tools.git
cd stable-audio-tools

# Create virtual environment and install
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e .

# Download model from HuggingFace (requires accepting license)
# Visit: https://huggingface.co/stabilityai/stable-audio-open-1.0

# Run generation
python -c "
from stable_audio_tools import get_pretrained_model
from stable_audio_tools.inference.generation import generate_diffusion_cond
import torch

device = 'mps'
model, model_config = get_pretrained_model('stabilityai/stable-audio-open-1.0')
model = model.to(device)
"
```

---

## Performance Tips for Mac (64GB)

### Unified Memory Advantage

Apple Silicon's unified memory architecture means the GPU and CPU share the same 64GB pool. Unlike discrete GPUs with fixed VRAM, your models can dynamically use as much memory as available.

### Environment Variables

Add these to your `~/.zshrc` for optimal performance:

```bash
# Allow PyTorch MPS to use all available memory
export PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0

# Fall back to CPU for unsupported MPS operations (prevents crashes)
export PYTORCH_ENABLE_MPS_FALLBACK=1
```

### General Optimization Tips

1. **Close memory-hungry apps** before generation — browsers with many tabs, Docker, etc.
2. **Use float16 precision** as the default — best quality/performance balance for 64GB
3. **Batch generation** — with 64GB, you can generate multiple songs in parallel
4. **Monitor with Activity Monitor** — watch "Memory Pressure" gauge; green = good
5. **SSD matters** — model loading is I/O bound; ensure you have ample SSD space (50GB+)
6. **Keep macOS updated** — Apple continuously improves MPS/Metal performance in each release

---

## Recommended Workflow & Tool Stack

### For Beginners

| Step | Tool | Purpose |
|---|---|---|
| 1. Generate Song | **ACE-Step 1.5** (Gradio UI) | Text-to-music with lyrics and style control |
| 2. Edit & Mix | **GarageBand** (free, pre-installed) | Basic editing, mixing, effects |
| 3. Master | **GarageBand** or **Audacity** | Final polish and export |

### For Intermediate / Advanced Users

| Step | Tool | Purpose |
|---|---|---|
| 1. Generate Base Track | **ACE-Step 1.5** | Full song generation with vocal/instrumental |
| 2. Generate Variations | **HeartMuLa** | Alternative vocal takes, style exploration |
| 3. Sound Design Layers | **Stable Audio Open** | Ambient textures, transitions, FX |
| 4. Separation & Remix | **ACE-Step** (built-in) | Isolate vocals, drums, bass, etc. |
| 5. DAW Production | **Logic Pro** / **Reaper** | Professional mixing, arrangement |
| 6. Mastering | **Logic Pro** / **iZotope Ozone** | Final loudness, EQ, stereo image |

### Recommended Companion Tools

- **Audacity** (free) — Quick audio editing, format conversion
- **ffmpeg** (CLI) — Batch audio conversion and processing
- **Reaper** ($60 license) — Professional DAW, lightweight and powerful
- **Logic Pro** ($200 one-time) — Apple's professional DAW, deep Mac integration
- **ComfyUI Desktop** (free) — Node-based AI workflow tool with audio generation nodes

---

## Licensing Summary

| Model | License | Commercial Use | Key Restrictions |
|---|---|---|---|
| ACE-Step 1.5 | Apache 2.0 | Yes, unrestricted | None |
| HeartMuLa | Apache 2.0 | Yes, unrestricted | None |
| DiffRhythm | Apache 2.0 | Yes, unrestricted | None |
| YuE | Apache 2.0 | Yes, unrestricted | None |
| Stable Audio Open | Stability Community | Limited | Free under $1M revenue |
| MusicGen | CC-BY-NC 4.0 | No | Non-commercial only |

---

## Verdict & Recommendations

### Primary Recommendation: ACE-Step 1.5

For a Mac mini with 64GB, **ACE-Step 1.5 is the clear winner**:
- Confirmed Apple Silicon MPS support with tested installation guides
- Lowest VRAM requirement (~4GB) leaves plenty of headroom
- Broadest feature set (covers, separation, repainting, multi-track)
- 10-minute song generation capability
- Apache 2.0 — fully open for any use
- Active development with 4,000+ GitHub stars

### Secondary Recommendation: HeartMuLa

Use HeartMuLa alongside ACE-Step when you want:
- Alternative vocal renderings
- More precise lyric control
- Different artistic style interpretations

### For Sound Design: Stable Audio Open

Layer in Stable Audio Open outputs for:
- Ambient textures and atmospheric elements
- Transition effects and risers
- Percussive loops and rhythmic elements

### Skip for Now

- **YuE** — CUDA-only, not practical on Mac
- **MusicGen** — CPU-only on Mac, limited to 30s, non-commercial license

---

> **Bottom line:** Install ACE-Step 1.5 today. With 64GB of unified memory, your Mac mini is more than capable of running commercial-grade AI music generation entirely offline. Pair it with HeartMuLa for vocal variety and Stable Audio Open for sound design layers, and you have a complete local AI music production pipeline — no subscriptions, no cloud, no limits.
