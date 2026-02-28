#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::Path;
use std::sync::Mutex;
use std::collections::HashMap;
use tauri::api::process::Command as SidecarCommand;
use tauri::{Manager, State};

#[derive(Default)]
struct PendingOpenPaths(Mutex<Vec<String>>);

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
#[cfg(not(target_os = "windows"))]
const GHOSTSCRIPT_FALLBACK_COMMANDS: [&str; 1] = ["gs"];

fn run_ghostscript(args: &[&str]) -> Result<tauri::api::process::Output, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let resource_dir = exe_dir.join("../Resources");
                let dev_resource_dir = std::env::current_dir()
                    .ok()
                    .map(|d| d.join("src-tauri").join("bin").join("ghostscript"));
                let local_candidates = [
                    resource_dir.join("ghostscript").join("bin").join("gs"),
                    dev_resource_dir
                        .as_ref()
                        .map(|p| p.join("bin").join("gs"))
                        .unwrap_or_default(),
                    exe_dir.join("gs"),
                    exe_dir.join("gs-aarch64-apple-darwin"),
                    exe_dir.join("gs-x86_64-apple-darwin"),
                    exe_dir.join("gs-universal-apple-darwin"),
                    resource_dir.join("gs"),
                    resource_dir.join("gs-aarch64-apple-darwin"),
                    resource_dir.join("gs-x86_64-apple-darwin"),
                    resource_dir.join("gs-universal-apple-darwin"),
                ];
                for candidate in local_candidates {
                    if candidate.exists() {
                        let mut cmd = SidecarCommand::new(candidate.to_string_lossy().to_string());
                        cmd = cmd.args(args);

                        if let Some(gs_root) = candidate.parent().and_then(|p| p.parent()) {
                            let share_ghostscript = gs_root.join("share").join("ghostscript");
                            if share_ghostscript.exists() {
                                let mut gs_lib_entries = Vec::new();
                                if let Ok(entries) = std::fs::read_dir(&share_ghostscript) {
                                    for entry in entries.flatten() {
                                        let path = entry.path();
                                        if path.is_dir() {
                                            let lib_path = path.join("lib");
                                            let resource_path = path.join("Resource");
                                            if lib_path.exists() {
                                                gs_lib_entries.push(lib_path.to_string_lossy().to_string());
                                            }
                                            if resource_path.exists() {
                                                gs_lib_entries.push(resource_path.to_string_lossy().to_string());
                                            }
                                        }
                                    }
                                }
                                if !gs_lib_entries.is_empty() {
                                    let mut envs = HashMap::new();
                                    envs.insert("GS_LIB".to_string(), gs_lib_entries.join(":"));
                                    cmd = cmd.envs(envs);
                                }
                            }
                        }

                        match cmd.output() {
                            Ok(output) if output.status.success() => return Ok(output),
                            Ok(output) => {
                                println!(
                                    "App-local macOS Ghostscript failed with status {:?}: {}",
                                    output.status, output.stderr
                                );
                            }
                            Err(e) => {
                                println!("Failed to execute app-local macOS Ghostscript: {}", e);
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // First try app-local Ghostscript binaries from the Windows release package.
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let local_candidates = [
                    exe_dir.join("gs.exe"),
                    exe_dir.join("ghostscript").join("bin").join("gswin64c.exe"),
                    exe_dir.join("ghostscript").join("bin").join("gswin32c.exe"),
                ];
                for candidate in local_candidates {
                    if candidate.exists() {
                        match SidecarCommand::new(candidate.to_string_lossy().to_string())
                            .args(args)
                            .output()
                        {
                            Ok(output) if output.status.success() => return Ok(output),
                            Ok(output) => {
                                println!(
                                    "App-local Ghostscript failed with status {:?}: {}",
                                    output.status, output.stderr
                                );
                            }
                            Err(e) => {
                                println!("Failed to execute app-local Ghostscript: {}", e);
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows builds, try the bundled sidecar first.
        if let Ok(cmd) = SidecarCommand::new_sidecar("gs") {
            match cmd.args(args).output() {
                Ok(output) if output.status.success() => return Ok(output),
                Ok(output) => {
                    println!(
                        "Ghostscript sidecar failed with status {:?}: {}",
                        output.status, output.stderr
                    );
                }
                Err(e) => {
                    println!("Failed to execute Ghostscript sidecar: {}", e);
                }
            }
        }
    }

    // Last fallback to system Ghostscript on PATH.
    let mut last_error = String::from("Ghostscript is not available.");
    for command in GHOSTSCRIPT_FALLBACK_COMMANDS {
        match SidecarCommand::new(command).args(args).output() {
            Ok(output) if output.status.success() => return Ok(output),
            Ok(output) => {
                last_error = format!(
                    "Ghostscript command '{}' failed with status {:?}: {}",
                    command, output.status, output.stderr
                );
            }
            Err(e) => {
                last_error = format!("Failed to execute Ghostscript command '{}': {}", command, e);
            }
        }
    }

    Err(last_error)
}

/// Check if Ghostscript is available (bundled or on PATH).
#[tauri::command]
fn check_ghostscript() -> String {
    match run_ghostscript(&["--version"]) {
        Ok(output) => output.stdout.trim().to_string(),
        Err(e) => {
            println!("Ghostscript availability check failed: {}", e);
            String::new()
        }
    }
}

/// Flatten a PDF using Ghostscript (bundled sidecar preferred).
#[tauri::command]
fn flatten_pdf(pdf_bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join("pdfresizer_flatten_input.pdf");
    let output_path = tmp_dir.join("pdfresizer_flatten_output.pdf");

    // Write input bytes to temp file
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
    let result = run_ghostscript(&args)?;

    if !result.status.success() {
        let stderr = result.stderr;
        let _ = std::fs::remove_file(&input_path);
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("Ghostscript failed: {}", stderr));
    }

    // Read flattened output
    let output_bytes = std::fs::read(&output_path)
        .map_err(|e| format!("Failed to read flattened output: {}", e))?;

    // Clean up temp files
    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);

    Ok(output_bytes)
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

fn main() {
    tauri::Builder::default()
        .manage(PendingOpenPaths::default())
        .setup(|app| {
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
            flatten_pdf,
            take_pending_open_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
