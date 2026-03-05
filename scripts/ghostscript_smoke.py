#!/usr/bin/env python3

import argparse
import os
import pathlib
import subprocess
import tempfile
import sys


PS_FIXTURE = """%!PS
/Times-Roman findfont 12 scalefont setfont
72 720 moveto
(PDF Resizer smoke test) show
showpage
"""


def run(command, env=None):
    completed = subprocess.run(command, capture_output=True, text=True, env=env)
    if completed.returncode != 0:
        raise RuntimeError(
            f"Command failed ({completed.returncode}): {' '.join(command)}\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )

def build_gs_env(gs_root: pathlib.Path):
    share = gs_root / "share" / "ghostscript"
    if not share.exists():
        return None

    entries = []

    def push_if_exists(path: pathlib.Path):
        if path.exists():
            entries.append(path)

    push_if_exists(share)
    push_if_exists(share / "lib")
    push_if_exists(share / "Resource")
    push_if_exists(share / "Resource" / "Init")
    push_if_exists(share / "Resource" / "Font")
    push_if_exists(share / "fonts")
    push_if_exists(share / "iccprofiles")

    for child in share.iterdir():
        if not child.is_dir():
            continue
        push_if_exists(child / "lib")
        push_if_exists(child / "Resource")
        push_if_exists(child / "Resource" / "Init")
        push_if_exists(child / "Resource" / "Font")
        push_if_exists(child / "fonts")
        push_if_exists(child / "iccprofiles")

    deduped = []
    seen = set()
    for entry in entries:
        key = str(entry.resolve())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)

    if not deduped:
        return None

    env = os.environ.copy()
    separator = ";" if os.name == "nt" else ":"
    env["GS_LIB"] = separator.join(str(p) for p in deduped)
    return env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gs", required=True, help="Path to Ghostscript executable")
    parser.add_argument("--gs-root", help="Optional Ghostscript runtime root for GS_LIB setup")
    args = parser.parse_args()

    gs_bin = pathlib.Path(args.gs)
    if not gs_bin.exists():
        raise RuntimeError(f"Ghostscript binary not found: {gs_bin}")
    gs_env = None
    if args.gs_root:
        gs_root = pathlib.Path(args.gs_root)
        if not gs_root.exists():
            raise RuntimeError(f"Ghostscript root not found: {gs_root}")
        gs_env = build_gs_env(gs_root)

    with tempfile.TemporaryDirectory(prefix="pdfresizer-gs-smoke-") as td:
        tmp = pathlib.Path(td)
        ps_file = tmp / "fixture.ps"
        first_pdf = tmp / "first.pdf"
        flattened_pdf = tmp / "flattened.pdf"

        ps_file.write_text(PS_FIXTURE, encoding="utf-8")

        run([str(gs_bin), "--version"], env=gs_env)
        run(
            [
                str(gs_bin),
                "-dBATCH",
                "-dNOPAUSE",
                "-dSAFER",
                "-sDEVICE=pdfwrite",
                f"-sOutputFile={first_pdf}",
                str(ps_file),
            ],
            env=gs_env,
        )
        run(
            [
                str(gs_bin),
                "-dBATCH",
                "-dNOPAUSE",
                "-dSAFER",
                "-dQUIET",
                "-sDEVICE=pdfwrite",
                "-dNoOutputFonts",
                "-dCompatibilityLevel=1.7",
                f"-sOutputFile={flattened_pdf}",
                str(first_pdf),
            ],
            env=gs_env,
        )

        if not flattened_pdf.exists() or flattened_pdf.stat().st_size == 0:
            raise RuntimeError("Flatten smoke output is missing or empty")

    print(f"Ghostscript smoke passed: {gs_bin}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
