#!/usr/bin/env python3
"""
make_manifest.py

Generates index.json for the Benchmark Dashboard's "Load from URL"
feature. Run it pointed at your logs/ folder, then upload both the
logs/ folder and the resulting index.json to any HTTP(S) server (the
manifest must sit next to - or above - the log folders, since paths in
it are resolved relative to the manifest's own URL).

Usage:
    python3 make_manifest.py /path/to/logs
    # writes /path/to/logs/index.json

    python3 make_manifest.py            # defaults to the current directory

Then in the dashboard, set "Manifest URL" to wherever you uploaded
index.json, e.g. https://example.com/logs/index.json - the dashboard
resolves each listed path relative to that URL.

Note: browsers cannot fetch ftp:// URLs directly (support was removed
from all major browsers). If your logs currently only live on an FTP
server, you'll need to also expose them over HTTP(S) - many FTP
appliances offer this, or you can rsync/copy the folder to any static
web server.
"""

import json
import sys
from pathlib import Path


def main():
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    if not root.is_dir():
        print(f"Not a directory: {root}", file=sys.stderr)
        sys.exit(1)

    files = sorted(
        str(p.relative_to(root)).replace("\\", "/")
        for p in root.rglob("*.log")
    )

    if not files:
        print(f"No .log files found under {root}", file=sys.stderr)
        sys.exit(1)

    out_path = root / "index.json"
    out_path.write_text(json.dumps({"files": files}, indent=2) + "\n")
    print(f"Wrote {out_path} listing {len(files)} file(s).")
    print("Upload this folder (including index.json) to your HTTP(S) server, "
          "then point the dashboard's Manifest URL at index.json's address.")


if __name__ == "__main__":
    main()
