#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct PendingOpenPaths(Mutex<Vec<String>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedFile {
    file_name: String,
    directory: String,
    bytes: Vec<u8>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileError {
    code: &'static str,
    message: String,
    path: Option<String>,
}

impl NativeFileError {
    fn new(code: &'static str, message: impl Into<String>, path: Option<&Path>) -> Self {
        Self {
            code,
            message: message.into(),
            path: path.map(|value| value.to_string_lossy().into_owned()),
        }
    }

    fn io(action: &str, path: &Path, error: std::io::Error) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::PermissionDenied => "permissionDenied",
            std::io::ErrorKind::NotFound => "notFound",
            std::io::ErrorKind::AlreadyExists => "conflict",
            _ => "ioError",
        };
        Self::new(
            code,
            format!("Could not {action} '{}': {error}", path.display()),
            Some(path),
        )
    }
}

fn safe_leaf<'a>(value: &'a str, label: &str) -> Result<&'a str, NativeFileError> {
    let trimmed = value.trim();
    let mut components = Path::new(trimmed).components();
    let is_one_normal_component = matches!(
        (components.next(), components.next()),
        (Some(std::path::Component::Normal(_)), None)
    );
    if trimmed.is_empty() || !is_one_normal_component {
        return Err(NativeFileError::new(
            "invalidName",
            format!("{label} must be a single name without path separators."),
            None,
        ));
    }
    Ok(trimmed)
}

fn export_directory(directory: &str, subfolder: Option<&str>) -> Result<PathBuf, NativeFileError> {
    let base = PathBuf::from(directory);
    if !base.is_dir() {
        return Err(NativeFileError::new(
            "notFound",
            format!("The export folder '{}' is unavailable.", base.display()),
            Some(&base),
        ));
    }

    let target = match subfolder {
        Some(value) => base.join(safe_leaf(value, "Subfolder")?),
        None => base,
    };
    std::fs::create_dir_all(&target)
        .map_err(|error| NativeFileError::io("create the export folder", &target, error))?;
    Ok(target)
}

fn temporary_sibling(destination: &Path) -> PathBuf {
    let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    destination.with_file_name(format!(".{name}.pdfresizer-{}-{sequence}.tmp", std::process::id()))
}

#[tauri::command]
fn read_import_file(path: String) -> Result<ImportedFile, NativeFileError> {
    let source = PathBuf::from(path);
    if !source.is_file() {
        return Err(NativeFileError::new(
            "notFound",
            format!("The imported file '{}' is unavailable.", source.display()),
            Some(&source),
        ));
    }
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| NativeFileError::new("invalidName", "The imported filename is invalid.", Some(&source)))?
        .to_owned();
    let directory = source
        .parent()
        .ok_or_else(|| NativeFileError::new("notFound", "The imported file has no parent folder.", Some(&source)))?
        .to_string_lossy()
        .into_owned();
    let bytes = std::fs::read(&source)
        .map_err(|error| NativeFileError::io("read the imported file", &source, error))?;
    Ok(ImportedFile {
        file_name,
        directory,
        bytes,
    })
}

#[tauri::command]
fn prepare_export_directory(
    directory: String,
    subfolder: Option<String>,
) -> Result<String, NativeFileError> {
    let target = export_directory(&directory, subfolder.as_deref())?;
    let probe = temporary_sibling(&target.join("write-test"));
    let probe_result = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|file| file.sync_all());
    if let Err(error) = probe_result {
        let _ = std::fs::remove_file(&probe);
        return Err(NativeFileError::io("write to the export folder", &target, error));
    }
    std::fs::remove_file(&probe)
        .map_err(|error| NativeFileError::io("finish checking the export folder", &probe, error))?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn check_export_conflicts(
    directory: String,
    file_names: Vec<String>,
) -> Result<Vec<bool>, NativeFileError> {
    let target = export_directory(&directory, None)?;
    file_names
        .iter()
        .map(|name| Ok(target.join(safe_leaf(name, "Filename")?).exists()))
        .collect()
}

#[tauri::command]
fn write_export_file(
    directory: String,
    file_name: String,
    contents: Vec<u8>,
    overwrite: bool,
) -> Result<String, NativeFileError> {
    let target = export_directory(&directory, None)?;
    let destination = target.join(safe_leaf(&file_name, "Filename")?);
    if destination.exists() && !overwrite {
        return Err(NativeFileError::new(
            "conflict",
            format!("'{}' already exists.", destination.display()),
            Some(&destination),
        ));
    }

    let temporary = temporary_sibling(&destination);
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| NativeFileError::io("create the temporary export", &temporary, error))?;
        file.write_all(&contents)
            .and_then(|_| file.sync_all())
            .map_err(|error| NativeFileError::io("write the export", &temporary, error))?;

        #[cfg(target_os = "windows")]
        if overwrite && destination.exists() {
            std::fs::remove_file(&destination)
                .map_err(|error| NativeFileError::io("replace the existing export", &destination, error))?;
        }

        std::fs::rename(&temporary, &destination)
            .map_err(|error| NativeFileError::io("finish the export", &destination, error))?;
        Ok::<(), NativeFileError>(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result?;
    Ok(destination.to_string_lossy().into_owned())
}

#[derive(Clone, Default)]
struct GhostscriptRuntime {
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CmykEdgeSamples {
    horizontal_count: usize,
    vertical_count: usize,
    top: Vec<u8>,
    bottom: Vec<u8>,
    left: Vec<u8>,
    right: Vec<u8>,
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
    let mut push_if_exists = |path: PathBuf| {
        if path.exists() {
            entries.push(path);
        }
    };

    // Newer Ghostscript distributions (e.g. Homebrew) flatten these directly under
    // `share/ghostscript`, while some layouts place them in a versioned subdirectory.
    push_if_exists(share_ghostscript.clone());
    push_if_exists(share_ghostscript.join("lib"));
    push_if_exists(share_ghostscript.join("Resource"));
    push_if_exists(share_ghostscript.join("Resource").join("Init"));
    push_if_exists(share_ghostscript.join("Resource").join("Font"));
    push_if_exists(share_ghostscript.join("fonts"));
    push_if_exists(share_ghostscript.join("iccprofiles"));

    if let Ok(dirs) = std::fs::read_dir(&share_ghostscript) {
        for entry in dirs.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            push_if_exists(path.join("lib"));
            push_if_exists(path.join("Resource"));
            push_if_exists(path.join("Resource").join("Init"));
            push_if_exists(path.join("Resource").join("Font"));
            push_if_exists(path.join("fonts"));
            push_if_exists(path.join("iccprofiles"));
        }
    }

    entries.sort();
    entries.dedup();

    if entries.is_empty() {
        None
    } else {
        #[cfg(target_os = "windows")]
        let separator = ";";
        #[cfg(not(target_os = "windows"))]
        let separator = ":";
        Some(
            entries
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(separator),
        )
    }
}

fn collect_ghostscript_env(gs_root: &Path) -> HashMap<&'static str, String> {
    let mut envs = HashMap::new();
    if let Some(gs_lib) = collect_gs_lib_entries(gs_root) {
        envs.insert("GS_LIB", gs_lib);
    }
    envs
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
        let envs = collect_ghostscript_env(gs_root);
        if !envs.is_empty() {
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

fn has_bundled_ghostscript(runtime: &GhostscriptRuntime) -> bool {
    collect_candidates(runtime)
        .into_iter()
        .any(|candidate| candidate.gs_root.is_some() && candidate.command.exists())
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

fn flatten_with_ghostscript(
    pdf_bytes: Vec<u8>,
    page_numbers: &[u32],
    runtime: &GhostscriptRuntime,
) -> Result<Vec<u8>, String> {
    use std::io::Write;

    if page_numbers.is_empty() || page_numbers.iter().any(|page| *page == 0) {
        return Err(String::from("Outline text requires at least one valid page number."));
    }
    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join("pdfresizer_flatten_input.pdf");
    let output_path = tmp_dir.join("pdfresizer_flatten_output.pdf");

    std::fs::File::create(&input_path)
        .and_then(|mut f| f.write_all(&pdf_bytes))
        .map_err(|e| format!("Failed to write temp input file: {}", e))?;

    let output_file_arg = format!("-sOutputFile={}", output_path.display());
    let input_file_arg = format!("{}", input_path.display());
    let page_list = page_numbers
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let page_list_arg = format!("-sPageList={page_list}");
    let args = [
        "-dBATCH",
        "-dNOPAUSE",
        "-dSAFER",
        "-dQUIET",
        "-sDEVICE=pdfwrite",
        "-dNoOutputFonts",
        "-dCompatibilityLevel=1.7",
        page_list_arg.as_str(),
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

fn rasterize_with_ghostscript(
    pdf_bytes: Vec<u8>,
    dpi: u32,
    runtime: &GhostscriptRuntime,
) -> Result<Vec<u8>, String> {
    use std::io::Write;

    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join("pdfresizer_rasterize_input.pdf");
    let output_path = tmp_dir.join("pdfresizer_rasterize_output.pdf");

    std::fs::File::create(&input_path)
        .and_then(|mut f| f.write_all(&pdf_bytes))
        .map_err(|e| format!("Failed to write temp input file: {}", e))?;

    let output_file_arg = format!("-sOutputFile={}", output_path.display());
    let input_file_arg = format!("{}", input_path.display());
    let raster_dpi = dpi.clamp(72, 1200);
    let resolution_arg = format!("-r{}", raster_dpi);
    let args = [
        "-dBATCH",
        "-dNOPAUSE",
        "-dSAFER",
        "-dQUIET",
        "-sDEVICE=pdfimage32",
        resolution_arg.as_str(),
        "-dTextAlphaBits=4",
        "-dGraphicsAlphaBits=4",
        "-sCompression=Flate",
        output_file_arg.as_str(),
        input_file_arg.as_str(),
    ];
    let result = run_ghostscript(&args, runtime, None)?;

    if !result.status.success() {
        let stderr = result.stderr;
        let _ = std::fs::remove_file(&input_path);
        let _ = std::fs::remove_file(&output_path);
        return Err(format!("Ghostscript rasterize failed: {}", stderr));
    }

    let output_bytes = std::fs::read(&output_path)
        .map_err(|e| format!("Failed to read rasterized output: {}", e))?;

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);

    Ok(output_bytes)
}

fn parse_pam_cmyk(bytes: &[u8]) -> Result<(usize, usize, &[u8]), String> {
    let header_end = bytes
        .windows(6)
        .position(|window| window == b"ENDHDR")
        .ok_or_else(|| String::from("Ghostscript returned an invalid CMYK PAM image."))?;
    let data_start = bytes[header_end..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| header_end + offset + 1)
        .ok_or_else(|| String::from("Ghostscript returned an incomplete CMYK PAM header."))?;
    let header = std::str::from_utf8(&bytes[..data_start])
        .map_err(|_| String::from("Ghostscript returned a non-text PAM header."))?;
    let mut width = None;
    let mut height = None;
    let mut depth = None;
    let mut max_value = None;
    let mut tuple_type = None;

    for line in header.lines() {
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("WIDTH") => width = parts.next().and_then(|value| value.parse::<usize>().ok()),
            Some("HEIGHT") => height = parts.next().and_then(|value| value.parse::<usize>().ok()),
            Some("DEPTH") => depth = parts.next().and_then(|value| value.parse::<usize>().ok()),
            Some("MAXVAL") => max_value = parts.next().and_then(|value| value.parse::<usize>().ok()),
            Some("TUPLTYPE") => tuple_type = parts.next(),
            _ => {}
        }
    }

    let width = width.ok_or_else(|| String::from("CMYK PAM image has no width."))?;
    let height = height.ok_or_else(|| String::from("CMYK PAM image has no height."))?;
    if depth != Some(4) || max_value != Some(255) || tuple_type != Some("CMYK") {
        return Err(String::from("Ghostscript returned an unsupported CMYK PAM format."));
    }
    let expected_length = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| String::from("CMYK PAM dimensions are too large."))?;
    let pixels = &bytes[data_start..];
    if pixels.len() != expected_length {
        return Err(format!(
            "CMYK PAM pixel data has {} bytes, expected {}.",
            pixels.len(), expected_length
        ));
    }
    Ok((width, height, pixels))
}

fn sample_cmyk_edges(
    pixels: &[u8],
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
) -> Result<CmykEdgeSamples, String> {
    if left > right || top > bottom || right >= width || bottom >= height {
        return Err(String::from("CMYK edge sample coordinates are outside the rendered page."));
    }
    let pixel = |x: usize, y: usize| -> &[u8] {
        let offset = (y * width + x) * 4;
        &pixels[offset..offset + 4]
    };
    let horizontal_count = right - left + 1;
    let vertical_count = bottom - top + 1;
    let mut top_samples = Vec::with_capacity(horizontal_count * 4);
    let mut bottom_samples = Vec::with_capacity(horizontal_count * 4);
    let mut left_samples = Vec::with_capacity(vertical_count * 4);
    let mut right_samples = Vec::with_capacity(vertical_count * 4);

    for x in left..=right {
        top_samples.extend_from_slice(pixel(x, top));
        bottom_samples.extend_from_slice(pixel(x, bottom));
    }
    for y in top..=bottom {
        left_samples.extend_from_slice(pixel(left, y));
        right_samples.extend_from_slice(pixel(right, y));
    }

    Ok(CmykEdgeSamples {
        horizontal_count,
        vertical_count,
        top: top_samples,
        bottom: bottom_samples,
        left: left_samples,
        right: right_samples,
    })
}

#[allow(clippy::too_many_arguments)]
fn render_cmyk_edges_with_ghostscript(
    pdf_bytes: Vec<u8>,
    page_number: u32,
    raster_width: usize,
    raster_height: usize,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
    runtime: &GhostscriptRuntime,
) -> Result<CmykEdgeSamples, String> {
    let raster_width = raster_width.clamp(1, 5000);
    let raster_height = raster_height.clamp(1, 5000);
    let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join(format!(
        "pdfresizer_cmyk_edge_input_{}_{sequence}.pdf",
        std::process::id()
    ));
    let output_path = tmp_dir.join(format!(
        "pdfresizer_cmyk_edge_output_{}_{sequence}.pam",
        std::process::id()
    ));

    std::fs::write(&input_path, pdf_bytes)
        .map_err(|error| format!("Failed to write CMYK edge input: {error}"))?;
    let output_file_arg = format!("-sOutputFile={}", output_path.display());
    let input_file_arg = input_path.to_string_lossy().into_owned();
    let first_page_arg = format!("-dFirstPage={}", page_number.max(1));
    let last_page_arg = format!("-dLastPage={}", page_number.max(1));
    let geometry_arg = format!("-g{raster_width}x{raster_height}");
    let args = [
        "-dBATCH",
        "-dNOPAUSE",
        "-dSAFER",
        "-dQUIET",
        "-sDEVICE=pamcmyk32",
        "-dFIXEDMEDIA",
        "-dPDFFitPage",
        "-r72",
        "-sColorConversionStrategy=CMYK",
        first_page_arg.as_str(),
        last_page_arg.as_str(),
        geometry_arg.as_str(),
        output_file_arg.as_str(),
        input_file_arg.as_str(),
    ];

    let result = run_ghostscript(&args, runtime, None)
        .and_then(|_| {
            std::fs::read(&output_path)
                .map_err(|error| format!("Failed to read CMYK edge render: {error}"))
        })
        .and_then(|pam| {
            let (width, height, pixels) = parse_pam_cmyk(&pam)?;
            sample_cmyk_edges(pixels, width, height, left, top, right, bottom)
        });

    let _ = std::fs::remove_file(&input_path);
    let _ = std::fs::remove_file(&output_path);
    result
}

/// Check if Ghostscript is available (bundled or on PATH).
#[tauri::command]
fn check_ghostscript(runtime: State<'_, GhostscriptRuntime>) -> String {
    // Fast path for production bundles: avoid launching Ghostscript on app startup.
    if has_bundled_ghostscript(&runtime) {
        return String::from("bundled");
    }

    match run_ghostscript(&["--version"], &runtime, None) {
        Ok(output) => output.stdout.trim().to_string(),
        Err(e) => {
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
    page_numbers: Vec<u32>,
    runtime: State<'_, GhostscriptRuntime>,
) -> Result<Vec<u8>, String> {
    flatten_with_ghostscript(pdf_bytes, &page_numbers, &runtime)
}

/// Rasterize a PDF into an image-only CMYK PDF using Flate compression.
#[tauri::command]
fn rasterize_pdf(
    pdf_bytes: Vec<u8>,
    dpi: u32,
    runtime: State<'_, GhostscriptRuntime>,
) -> Result<Vec<u8>, String> {
    rasterize_with_ghostscript(pdf_bytes, dpi, &runtime)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn render_pdf_page_cmyk_edges(
    pdf_bytes: Vec<u8>,
    page_number: u32,
    raster_width: usize,
    raster_height: usize,
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
    runtime: State<'_, GhostscriptRuntime>,
) -> Result<CmykEdgeSamples, String> {
    render_cmyk_edges_with_ghostscript(
        pdf_bytes,
        page_number,
        raster_width,
        raster_height,
        left,
        top,
        right,
        bottom,
        &runtime,
    )
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
    let resource_dir = app.path().resource_dir().ok();
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpenPaths::default())
        .setup(|app| {
            let gs_runtime = resolve_ghostscript_runtime(app);
            app.manage(gs_runtime);
            let startup_paths = collect_startup_file_paths();
            if !startup_paths.is_empty() {
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.emit("external-files-opened", startup_paths.clone());
                }
                let state: State<'_, PendingOpenPaths> = app.state();
                let mut guard = state.0.lock().expect("pending paths mutex poisoned");
                guard.extend(startup_paths);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_import_file,
            prepare_export_directory,
            check_export_conflicts,
            write_export_file,
            check_ghostscript,
            debug_ghostscript_probe,
            flatten_pdf,
            rasterize_pdf,
            render_pdf_page_cmyk_edges,
            take_pending_open_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pdfresizer-native-export-test-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).expect("create test directory");
        path
    }

    #[test]
    fn rejects_names_that_escape_the_export_directory() {
        assert!(safe_leaf("../outside.pdf", "Filename").is_err());
        assert!(safe_leaf("nested/file.pdf", "Filename").is_err());
        assert_eq!(safe_leaf("result.pdf", "Filename").unwrap(), "result.pdf");
    }

    #[test]
    fn creates_subfolders_and_writes_exports() {
        let root = test_directory();
        let prepared = prepare_export_directory(
            root.to_string_lossy().into_owned(),
            Some("PDF exports".to_owned()),
        )
        .expect("prepare export directory");

        let output = write_export_file(
            prepared.clone(),
            "result.pdf".to_owned(),
            b"first".to_vec(),
            false,
        )
        .expect("write export");
        assert_eq!(std::fs::read(&output).unwrap(), b"first");

        let conflict = write_export_file(
            prepared.clone(),
            "result.pdf".to_owned(),
            b"second".to_vec(),
            false,
        )
        .unwrap_err();
        assert_eq!(conflict.code, "conflict");

        write_export_file(
            prepared,
            "result.pdf".to_owned(),
            b"second".to_vec(),
            true,
        )
        .expect("overwrite export");
        assert_eq!(std::fs::read(&output).unwrap(), b"second");

        std::fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn parses_and_samples_cmyk_pam_edges() {
        let mut pam = b"P7\nWIDTH 3\nHEIGHT 2\nDEPTH 4\nMAXVAL 255\nTUPLTYPE CMYK\nENDHDR\n".to_vec();
        pam.extend(0_u8..24_u8);
        let (width, height, pixels) = parse_pam_cmyk(&pam).expect("parse PAM");
        let samples = sample_cmyk_edges(pixels, width, height, 1, 0, 2, 1)
            .expect("sample edges");

        assert_eq!(samples.horizontal_count, 2);
        assert_eq!(samples.vertical_count, 2);
        assert_eq!(samples.top, vec![4, 5, 6, 7, 8, 9, 10, 11]);
        assert_eq!(samples.bottom, vec![16, 17, 18, 19, 20, 21, 22, 23]);
        assert_eq!(samples.left, vec![4, 5, 6, 7, 16, 17, 18, 19]);
        assert_eq!(samples.right, vec![8, 9, 10, 11, 20, 21, 22, 23]);
    }
}
