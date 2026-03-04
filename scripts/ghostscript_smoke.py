#!/usr/bin/env python3

import argparse
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


def run(command):
    completed = subprocess.run(command, capture_output=True, text=True)
    if completed.returncode != 0:
        raise RuntimeError(
            f"Command failed ({completed.returncode}): {' '.join(command)}\n"
            f"stdout:\n{completed.stdout}\n"
            f"stderr:\n{completed.stderr}"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gs", required=True, help="Path to Ghostscript executable")
    args = parser.parse_args()

    gs_bin = pathlib.Path(args.gs)
    if not gs_bin.exists():
        raise RuntimeError(f"Ghostscript binary not found: {gs_bin}")

    with tempfile.TemporaryDirectory(prefix="pdfresizer-gs-smoke-") as td:
        tmp = pathlib.Path(td)
        ps_file = tmp / "fixture.ps"
        first_pdf = tmp / "first.pdf"
        flattened_pdf = tmp / "flattened.pdf"

        ps_file.write_text(PS_FIXTURE, encoding="utf-8")

        run([str(gs_bin), "--version"])
        run(
            [
                str(gs_bin),
                "-dBATCH",
                "-dNOPAUSE",
                "-dSAFER",
                "-sDEVICE=pdfwrite",
                f"-sOutputFile={first_pdf}",
                str(ps_file),
            ]
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
            ]
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
