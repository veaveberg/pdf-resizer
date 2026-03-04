#!/usr/bin/env python3

import argparse
import pathlib
import shutil
import subprocess
import sys


def collect_deps(binary: pathlib.Path):
    output = subprocess.check_output(["otool", "-L", str(binary)], text=True)
    deps = []
    for line in output.splitlines()[1:]:
        lib = line.strip().split(" ")[0]
        if lib.startswith(("/opt/homebrew", "/usr/local")):
            deps.append(pathlib.Path(lib))
    return deps


def copy_recursive_closure(gs_bin: pathlib.Path, lib_dir: pathlib.Path):
    visited = set()
    queue = [gs_bin]

    while queue:
        current = queue.pop()
        if current in visited:
            continue
        visited.add(current)

        for dep in collect_deps(current):
            if not dep.exists():
                raise RuntimeError(f"Missing dependency: {dep}")
            target = lib_dir / dep.name
            if not target.exists():
                shutil.copy2(dep, target)
                queue.append(target)


def rewrite_install_names(gs_bin: pathlib.Path, lib_dir: pathlib.Path):
    libs = sorted(lib_dir.glob("*.dylib"))

    for lib in libs:
        subprocess.run(
            ["install_name_tool", "-id", f"@loader_path/{lib.name}", str(lib)],
            check=False,
        )
        for dep in collect_deps(lib):
            dep_base = dep.name
            if (lib_dir / dep_base).exists():
                subprocess.run(
                    [
                        "install_name_tool",
                        "-change",
                        str(dep),
                        f"@loader_path/{dep_base}",
                        str(lib),
                    ],
                    check=False,
                )

    for dep in collect_deps(gs_bin):
        dep_base = dep.name
        if (lib_dir / dep_base).exists():
            subprocess.run(
                [
                    "install_name_tool",
                    "-change",
                    str(dep),
                    f"@executable_path/../lib/{dep_base}",
                    str(gs_bin),
                ],
                check=False,
            )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brew-prefix", required=True)
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()

    brew_prefix = pathlib.Path(args.brew_prefix)
    out_root = pathlib.Path(args.output_root)
    out_bin = out_root / "bin"
    out_lib = out_root / "lib"
    out_share = out_root / "share"

    gs_src = brew_prefix / "bin" / "gs"
    share_src = brew_prefix / "share" / "ghostscript"

    if not gs_src.exists():
        raise RuntimeError(f"Ghostscript binary missing at {gs_src}")
    if not share_src.exists():
        raise RuntimeError(f"Ghostscript share dir missing at {share_src}")

    if out_root.exists():
        shutil.rmtree(out_root)
    out_bin.mkdir(parents=True, exist_ok=True)
    out_lib.mkdir(parents=True, exist_ok=True)
    out_share.mkdir(parents=True, exist_ok=True)

    gs_bin = out_bin / "gs"
    shutil.copy2(gs_src, gs_bin)
    shutil.copytree(share_src, out_share / "ghostscript")

    copy_recursive_closure(gs_bin, out_lib)
    rewrite_install_names(gs_bin, out_lib)
    print(f"Prepared Ghostscript runtime at {out_root}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
