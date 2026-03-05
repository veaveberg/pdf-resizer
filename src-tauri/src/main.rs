#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use pdfium_render::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

#[derive(Default)]
struct PendingOpenPaths(Mutex<Vec<String>>);

#[derive(Clone, Default)]
struct GhostscriptRuntime {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    roots: Vec<PathBuf>,
}

#[derive(Clone, Default)]
struct PdfiumRuntime {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    roots: Vec<PathBuf>,
}

#[derive(Clone, Default)]
struct GhostscriptProbeLog {
    attempted: Vec<String>,
    selected: Option<String>,
    last_error: Option<String>,
}

#[derive(serde::Serialize)]
struct GhostscriptProbeResult {
    attempted: Vec<String>,
    selected: Option<String>,
    last_error: Option<String>,
    mac_root: Option<String>,
    windows_root: Option<String>,
}

#[derive(Clone)]
struct GhostscriptCandidate {
    command: PathBuf,
    gs_root: Option<PathBuf>,
}

struct GhostscriptExecOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

impl GhostscriptRuntime {
    fn mac_root_string(&self) -> Option<String> {
        #[cfg(target_os = "macos")]
        {
            return self.roots.first().map(|p| p.to_string_lossy().to_string());
        }
        #[cfg(not(target_os = "macos"))]
        {
            None
        }
    }

    fn windows_root_string(&self) -> Option<String> {
        #[cfg(target_os = "windows")]
        {
            return self.roots.first().map(|p| p.to_string_lossy().to_string());
        }
        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }
}

#[tauri::command]
fn check_file_existence(file_paths: Vec<String>) -> Vec<bool> {
    file_paths
        .into_iter()
        .map(|path| Path::new(&path).exists())
        .collect()
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn log_path(path: String) {
    println!("Received path from frontend: {}", path);
}

#[tauri::command]
fn take_pending_open_paths(state: State<'_, PendingOpenPaths>) -> Vec<String> {
    let mut guard = state.0.lock().expect("pending paths mutex poisoned");
    let paths = guard.clone();
    guard.clear();
    paths
}

#[cfg(target_os = "windows")]
const GHOSTSCRIPT_FALLBACK_COMMANDS: [&str; 3] = ["gswin64c", "gswin32c", "gs"];
#[cfg(target_os = "macos")]
const GHOSTSCRIPT_FALLBACK_COMMANDS: [&str; 3] =
    ["gs", "/opt/homebrew/bin/gs", "/usr/local/bin/gs"];
#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
const GHOSTSCRIPT_FALLBACK_COMMANDS: [&str; 1] = ["gs"];

fn collect_gs_lib_entries(gs_root: &Path) -> Option<String> {
    let share_ghostscript = gs_root.join("share").join("ghostscript");
    if !share_ghostscript.exists() {
        return None;
    }
    let mut entries = Vec::new();
    if let Ok(dirs) = std::fs::read_dir(&share_ghostscript) {
        for entry in dirs.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let lib_path = path.join("lib");
            let resource_path = path.join("Resource");
            if lib_path.exists() {
                entries.push(lib_path.to_string_lossy().to_string());
            }
            if resource_path.exists() {
                entries.push(resource_path.to_string_lossy().to_string());
            }
        }
    }
    if entries.is_empty() {
        None
    } else {
        #[cfg(target_os = "windows")]
        let separator = ";";
        #[cfg(not(target_os = "windows"))]
        let separator = ":";
        Some(entries.join(separator))
    }
}

fn record_attempt(log: &mut GhostscriptProbeLog, command: &Path) {
    log.attempted.push(command.to_string_lossy().to_string());
}

fn run_candidate(
    candidate: &GhostscriptCandidate,
    args: &[&str],
    log: &mut GhostscriptProbeLog,
) -> Result<GhostscriptExecOutput, String> {
    record_attempt(log, &candidate.command);

    let mut cmd = std::process::Command::new(&candidate.command);
    cmd.args(args);
    if let Some(gs_root) = candidate.gs_root.as_deref() {
        if let Some(gs_lib) = collect_gs_lib_entries(gs_root) {
            let mut envs = HashMap::new();
            envs.insert("GS_LIB", gs_lib);
            cmd.envs(envs);
        }
    }

    match cmd.output() {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            log.selected = Some(candidate.command.to_string_lossy().to_string());
            Ok(GhostscriptExecOutput {
                status: output.status,
                stdout,
                stderr,
            })
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let error = format!(
                "Ghostscript command '{}' failed with status {:?}: {}",
                candidate.command.display(),
                output.status,
                stderr
            );
            log.last_error = Some(error.clone());
            Err(error)
        }
        Err(e) => {
            let error = format!(
                "Failed to execute Ghostscript command '{}': {}",
                candidate.command.display(),
                e
            );
            log.last_error = Some(error.clone());
            Err(error)
        }
    }
}

fn collect_candidates(runtime: &GhostscriptRuntime) -> Vec<GhostscriptCandidate> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    {
        for root in &runtime.roots {
            candidates.push(GhostscriptCandidate {
                command: root.join("bin").join("gs"),
                gs_root: Some(root.clone()),
            });
            candidates.push(GhostscriptCandidate {
                command: root.join("gs"),
                gs_root: Some(root.clone()),
            });
        }
    }

    #[cfg(target_os = "windows")]
    {
        for root in &runtime.roots {
            candidates.push(GhostscriptCandidate {
                command: root.join("bin").join("gswin64c.exe"),
                gs_root: Some(root.clone()),
            });
            candidates.push(GhostscriptCandidate {
                command: root.join("bin").join("gswin32c.exe"),
                gs_root: Some(root.clone()),
            });
        }
    }

    candidates
}

fn run_ghostscript(
    args: &[&str],
    runtime: &GhostscriptRuntime,
    probe: Option<&mut GhostscriptProbeLog>,
) -> Result<GhostscriptExecOutput, String> {
    let mut log = GhostscriptProbeLog::default();

    for candidate in collect_candidates(runtime) {
        if !candidate.command.exists() {
            continue;
        }
        if let Ok(output) = run_candidate(&candidate, args, &mut log) {
            if let Some(probe_log) = probe {
                *probe_log = log;
            }
            return Ok(output);
        }
    }

    // Last fallback to system Ghostscript on PATH.
    for command in GHOSTSCRIPT_FALLBACK_COMMANDS {
        let command_path = PathBuf::from(command);
        if command.starts_with('/') && !command_path.exists() {
            continue;
        }
        let candidate = GhostscriptCandidate {
            command: command_path,
            gs_root: None,
        };
        if let Ok(output) = run_candidate(&candidate, args, &mut log) {
            if let Some(probe_log) = probe {
                *probe_log = log;
            }
            return Ok(output);
        }
    }

    let error = log
        .last_error
        .clone()
        .unwrap_or_else(|| String::from("Ghostscript is not available."));
    if let Some(probe_log) = probe {
        *probe_log = log;
    }
    Err(error)
}

fn bind_pdfium(runtime: &PdfiumRuntime) -> Result<Pdfium, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        for root in &runtime.roots {
            let direct_candidate = Pdfium::pdfium_platform_library_name_at_path(root);
            if direct_candidate.exists() {
                if let Ok(bindings) = Pdfium::bind_to_library(&direct_candidate) {
                    return Ok(Pdfium::new(bindings));
                }
            }

            let lib_candidate = Pdfium::pdfium_platform_library_name_at_path(&root.join("lib"));
            if lib_candidate.exists() {
                if let Ok(bindings) = Pdfium::bind_to_library(&lib_candidate) {
                    return Ok(Pdfium::new(bindings));
                }
            }
        }
    }

    Pdfium::bind_to_system_library()
        .map(Pdfium::new)
        .map_err(|e| format!("PDFium bind failed: {}", e))
}

fn flatten_with_pdfium(pdf_bytes: Vec<u8>, runtime: &PdfiumRuntime) -> Result<Vec<u8>, String> {
    let pdfium = bind_pdfium(runtime)?;
    let mut document = pdfium
        .load_pdf_from_byte_vec(pdf_bytes, None)
        .map_err(|e| format!("PDFium load failed: {}", e))?;
    let page_count = document.pages().len();
    for page_index in 0..page_count {
        let mut page = document
            .pages_mut()
            .get(page_index)
            .map_err(|e| format!("PDFium page load failed at index {}: {}", page_index, e))?;
        page.flatten()
            .map_err(|e| format!("PDFium flatten failed at index {}: {}", page_index, e))?;
    }
    document
        .save_to_bytes()
        .map_err(|e| format!("PDFium save failed: {}", e))
}

fn flatten_with_ghostscript(
    pdf_bytes: Vec<u8>,
    runtime: &GhostscriptRuntime,
) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join("pdfresizer_flatten_input.pdf");
    let output_path = tmp_dir.join("pdfresizer_flatten_output.pdf");

    std::fs::File::create(&input_path)
        .and_then(|mut f| f.write_all(&pdf_bytes))
        .map_err(|e| format!("Failed to write temp input file: {}", e))?;

    let output_file_arg = format!("-sOutputFile={}", output_path.display());
    let input_file_arg = format!("{}", input_path.display());
    let args = [
        "-dBATCH",
        "-dNOPAUSE",
        "-dSAFER",
        "-dQUIET",
        "-sDEVICE=pdfwrite",
        "-dNoOutputFonts",
        "-dCompatibilityLevel=1.7",
        output_file_arg.as_str(),
        input_file_arg.as_str(),
    ];
    let result = run_ghostscript(&args, runtime, None)?;

    if !result.status.success() {
        let stderr = result.stderr;
        let _ = std::fs::remove_file(&input_path);
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("Ghostscript failed: {}", stderr));
    }

    let output_bytes = std::fs::read(&output_path)
        .map_err(|e| format!("Failed to read flattened output: {}", e))?;

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);

    Ok(output_bytes)
}

/// Check if Ghostscript is available (bundled or on PATH).
#[tauri::command]
fn check_ghostscript(
    runtime: State<'_, GhostscriptRuntime>,
    pdfium_runtime: State<'_, PdfiumRuntime>,
) -> String {
    match run_ghostscript(&["--version"], &runtime, None) {
        Ok(output) => output.stdout.trim().to_string(),
        Err(e) => {
            if bind_pdfium(&pdfium_runtime).is_ok() {
                return String::from("PDFium");
            }
            // Missing Ghostscript is an expected state in dev; keep logs quiet for ENOENT-like cases.
            let lower = e.to_lowercase();
            let missing = lower.contains("no such file or directory")
                || lower.contains("not available")
                || lower.contains("not found");
            if !missing {
                println!("Ghostscript availability check failed: {}", e);
            }
            String::new()
        }
    }
}

#[tauri::command]
fn debug_ghostscript_probe(runtime: State<'_, GhostscriptRuntime>) -> GhostscriptProbeResult {
    if !cfg!(debug_assertions) {
        return GhostscriptProbeResult {
            attempted: Vec::new(),
            selected: None,
            last_error: Some(String::from(
                "debug_ghostscript_probe is disabled in production builds.",
            )),
            mac_root: runtime.mac_root_string(),
            windows_root: runtime.windows_root_string(),
        };
    }

    let mut probe = GhostscriptProbeLog::default();
    let result = run_ghostscript(&["--version"], &runtime, Some(&mut probe));
    if let Err(error) = result {
        if probe.last_error.is_none() {
            probe.last_error = Some(error);
        }
    }

    GhostscriptProbeResult {
        attempted: probe.attempted,
        selected: probe.selected,
        last_error: probe.last_error,
        mac_root: runtime.mac_root_string(),
        windows_root: runtime.windows_root_string(),
    }
}

/// Flatten a PDF using Ghostscript (bundled sidecar preferred).
#[tauri::command]
fn flatten_pdf(
    pdf_bytes: Vec<u8>,
    runtime: State<'_, GhostscriptRuntime>,
    pdfium_runtime: State<'_, PdfiumRuntime>,
) -> Result<Vec<u8>, String> {
    if let Ok(output) = flatten_with_ghostscript(pdf_bytes.clone(), &runtime) {
        return Ok(output);
    }
    flatten_with_pdfium(pdf_bytes, &pdfium_runtime)
}

fn collect_startup_file_paths() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter_map(|arg| {
            let p = Path::new(&arg);
            if p.exists() && p.is_file() {
                Some(arg)
            } else {
                None
            }
        })
        .collect()
}

fn push_root_if_exists(roots: &mut Vec<PathBuf>, root: PathBuf) {
    if root.exists() && root.is_dir() && !roots.iter().any(|existing| existing == &root) {
        roots.push(root);
    }
}

fn resolve_ghostscript_runtime(app: &tauri::App) -> GhostscriptRuntime {
    let resource_dir = app.path_resolver().resource_dir();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()));

    let mut runtime = GhostscriptRuntime::default();

    #[cfg(target_os = "macos")]
    {
        let mut roots = Vec::new();
        if let Some(base) = resource_dir.as_ref() {
            push_root_if_exists(&mut roots, base.join("bin").join("ghostscript"));
        }
        if let Some(base) = exe_dir.as_ref() {
            if let Some(contents_dir) = base.parent() {
                if let Some(app_dir) = contents_dir.parent() {
                    push_root_if_exists(
                        &mut roots,
                        app_dir.join("Resources").join("bin").join("ghostscript"),
                    );
                }
            }
        }
        push_root_if_exists(&mut roots, manifest_dir.join("bin").join("ghostscript"));
        runtime.roots = roots;
    }

    #[cfg(target_os = "windows")]
    {
        let mut roots = Vec::new();
        if let Some(base) = resource_dir.as_ref() {
            push_root_if_exists(&mut roots, base.join("bin").join("ghostscript-win"));
            push_root_if_exists(&mut roots, base.join("ghostscript-win"));
            push_root_if_exists(
                &mut roots,
                base.join("resources").join("bin").join("ghostscript-win"),
            );
        }
        if let Some(base) = exe_dir.as_ref() {
            push_root_if_exists(&mut roots, base.join("bin").join("ghostscript-win"));
            push_root_if_exists(&mut roots, base.join("ghostscript-win"));
            push_root_if_exists(
                &mut roots,
                base.join("resources").join("bin").join("ghostscript-win"),
            );
        }
        push_root_if_exists(&mut roots, manifest_dir.join("bin").join("ghostscript-win"));
        runtime.roots = roots;
    }

    runtime
}

fn resolve_pdfium_runtime(app: &tauri::App) -> PdfiumRuntime {
    let resource_dir = app.path_resolver().resource_dir();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.to_path_buf()));

    let mut runtime = PdfiumRuntime::default();

    #[cfg(target_os = "macos")]
    {
        let mut roots = Vec::new();
        if let Some(base) = resource_dir.as_ref() {
            push_root_if_exists(&mut roots, base.join("bin").join("pdfium-macos"));
            push_root_if_exists(&mut roots, base.join("bin").join("pdfium"));
            push_root_if_exists(&mut roots, base.join("Frameworks"));
        }
        if let Some(base) = exe_dir.as_ref() {
            if let Some(contents_dir) = base.parent() {
                if let Some(app_dir) = contents_dir.parent() {
                    let resources = app_dir.join("Resources");
                    push_root_if_exists(&mut roots, resources.join("bin").join("pdfium-macos"));
                    push_root_if_exists(&mut roots, resources.join("bin").join("pdfium"));
                }
            }
        }
        push_root_if_exists(&mut roots, manifest_dir.join("bin").join("pdfium-macos"));
        push_root_if_exists(&mut roots, manifest_dir.join("bin").join("pdfium"));
        runtime.roots = roots;
    }

    #[cfg(target_os = "windows")]
    {
        let mut roots = Vec::new();
        if let Some(base) = resource_dir.as_ref() {
            push_root_if_exists(&mut roots, base.join("bin").join("pdfium-win"));
            push_root_if_exists(&mut roots, base.join("bin").join("pdfium"));
            push_root_if_exists(&mut roots, base.join("pdfium-win"));
            push_root_if_exists(&mut roots, base.join("pdfium"));
        }
        if let Some(base) = exe_dir.as_ref() {
            push_root_if_exists(&mut roots, base.join("bin").join("pdfium-win"));
            push_root_if_exists(&mut roots, base.join("bin").join("pdfium"));
            push_root_if_exists(&mut roots, base.join("pdfium-win"));
            push_root_if_exists(&mut roots, base.join("pdfium"));
        }
        push_root_if_exists(&mut roots, manifest_dir.join("bin").join("pdfium-win"));
        push_root_if_exists(&mut roots, manifest_dir.join("bin").join("pdfium"));
        runtime.roots = roots;
    }

    runtime
}

fn main() {
    tauri::Builder::default()
        .manage(PendingOpenPaths::default())
        .setup(|app| {
            let gs_runtime = resolve_ghostscript_runtime(app);
            app.manage(gs_runtime);
            let pdfium_runtime = resolve_pdfium_runtime(app);
            app.manage(pdfium_runtime);
            let startup_paths = collect_startup_file_paths();
            if !startup_paths.is_empty() {
                if let Some(main_window) = app.get_window("main") {
                    let _ = main_window.emit("external-files-opened", startup_paths.clone());
                }
                let state: State<'_, PendingOpenPaths> = app.state();
                let mut guard = state.0.lock().expect("pending paths mutex poisoned");
                guard.extend(startup_paths);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            check_file_existence,
            log_path,
            check_ghostscript,
            debug_ghostscript_probe,
            flatten_pdf,
            take_pending_open_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
