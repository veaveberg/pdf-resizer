#!/usr/bin/env python3

import argparse
import pathlib
import shutil
import subprocess
import sys


def dependency_entries(binary: pathlib.Path):
    output = subprocess.check_output(["otool", "-L", str(binary)], text=True)
    deps = []
    for line in output.splitlines()[1:]:
        lib = line.strip().split(" ")[0]
        deps.append(lib)
    return deps


def resolve_dep_for_copy(
    dep: str, owner: pathlib.Path, lib_dir: pathlib.Path, brew_prefix: pathlib.Path
):
    if dep.startswith(("/opt/homebrew", "/usr/local")):
        path = pathlib.Path(dep)
        return path if path.exists() else None

    dep_name = pathlib.Path(dep).name

    if dep.startswith("@loader_path/"):
        # loader_path is relative to the referencing library location
        path = owner.parent / dep_name
        return path if path.exists() else None

    if dep.startswith("@rpath/"):
        candidates = [
            lib_dir / dep_name,
            owner.parent / dep_name,
            brew_prefix / "lib" / dep_name,
        ]
        for opt_root in [pathlib.Path("/opt/homebrew/opt"), pathlib.Path("/usr/local/opt")]:
            if opt_root.exists():
                candidates.extend(opt_root.glob(f"*/lib/{dep_name}"))

        for candidate in candidates:
            if candidate.exists():
                return candidate
        return None

    return None


def copy_recursive_closure(gs_bin: pathlib.Path, lib_dir: pathlib.Path, brew_prefix: pathlib.Path):
    visited = set()
    queue = [gs_bin]

    while queue:
        current = queue.pop()
        if current in visited:
            continue
        visited.add(current)

        for dep in dependency_entries(current):
            resolved = resolve_dep_for_copy(dep, current, lib_dir, brew_prefix)
            if not resolved:
                continue
            if not resolved.exists():
                raise RuntimeError(f"Missing dependency: {resolved}")
            target = lib_dir / resolved.name
            if not target.exists():
                shutil.copy2(resolved, target)
                queue.append(target)


def rewrite_install_names(gs_bin: pathlib.Path, lib_dir: pathlib.Path):
    libs = sorted(lib_dir.glob("*.dylib"))

    for lib in libs:
        subprocess.run(
            ["install_name_tool", "-id", f"@loader_path/{lib.name}", str(lib)],
            check=False,
        )
        for dep in dependency_entries(lib):
            dep_base = pathlib.Path(dep).name
            if (lib_dir / dep_base).exists():
                subprocess.run(
                    [
                        "install_name_tool",
                        "-change",
                        dep,
                        f"@loader_path/{dep_base}",
                        str(lib),
                    ],
                    check=False,
                )

    for dep in dependency_entries(gs_bin):
        dep_base = pathlib.Path(dep).name
        if (lib_dir / dep_base).exists():
            subprocess.run(
                [
                    "install_name_tool",
                    "-change",
                    dep,
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
    # Homebrew Ghostscript may contain self-referential versioned symlinks.
    # Preserve symlinks instead of dereferencing to avoid recursive copy loops.
    shutil.copytree(share_src, out_share / "ghostscript", symlinks=True)

    copy_recursive_closure(gs_bin, out_lib, brew_prefix)
    rewrite_install_names(gs_bin, out_lib)
    print(f"Prepared Ghostscript runtime at {out_root}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
