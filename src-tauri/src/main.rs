#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::Path;
use tauri::api::process::Command as SidecarCommand;

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

/// Check if Ghostscript is available (via bundled sidecar).
#[tauri::command]
fn check_ghostscript() -> String {
    let result = SidecarCommand::new_sidecar("gs")
        .map(|cmd| cmd.args(["--version"]).output())
        .map_err(|e| e.to_string());

    match result {
        Ok(Ok(output)) if output.status.success() => output.stdout.trim().to_string(),
        _ => String::new(),
    }
}

/// Flatten a PDF using bundled Ghostscript sidecar.
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

    // Run Ghostscript sidecar
    let result = SidecarCommand::new_sidecar("gs")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args([
            "-dBATCH",
            "-dNOPAUSE",
            "-dSAFER",
            "-dQUIET",
            "-sDEVICE=pdfwrite",
            "-dNoOutputFonts",
            "-dCompatibilityLevel=1.7",
            &format!("-sOutputFile={}", output_path.display()),
            &format!("{}", input_path.display()),
        ])
        .output()
        .map_err(|e| format!("Failed to run Ghostscript sidecar: {}", e))?;

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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            greet,
            check_file_existence,
            log_path,
            check_ghostscript,
            flatten_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
