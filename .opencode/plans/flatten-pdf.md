# Flatten PDF Feature - Implementation Plan

## Goal
Add a "Flatten" checkbox that pre-processes the source PDF through Ghostscript's `-dNoOutputFonts` flag before resizing. This converts all text to vector outlines, eliminating font dependencies and stroke interpretation issues for print. Tauri-only feature; disabled with tooltip on web.

## Changes

### 1. `src-tauri/src/main.rs` — Add two new Tauri commands

Add `use std::process::Command;` to imports.

**`check_ghostscript`** — Runs `gs --version`, returns version string or empty string if not found.

```rust
#[tauri::command]
fn check_ghostscript() -> String {
    let result = Command::new("gs").arg("--version").output();
    match result {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}
```

**`flatten_pdf`** — Takes source PDF bytes, writes to temp file, runs `gs -dNoOutputFonts`, returns flattened bytes.

```rust
#[tauri::command]
fn flatten_pdf(pdf_bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let tmp_dir = std::env::temp_dir();
    let input_path = tmp_dir.join("pdfresizer_flatten_input.pdf");
    let output_path = tmp_dir.join("pdfresizer_flatten_output.pdf");

    std::fs::File::create(&input_path)
        .and_then(|mut f| f.write_all(&pdf_bytes))
        .map_err(|e| format!("Failed to write temp input file: {}", e))?;

    let result = Command::new("gs")
        .args([
            "-dBATCH", "-dNOPAUSE", "-dSAFER", "-dQUIET",
            "-sDEVICE=pdfwrite", "-dNoOutputFonts",
            "-dCompatibilityLevel=1.7",
            &format!("-sOutputFile={}", output_path.display()),
            &format!("{}", input_path.display()),
        ])
        .output()
        .map_err(|e| format!("Failed to run Ghostscript: {}", e))?;

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
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
```

Register both in the invoke handler:
```rust
.invoke_handler(tauri::generate_handler![
    greet, check_file_existence, log_path,
    check_ghostscript, flatten_pdf
])
```

### 2. `src-tauri/Cargo.toml` — No changes needed
`std::process::Command` is in the standard library.

### 3. `src-tauri/tauri.conf.json` — No changes needed
The `shell` allowlist is NOT needed here since we use `std::process::Command` directly in Rust (not Tauri's shell API from the frontend). The Tauri commands handle everything server-side.

### 4. `src/PDFDropZone.tsx` — Frontend changes

**State (already partially done):**
- `flatten` state already added (line ~155)
- Add: `const [ghostscriptAvailable, setGhostscriptAvailable] = useState(false);`

**Startup detection:**
Add a `useEffect` that checks for GS on mount (Tauri only):
```tsx
useEffect(() => {
  if (isTauri) {
    invoke('check_ghostscript').then((version: any) => {
      setGhostscriptAvailable(Boolean(version));
    }).catch(() => setGhostscriptAvailable(false));
  }
}, []);
```

Note: `isTauri` is currently computed inside the `performSave` scope. It needs to be moved to component level (or duplicated for the effect). It's already used in the JSX for export location, so it may already be accessible — need to verify exact scope during implementation.

**UI update (Flatten checkbox — already partially added):**
Update the checkbox section to handle the disabled/tooltip state:
```tsx
{file && (
  <div style={{
    width: 400, maxWidth: '100%', margin: '24px auto 0 auto',
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
  }}>
    <label
      title={!isTauri ? 'Requires desktop app with Ghostscript installed' :
             !ghostscriptAvailable ? 'Ghostscript not found. Install with: brew install ghostscript' : undefined}
      style={{
        display: 'flex', alignItems: 'center', fontWeight: 500, fontSize: 16,
        color: 'var(--text-color)',
        cursor: (isTauri && ghostscriptAvailable) ? 'pointer' : 'not-allowed',
        opacity: (isTauri && ghostscriptAvailable) ? 1 : 0.5,
      }}
    >
      <input
        type="checkbox"
        checked={flatten}
        onChange={e => setFlatten(e.target.checked)}
        disabled={!isTauri || !ghostscriptAvailable}
        style={{ marginRight: 8 }}
      />
      Flatten
    </label>
  </div>
)}
```

**`performSave` — Pre-process with flatten:**
At the top of `performSave`, before the adjuster loop, if `flatten` is true:
```tsx
let arrayBuffer = await fileToSave.arrayBuffer();

// Pre-process: flatten via Ghostscript if enabled
if (flatten && isTauri) {
  try {
    const flattenedBytes: number[] = await invoke('flatten_pdf', {
      pdfBytes: Array.from(new Uint8Array(arrayBuffer))
    });
    arrayBuffer = new Uint8Array(flattenedBytes).buffer;
  } catch (e: any) {
    throw new Error(`Flatten failed: ${e}`);
  }
}

const pdfDoc = await PDFDocument.load(arrayBuffer);
```

This replaces the existing:
```tsx
const arrayBuffer = await fileToSave.arrayBuffer();
const pdfDoc = await PDFDocument.load(arrayBuffer);
```

### 5. Summary of file changes

| File | Change |
|---|---|
| `src-tauri/src/main.rs` | Add `check_ghostscript` and `flatten_pdf` commands, register them |
| `src/PDFDropZone.tsx` | Add `ghostscriptAvailable` state, GS detection useEffect, update Flatten checkbox with disabled/tooltip logic, add flatten pre-processing in `performSave` |

No new files. No new dependencies. No config changes needed.
