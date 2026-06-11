#!/usr/bin/env python3
"""Track library / api_audio maintenance.

Usage (from the repo root):
  python3 backend/scripts/library_maintenance.py --stats
  python3 backend/scripts/library_maintenance.py --clean-backlog          # dry run
  python3 backend/scripts/library_maintenance.py --clean-backlog --yes    # delete

--clean-backlog removes ALL MP3s from ACE-Step's api_audio directory that are
not part of the library. Historical files there carry no metadata (UUID names
only) and cannot be imported into the library, so deleting them is the only
way to reclaim the space. Going forward, every successful track is moved into
the library at generation time and a daily janitor removes fresh orphans, so
the backlog never re-accumulates.

Stdlib-only — safe to run without the backend virtualenv.
"""

import argparse
import os
import sys
from pathlib import Path

DEFAULT_LIBRARY_DIR = "/Volumes/SP PCIe M.2/generative-radio/library"
# ACE-Step's current output location (no ACESTEP_TMPDIR set): <clone>/.cache/acestep/tmp/api_audio
DEFAULT_API_AUDIO_DIR = str(
    Path(__file__).resolve().parent.parent.parent.parent
    / "ACE-Step-1.5" / ".cache" / "acestep" / "tmp" / "api_audio"
)


def _dir_stats(path: Path, pattern: str = "*.mp3") -> tuple[int, float]:
    files = list(path.glob(pattern)) if path.is_dir() else []
    total = sum(f.stat().st_size for f in files)
    return len(files), total / (1024 ** 3)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stats", action="store_true", help="Show library and api_audio sizes")
    parser.add_argument("--clean-backlog", action="store_true",
                        help="Delete all api_audio MP3s (dry run unless --yes)")
    parser.add_argument("--yes", action="store_true", help="Actually delete (with --clean-backlog)")
    args = parser.parse_args()

    library_dir = Path(os.getenv("LIBRARY_DIR", DEFAULT_LIBRARY_DIR))
    api_audio_dir = Path(os.getenv("ACESTEP_API_AUDIO_DIR", DEFAULT_API_AUDIO_DIR))

    if not args.stats and not args.clean_backlog:
        parser.print_help()
        return 1

    if args.stats or args.clean_backlog:
        lib_n, lib_gb = _dir_stats(library_dir)
        api_n, api_gb = _dir_stats(api_audio_dir)
        print(f"Library   : {library_dir}\n            {lib_n} tracks, {lib_gb:.2f} GB")
        print(f"api_audio : {api_audio_dir}\n            {api_n} MP3s, {api_gb:.2f} GB")

    if args.clean_backlog:
        if not api_audio_dir.is_dir():
            print(f"\napi_audio directory not found: {api_audio_dir}")
            return 1
        files = list(api_audio_dir.glob("*.mp3"))
        if not files:
            print("\nNothing to clean.")
            return 0
        if not args.yes:
            print(f"\nDRY RUN: would delete {len(files)} MP3s. Re-run with --yes to delete.")
            return 0
        deleted = 0
        for f in files:
            try:
                f.unlink()
                deleted += 1
            except OSError as e:
                print(f"  skipped {f.name}: {e}", file=sys.stderr)
        print(f"\nDeleted {deleted}/{len(files)} MP3s from {api_audio_dir}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
