# Ghostscript WebAssembly

The web app uses `@okathira/ghostpdl-wasm` 1.1.0 to run Ghostscript 10.06.0 in a Web Worker. PDF bytes remain in the browser.

The worker supports these operations:

- Text outlining with `pdfwrite -dNoOutputFonts`. Selected pages that contain no
  font resources are treated as already outlined and bypass Ghostscript, which
  avoids an unnecessary full-page rewrite of their color spaces.
- CMYK image-only PDF output with `pdfimage32`.
- CMYK edge sampling for vector padding with `tiffsep`, composite-only output,
  and uncompressed TIFF parsing. Edge sampling always uses the original selected
  source page, even when final artwork is outlined. When that page contains a
  four-channel ICC profile, the worker renders into that profile and the PDF
  writer uses the same ICCBased colour space for its padding rectangles. Sources
  without a CMYK profile use `UseFastColor` and DeviceCMYK padding.

Text outlining passes the active export selection to Ghostscript with
`-sPageList`. The outlined intermediate PDF contains only those pages, and the
exporter maps their original page indexes to the intermediate document's order.

The desktop app uses `pamcmyk32` for edge sampling. The published WASM package does not include that device. A future in-house WASM build can include `pamcmyk32` and replace the TIFF path without changing the frontend processor interface.

Ghostscript and this package are licensed under AGPL-3.0-or-later. Before publishing the web app, confirm that the application's source-distribution and notice requirements are met, or obtain an Artifex commercial license. This note is not legal advice.
