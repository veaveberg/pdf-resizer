#!/usr/bin/env python3

import argparse
import os
import pathlib
import re
import shutil
import sys


def parse_version_from_dirname(name: str):
    match = re.match(r"^gs(\d+(?:\.\d+)*)$", name.lower())
    if not match:
        return None
    parts = tuple(int(part) for part in match.group(1).split("."))
    return parts


def discover_install_roots():
    roots = []
    for env_name in ("ProgramFiles", "ProgramFiles(x86)"):
        base_raw = os.environ.get(env_name)
        if not base_raw:
            continue
        base = pathlib.Path(base_raw)
        gs_parent = base / "gs"
        if not gs_parent.exists():
            continue
        for child in gs_parent.iterdir():
            if not child.is_dir():
                continue
            version = parse_version_from_dirname(child.name)
            if version is None:
                continue
            roots.append((version, child))
    roots.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in roots]


def pick_first_existing(candidates):
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return None


def resolve_root_and_bin(args):
    root_candidates = []
    if args.gs_root:
        root_candidates.append(pathlib.Path(args.gs_root))
    root_candidates.extend(discover_install_roots())

    bin_candidates = []
    if args.gs_bin:
        bin_candidates.append(pathlib.Path(args.gs_bin))
    for root in root_candidates:
        bin_candidates.append(root / "bin" / "gswin64c.exe")
        bin_candidates.append(root / "bin" / "gswin32c.exe")

    for which_name in ("gswin64c.exe", "gswin32c.exe", "gswin64c", "gswin32c"):
        path = shutil.which(which_name)
        if path:
            bin_candidates.append(pathlib.Path(path))

    gs_bin = pick_first_existing(bin_candidates)
    if not gs_bin:
        attempted = ", ".join(str(p) for p in bin_candidates if p)
        raise RuntimeError(
            "Ghostscript executable not found. Tried: " + attempted
        )

    if args.gs_root:
        gs_root = pathlib.Path(args.gs_root)
    else:
        gs_root = gs_bin.parent.parent

    if not gs_root.exists():
        raise RuntimeError(f"Ghostscript root not found: {gs_root}")

    return gs_root.resolve(), gs_bin.resolve()


def copy_if_exists(src: pathlib.Path, dst: pathlib.Path):
    if not src.exists():
        return False
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return True


def build_share_layout(gs_root: pathlib.Path, explicit_share: pathlib.Path | None, out_root: pathlib.Path):
    share_root = out_root / "share" / "ghostscript"
    copied_any = False

    if explicit_share:
        if not explicit_share.exists():
            raise RuntimeError(f"Provided --share-dir does not exist: {explicit_share}")
        if explicit_share.name.lower() == "ghostscript":
            copy_if_exists(explicit_share, share_root)
        else:
            copy_if_exists(explicit_share, share_root / explicit_share.name)
        return True

    copied_any |= copy_if_exists(gs_root / "lib", share_root / "lib")
    copied_any |= copy_if_exists(gs_root / "Resource", share_root / "Resource")
    copied_any |= copy_if_exists(gs_root / "fonts", share_root / "fonts")
    copied_any |= copy_if_exists(gs_root / "iccprofiles", share_root / "iccprofiles")

    if not copied_any:
        copied_any |= copy_if_exists(gs_root / "share" / "ghostscript", share_root)

    return copied_any


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--gs-root", help="Ghostscript installation root (e.g. C:\\Program Files\\gs\\gs10.05.1)")
    parser.add_argument("--gs-bin", help="Path to gswin64c.exe/gswin32c.exe")
    parser.add_argument("--share-dir", help="Optional prebuilt Ghostscript share dir")
    parser.add_argument("--output-root", required=True, help="Destination runtime root")
    args = parser.parse_args()

    output_root = pathlib.Path(args.output_root).resolve()
    share_dir = pathlib.Path(args.share_dir).resolve() if args.share_dir else None

    gs_root, _ = resolve_root_and_bin(args)
    src_bin_dir = gs_root / "bin"
    if not src_bin_dir.exists():
        raise RuntimeError(f"Ghostscript bin directory not found: {src_bin_dir}")

    if output_root.exists():
        shutil.rmtree(output_root)

    out_bin_dir = output_root / "bin"
    out_bin_dir.mkdir(parents=True, exist_ok=True)

    shutil.copytree(src_bin_dir, out_bin_dir, dirs_exist_ok=True)

    copied_share = build_share_layout(gs_root, share_dir, output_root)
    if not copied_share:
        raise RuntimeError(
            "Could not stage Ghostscript resources. Expected lib/Resource under installation root."
        )

    required = output_root / "bin" / "gswin64c.exe"
    if not required.exists():
        fallback = output_root / "bin" / "gswin32c.exe"
        if not fallback.exists():
            raise RuntimeError(
                "Prepared runtime is missing gswin64c.exe and gswin32c.exe in output/bin."
            )

    print(f"Prepared Windows Ghostscript runtime at: {output_root}")
    print(f"Source Ghostscript root: {gs_root}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
