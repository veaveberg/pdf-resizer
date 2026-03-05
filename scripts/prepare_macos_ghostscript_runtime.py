#!/usr/bin/env python3

import argparse
import pathlib
import shutil
import stat
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


def make_writable(path: pathlib.Path):
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IWUSR)


def ad_hoc_sign(gs_bin: pathlib.Path, lib_dir: pathlib.Path):
    # install_name_tool invalidates Mach-O signatures on macOS; ad-hoc sign the closure.
    sign_targets = [gs_bin] + sorted(lib_dir.glob("*.dylib"))
    for target in sign_targets:
        make_writable(target)
        subprocess.run(["codesign", "--force", "--sign", "-", str(target)], check=True)


def pick_first_existing(candidates):
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return None


def prune_recursive_symlink_loops(root: pathlib.Path):
    for path in root.rglob("*"):
        if not path.is_symlink():
            continue
        if path.name != path.parent.name:
            continue
        try:
            resolved = path.resolve(strict=False)
        except OSError:
            path.unlink(missing_ok=True)
            continue
        if resolved == path.parent or resolved in path.parents:
            path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--brew-prefix")
    parser.add_argument("--gs-bin")
    parser.add_argument("--share-dir")
    parser.add_argument("--output-root", required=True)
    args = parser.parse_args()

    brew_prefix = pathlib.Path(args.brew_prefix) if args.brew_prefix else None
    out_root = pathlib.Path(args.output_root)
    out_bin = out_root / "bin"
    out_lib = out_root / "lib"
    out_share = out_root / "share"

    gs_candidates = []
    if args.gs_bin:
        gs_candidates.append(pathlib.Path(args.gs_bin))
    if brew_prefix:
        gs_candidates.extend([brew_prefix / "bin" / "gs", brew_prefix / "libexec" / "bin" / "gs"])
    gs_on_path = shutil.which("gs")
    if gs_on_path:
        gs_candidates.append(pathlib.Path(gs_on_path))

    gs_src = pick_first_existing(gs_candidates)
    if not gs_src:
        raise RuntimeError(
            "Ghostscript binary missing. Tried: "
            + ", ".join(str(p) for p in gs_candidates if p is not None)
        )
    gs_real = gs_src.resolve()

    share_candidates = []
    if args.share_dir:
        share_candidates.append(pathlib.Path(args.share_dir))
    if brew_prefix:
        share_candidates.append(brew_prefix / "share" / "ghostscript")
    share_candidates.extend(
        [
            gs_real.parent.parent / "share" / "ghostscript",
            gs_real.parent.parent.parent / "share" / "ghostscript",
        ]
    )
    share_src = pick_first_existing(share_candidates)

    if not share_src:
        raise RuntimeError(
            "Ghostscript share dir missing. Tried: "
            + ", ".join(str(p) for p in share_candidates if p is not None)
        )

    if not brew_prefix or not brew_prefix.exists():
        brew_prefix = gs_real.parent.parent

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
    prune_recursive_symlink_loops(out_share / "ghostscript")

    copy_recursive_closure(gs_bin, out_lib, brew_prefix)
    rewrite_install_names(gs_bin, out_lib)
    ad_hoc_sign(gs_bin, out_lib)
    print(f"Prepared Ghostscript runtime at {out_root}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
