import React, { useRef, useState, useEffect } from 'react';
import { GlobalWorkerOptions, getDocument, version as pdfjsVersion } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import SizeAdjusterCard from './SizeAdjusterCard';
import ArrowLeftArrowRight from './assets/arrow.left.arrow.right.svg?react';
import MinusCircleFill from './assets/minus.circle.fill.svg?react';
import PlusCircleFill from './assets/plus.circle.fill.svg?react';
import FileNameEditor from './FileNameEditor';
import SaveButtonWithStatus from './SaveButtonWithStatus';
import './pdf-skeleton.css';
import { PDFDocument, rgb } from 'pdf-lib';
import { writeBinaryFile, readBinaryFile, exists } from '@tauri-apps/api/fs';
import { open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import PresetsEditor from './PresetsEditor';

// Set the workerSrc to the local bundled worker URL for pdf.js
GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();

const PREVIEW_WIDTH = 250;
const PREVIEW_HEIGHT = 200;
const MM_PER_POINT = 25.4 / 72;

const DEFAULT_PRESETS = [
  { name: 'A0', width: 841, height: 1189 },
  { name: 'A1', width: 594, height: 841 },
  { name: 'A2', width: 420, height: 594 },
  { name: 'A3', width: 297, height: 420 },
  { name: 'A4', width: 210, height: 297 },
  { name: 'A5', width: 148, height: 210 },
  { name: 'A6', width: 105, height: 148 },
];

// --- Filename token replacement ---
const SIZE_TOKEN = '*size*';
const YYMMDD_TOKEN = '*YYMMDD*';
const DDMMYY_TOKEN = '*DDMMYY*';

const PAPER_CODES_MM = [
  { code: 'A0', width: 841, height: 1189 },
  { code: 'A1', width: 594, height: 841 },
  { code: 'A2', width: 420, height: 594 },
  { code: 'A3', width: 297, height: 420 },
  { code: 'A4', width: 210, height: 297 },
  { code: 'A5', width: 148, height: 210 },
];

function getSizeCode(width: number, height: number, kind: 'pdf' | 'png' = 'pdf') {
  if (kind === 'png') return `${Math.round(width)}x${Math.round(height)}`;
  const orientation = width > height ? 'h' : 'v';
  const tolerance = 0.8;
  let best: { code: string; diff: number } | null = null;
  for (const p of PAPER_CODES_MM) {
    const d1 = Math.abs(width - p.width) + Math.abs(height - p.height);
    const d2 = Math.abs(width - p.height) + Math.abs(height - p.width);
    const diff = Math.min(d1, d2);
    if (diff <= tolerance && (!best || diff < best.diff)) {
      best = { code: p.code, diff };
    }
  }
  if (best) return `${best.code}${orientation}`;
  return `${Math.round(width)}x${Math.round(height)}`;
}

function replaceFilenameTokens(name: string, width: number, height: number, kind: 'pdf' | 'png' = 'pdf') {
  // Ensure tokens are surrounded by underscores if not already
  let result = name
    .replace(/\*size\*/g, '_*size*_')
    .replace(/\*YYMMDD\*/g, '_*YYMMDD*_')
    .replace(/\*DDMMYY\*/g, '_*DDMMYY*_');

  // Remove duplicate underscores from token insertion
  result = result.replace(/_+/g, '_');

  // Replace *size* with paper code (e.g. A3h/A4v) when recognized, otherwise fallback to 210x297
  result = result.replace(/_\*size\*_/g, `_${getSizeCode(width, height, kind)}_`);
  // Replace *YYMMDD* and *DDMMYY* with today's date
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  result = result.replace(/_\*YYMMDD\*_/g, `_${y}${m}${d}_`);
  result = result.replace(/_\*DDMMYY\*_/g, `_${d}${m}${y}_`);

  // Remove any double underscores
  result = result.replace(/_+/g, '_');
  // Remove underscores at the start or end
  result = result.replace(/^_+|_+$/g, '');

  return result;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatSizePoints(width: number, height: number): string {
  function fmt(val: number) {
    const rounded = Math.round(val * 10) / 10;
    return rounded
      .toFixed(1)
      .replace(/\.0$/, '')
      .replace('.', ',');
  }
  return `${fmt(width)} × ${fmt(height)} mm`;
}

function getTrimmedSize(pdfSize: { width: number; height: number } | null, trimMM: number = 0) {
  if (!pdfSize) return null;
  const trimmedWidth = Math.max(pdfSize.width - 2 * trimMM, 1);
  const trimmedHeight = Math.max(pdfSize.height - 2 * trimMM, 1);
  return { width: trimmedWidth, height: trimmedHeight };
}

function getDirectoryFromPath(filePath: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '';
  return normalized.slice(0, idx);
}

function getBaseNameFromPath(filePath: string): string {
  if (!filePath) return 'imported-file';
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'imported-file';
}

function applyCanvasPaddingMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  paddingXPerSide: number,
  paddingYPerSide: number = paddingXPerSide
) {
  if (paddingXPerSide <= 0 && paddingYPerSide <= 0) return;
  const px = Math.max(0, Math.min(paddingXPerSide, width / 2));
  const py = Math.max(0, Math.min(paddingYPerSide, height / 2));
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, py);
  ctx.fillRect(0, height - py, width, py);
  ctx.fillRect(0, py, px, Math.max(0, height - 2 * py));
  ctx.fillRect(width - px, py, px, Math.max(0, height - 2 * py));
}

function applyPdfPaddingMask(page: any, width: number, height: number, paddingPerSide: number) {
  if (paddingPerSide <= 0) return;
  const p = Math.max(0, Math.min(paddingPerSide, Math.min(width, height) / 2));
  const white = rgb(1, 1, 1);
  page.drawRectangle({ x: 0, y: 0, width, height: p, color: white });
  page.drawRectangle({ x: 0, y: height - p, width, height: p, color: white });
  page.drawRectangle({ x: 0, y: p, width: p, height: Math.max(0, height - 2 * p), color: white });
  page.drawRectangle({ x: width - p, y: p, width: p, height: Math.max(0, height - 2 * p), color: white });
}

interface Adjuster {
  id: string;
  kind: 'pdf' | 'png';
  mode: string;
  width: number;
  height: number;
  marginMm?: number;
  paddingMode?: 'inside' | 'outside';
  scaleFactor?: number;
  ppi?: number;
  pngSourceWidthMm?: number;
  pngSourceHeightMm?: number;
  pngLockField?: 'width' | 'height' | 'ppi';
  source: string;
}

interface ExportTask {
  id: string;
  kind: 'pdf' | 'png';
  adjuster: Adjuster;
  pages: number[];
  pageIdx?: number;
  outputBaseName: string;
  extension: 'pdf' | 'png';
}

type SourceKind = 'pdf' | 'image' | null;
const SUPPORTED_FORMATS_MESSAGE = 'Supported formats: .pdf, .ai, .png, .jpg/.jpeg and .heic/.heif';
const PDF_MAX_DIMENSION_POINTS = 14400;
const PDF_MIN_DIMENSION_POINTS = 1;
const POINTS_PER_MM = 1 / MM_PER_POINT;
const PDF_MAX_DIMENSION_MM = PDF_MAX_DIMENSION_POINTS * MM_PER_POINT;
const PDF_MIN_DIMENSION_MM = PDF_MIN_DIMENSION_POINTS * MM_PER_POINT;

function getPaddingLayoutMm(adjuster: Adjuster) {
  const setWidthMm = Math.max(1, Number(adjuster.width));
  const setHeightMm = Math.max(1, Number(adjuster.height));
  const paddingMm = Math.max(0, Number(adjuster.marginMm ?? 0));
  const paddingMode = adjuster.paddingMode === 'outside' ? 'outside' : 'inside';
  if (paddingMode === 'outside') {
    return {
      paddingMode,
      paddingMm,
      pageWidthMm: setWidthMm + 2 * paddingMm,
      pageHeightMm: setHeightMm + 2 * paddingMm,
      contentWidthMm: setWidthMm,
      contentHeightMm: setHeightMm,
      contentOffsetMm: paddingMm,
      maskPaddingMm: 0,
    } as const;
  }
  return {
    paddingMode,
    paddingMm,
    pageWidthMm: setWidthMm,
    pageHeightMm: setHeightMm,
    contentWidthMm: Math.max(setWidthMm - 2 * paddingMm, 1),
    contentHeightMm: Math.max(setHeightMm - 2 * paddingMm, 1),
    contentOffsetMm: paddingMm,
    maskPaddingMm: paddingMm,
  } as const;
}

function PDFDropZone() {
  const [file, setFile] = useState<File | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>(null);
  const [fileName, setFileName] = useState('');
  const [originalFileName, setOriginalFileName] = useState('');
  const [originalImportedName, setOriginalImportedName] = useState('');
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [pdfSize, setPdfSize] = useState<{ width: number; height: number } | null>(null);
  const [imageSizePx, setImageSizePx] = useState<{ width: number; height: number } | null>(null);
  const [trim, setTrim] = useState(0); // in mm
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [pageSelection, setPageSelection] = useState<'single' | 'all'>('single');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pdfDocRef = useRef<any>(null); // store loaded pdf.js doc

  const STORAGE_KEY_PRESETS = 'pdf_resizer_presets';
  const STORAGE_KEY_ADJUSTERS = 'pdf_resizer_adjusters';
  const SESSION_KEY_SCALE_FACTOR = 'pdf_resizer_scale_factor';

  const [sessionScaleFactor, setSessionScaleFactor] = useState<number>(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY_SCALE_FACTOR);
      if (!saved) return 1;
      const parsed = Number(saved);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    } catch {
      return 1;
    }
  });

  const [adjusters, setAdjusters] = useState<Adjuster[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ADJUSTERS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((adj: any) => ({
            ...adj,
            kind: adj?.kind === 'png' ? 'png' : 'pdf',
            mode: adj?.mode === 'fit'
              ? 'scale'
              : (adj?.mode || 'fill'),
            marginMm: adj?.kind === 'png' ? adj?.marginMm : Math.max(0, Number(adj?.marginMm ?? 0)),
            paddingMode: adj?.kind === 'png' ? adj?.paddingMode : ((adj?.paddingMode === 'outside') ? 'outside' : 'inside'),
            scaleFactor: adj?.kind === 'png' ? adj?.scaleFactor : Math.max(0.01, Number(adj?.scaleFactor ?? 1)),
            ppi: adj?.kind === 'png' ? Math.max(1, Number(adj?.ppi ?? 300)) : adj?.ppi,
            pngSourceWidthMm: adj?.kind === 'png'
              ? Number(adj?.pngSourceWidthMm ?? ((Number(adj?.width) / Math.max(1, Number(adj?.ppi ?? 300))) * 25.4))
              : adj?.pngSourceWidthMm,
            pngSourceHeightMm: adj?.kind === 'png'
              ? Number(adj?.pngSourceHeightMm ?? ((Number(adj?.height) / Math.max(1, Number(adj?.ppi ?? 300))) * 25.4))
              : adj?.pngSourceHeightMm,
            pngLockField: adj?.kind === 'png'
              ? ((adj?.pngLockField === 'width' || adj?.pngLockField === 'height' || adj?.pngLockField === 'ppi') ? adj.pngLockField : 'ppi')
              : adj?.pngLockField,
          }));
        }
      }
    } catch (e) {
      console.error('Failed to load adjusters', e);
    }
    return [{ id: crypto.randomUUID(), kind: 'pdf', mode: 'fill', width: 210, height: 297, marginMm: 0, paddingMode: 'inside', scaleFactor: 1, source: 'pdf' }];
  });
  const [trimInput, setTrimInput] = useState('0');
  const [isLoading, setIsLoading] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'conflict' | 'error'>(
    'idle'
  );
  const fadeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exportFolder, setExportFolder] = useState('');
  const [useSubfolder, setUseSubfolder] = useState(false);
  const [subfolderName, setSubfolderName] = useState('PDF');
  const [specifyExportLocation, setSpecifyExportLocation] = useState(false);
  const [showPopover, setShowPopover] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [unsupportedFormatMessage, setUnsupportedFormatMessage] = useState<string | null>(null);
  const [conflictFiles, setConflictFiles] = useState<Array<{ fileName: string; isConflict: boolean; shouldOverwrite: boolean; originalPath?: string; taskId?: string }>>([]);
  const [pendingExportTasks, setPendingExportTasks] = useState<ExportTask[]>([]);
  const [focusedAdjusterId, setFocusedAdjusterId] = useState<string | null>(null);
  const [cropOverlay, setCropOverlay] = useState<{ top: number; right: number; bottom: number; left: number } | null>(null);
  const [renderedPdfCssSize, setRenderedPdfCssSize] = useState<{ width: number; height: number } | null>(null);
  const [pdfRenderScale, setPdfRenderScale] = useState<number | null>(null);
  const [resultPreviewFrame, setResultPreviewFrame] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const resultPreviewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [presets, setPresets] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PRESETS);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load presets', e);
    }
    return DEFAULT_PRESETS;
  });
  const [showPresetsEditor, setShowPresetsEditor] = useState(false);
  const [newPresetState, setNewPresetState] = useState({ name: '', width: '', height: '' });
  const [flatten, setFlatten] = useState(false);
  const [ghostscriptAvailable, setGhostscriptAvailable] = useState(false);

  // Persistence effects
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(presets));
  }, [presets]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_ADJUSTERS, JSON.stringify(adjusters));
  }, [adjusters]);

  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_KEY_SCALE_FACTOR, String(sessionScaleFactor));
    } catch {
      // Ignore storage write issues (private mode / restricted envs).
    }
  }, [sessionScaleFactor]);

  // Detect Ghostscript availability (Tauri only)
  useEffect(() => {
    const checkGs = async () => {
      try {
        const isTauriEnv = typeof window !== 'undefined' && Boolean((window as any).__TAURI_IPC__);
        if (isTauriEnv) {
          const version: string = await invoke('check_ghostscript');
          setGhostscriptAvailable(Boolean(version));
        }
      } catch {
        setGhostscriptAvailable(false);
      }
    };
    checkGs();
  }, []);

  // Sync local state with trim
  useEffect(() => {
    setTrimInput(formatTrimInput(trim));
  }, [trim]);

  function formatTrim(val: number): string {
    if (!Number.isFinite(val)) return '';
    return val
      .toFixed(2)
      .replace('.', ',')
      .replace(/,00$/, '')
      .replace(/(,\d)0$/, '$1');
  }
  function formatTrimInput(val: string | number): string {
    if (typeof val === 'number') val = val.toString();
    val = val.replace('.', ',');
    const match = val.match(/^(\d+)([.,])?(\d{0,2})?$/);
    if (!match) return val;
    let result = match[1];
    if (typeof match[2] !== 'undefined') result += ',';
    if (typeof match[3] !== 'undefined') result += match[3];
    return result;
  }
  function parseTrimInput(val: string): number {
    return Number(val.replace(',', '.'));
  }

  const detectFileKind = (nameRaw: string, mimeRaw: string = ''): SourceKind => {
    const name = (nameRaw || '').toLowerCase();
    const mime = (mimeRaw || '').toLowerCase();
    if (
      mime === 'application/pdf' ||
      name.endsWith('.pdf') ||
      name.endsWith('.ai')
    ) {
      return 'pdf';
    }
    if (
      mime.startsWith('image/') ||
      name.endsWith('.heic') ||
      name.endsWith('.heif') ||
      name.endsWith('.avif') ||
      name.endsWith('.webp') ||
      name.endsWith('.jpg') ||
      name.endsWith('.jpeg') ||
      name.endsWith('.png') ||
      name.endsWith('.gif') ||
      name.endsWith('.bmp') ||
      name.endsWith('.tif') ||
      name.endsWith('.tiff')
    ) {
      return 'image';
    }
    return null;
  };

  const showUnsupportedFormatBanner = () => {
    setUnsupportedFormatMessage(SUPPORTED_FORMATS_MESSAGE);
    window.setTimeout(() => {
      setUnsupportedFormatMessage(current => (current === SUPPORTED_FORMATS_MESSAGE ? null : current));
    }, 3500);
  };

  const handleImportedFile = (nextFile: File, absolutePath?: string) => {
    setDragActive(false);
    const kind = detectFileKind(nextFile.name, nextFile.type);
    if (!kind) {
      showUnsupportedFormatBanner();
      return;
    }
    setSourceKind(kind);
    setFile(nextFile);
    setFileName(nextFile.name);
    setOriginalFileName(nextFile.name);
    setOriginalImportedName(nextFile.name);
    setFileSize(nextFile.size);
    setTrim(0);
    setCurrentPage(0);
    setTotalPages(1);
    setPdfSize(null);
    setImageSizePx(null);
    pdfDocRef.current = null;
    if (kind === 'image') {
      setAdjusters(adjs => {
        if (adjs.some(adj => adj.kind === 'png')) return adjs;
        return [
          ...adjs,
          {
            id: crypto.randomUUID(),
            kind: 'png',
            mode: 'fill',
            width: 2500,
            height: 2500,
            ppi: 300,
            source: 'png',
          },
        ];
      });
    }
    // Set export folder to imported file location (Tauri only, if available)
    const filePath = absolutePath || (nextFile as any).path;
    if (isTauri && filePath) {
      const folder = getDirectoryFromPath(String(filePath));
      if (folder) setExportFolder(folder);
    }
  };

  // Handle file selection
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const nextFile = files[0];
    handleImportedFile(nextFile);
  };

  const importFileByPath = async (absPath: string) => {
    const maybeKind = detectFileKind(getBaseNameFromPath(absPath));
    if (!maybeKind) {
      showUnsupportedFormatBanner();
      return;
    }
    const bytes = await readBinaryFile(absPath);
    const fileNameFromPath = getBaseNameFromPath(absPath);
    const imported = new File([bytes], fileNameFromPath);
    handleImportedFile(imported, absPath);
  };

  // Render PDF preview using pdf.js
  const renderPDFPreview = async (pdfFile: File, pageNum: number) => {
    setIsLoading(true);
    setRenderError(null);
    try {
      if (!canvasRef.current) return;
      const canvas = canvasRef.current;
      const dpr = window.devicePixelRatio || 1;
      const previewContainerWidth = PREVIEW_WIDTH;
      const previewContainerHeight = PREVIEW_HEIGHT;

      // Load the PDF only once
      let pdf = pdfDocRef.current;
      if (!pdf) {
        try {
          const arrayBuffer = await pdfFile.arrayBuffer();
          pdf = await getDocument({ data: arrayBuffer }).promise;
          pdfDocRef.current = pdf;
          setTotalPages(pdf.numPages);
        } catch (err) {
          console.error('Error loading PDF:', err);
          setRenderError('Failed to load PDF.');
          return;
        }
      }

      // Clamp pageNum and get page
      const pageIndex = Math.max(0, Math.min(pageNum, pdf.numPages - 1));
      let page;
      try {
        page = await pdf.getPage(pageIndex + 1);
      } catch (err) {
        console.error('Error loading PDF page:', err);
        setRenderError('Failed to load PDF page.');
        return;
      }

      // Use the page's rotation property for correct orientation
      const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
      setPdfSize({ width: viewport.width * MM_PER_POINT, height: viewport.height * MM_PER_POINT });

      // Calculate scale to fit the preview area
      const scale = Math.min(
        previewContainerWidth / viewport.width,
        previewContainerHeight / viewport.height
      );

      const scaledViewport = page.getViewport({ scale: scale * dpr, rotation: page.rotate });

      // Resize canvas to be the exact size of the scaled PDF
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      canvas.style.width = `${scaledViewport.width / dpr}px`;
      canvas.style.height = `${scaledViewport.height / dpr}px`;

      setRenderedPdfCssSize({ width: scaledViewport.width / dpr, height: scaledViewport.height / dpr });
      setPdfRenderScale(scale);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Render the page with a transparent background
      try {
        await page.render({
          canvasContext: ctx,
          viewport: scaledViewport,
          backgroundColor: 'rgba(0,0,0,0)',
        }).promise;
      } catch (err) {
        console.error('Error rendering PDF page:', err);
        setRenderError('Failed to render PDF page.');
        return;
      }
    } finally {
      setIsLoading(false);
    }
  };

  const renderImagePreview = async (imageFile: File) => {
    setIsLoading(true);
    setRenderError(null);
    try {
      if (!canvasRef.current) return;
      const canvas = canvasRef.current;
      const dpr = window.devicePixelRatio || 1;
      const previewContainerWidth = PREVIEW_WIDTH;
      const previewContainerHeight = PREVIEW_HEIGHT;

      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(imageFile);
      } catch {
        const objectUrl = URL.createObjectURL(imageFile);
        try {
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const node = new Image();
            node.onload = () => resolve(node);
            node.onerror = () => reject(new Error('Failed to decode image.'));
            node.src = objectUrl;
          });
          bitmap = await createImageBitmap(img);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }
      if (!bitmap) throw new Error('Failed to decode image.');

      setImageSizePx({ width: bitmap.width, height: bitmap.height });
      const scale = Math.min(previewContainerWidth / bitmap.width, previewContainerHeight / bitmap.height);
      const drawW = Math.max(1, Math.round(bitmap.width * scale));
      const drawH = Math.max(1, Math.round(bitmap.height * scale));
      canvas.width = Math.max(1, Math.round(drawW * dpr));
      canvas.height = Math.max(1, Math.round(drawH * dpr));
      canvas.style.width = `${drawW}px`;
      canvas.style.height = `${drawH}px`;
      setRenderedPdfCssSize({ width: drawW, height: drawH });
      setPdfRenderScale(null);

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to draw image preview.');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
    } catch (err) {
      console.error('Error loading image preview:', err);
      setRenderError('Failed to load image. HEIC/HEIF support depends on your OS/browser codecs.');
    } finally {
      setIsLoading(false);
    }
  };

  // Use effect to render preview when file, canvas, or currentPage are ready
  useEffect(() => {
    if (!file || !canvasRef.current || !sourceKind) return;
    if (sourceKind === 'pdf') {
      renderPDFPreview(file, currentPage);
    } else {
      renderImagePreview(file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, currentPage, sourceKind]);

  // --- Crop preview logic ---
  useEffect(() => {
    if (sourceKind !== 'pdf' || !file || !pdfSize || !canvasRef.current || !renderedPdfCssSize || pdfRenderScale === null) {
      setCropOverlay(null);
      return;
    }

    const trimPoints = trim * POINTS_PER_MM;

    // Calculate trim overlay based on the actual rendered PDF size
    let overlay = {
      top: trimPoints * pdfRenderScale,
      bottom: trimPoints * pdfRenderScale,
      left: trimPoints * pdfRenderScale,
      right: trimPoints * pdfRenderScale,
    };

    const focusedAdjuster =
      adjusters.find(adj => adj.id === focusedAdjusterId) ||
      adjusters.find(adj => adj.kind === 'pdf');
    if (focusedAdjuster && focusedAdjuster.kind === 'pdf' && focusedAdjuster.mode === 'fill') {
      const layoutMm = getPaddingLayoutMm(focusedAdjuster);
      const usableTargetWidth = layoutMm.contentWidthMm * POINTS_PER_MM;
      const usableTargetHeight = layoutMm.contentHeightMm * POINTS_PER_MM;

      // Calculate the scale needed to fill the target dimensions, considering the trimmed PDF size
      const effectivePdfWidth = Math.max(pdfSize.width * POINTS_PER_MM - 2 * trimPoints, 1);
      const effectivePdfHeight = Math.max(pdfSize.height * POINTS_PER_MM - 2 * trimPoints, 1);

      const fillScale = Math.max(usableTargetWidth / effectivePdfWidth, usableTargetHeight / effectivePdfHeight);

      // Calculate the excess area in PDF points that will be cropped by the fill operation
      const excessWidthPoints = (effectivePdfWidth * fillScale - usableTargetWidth) / 2;
      const excessHeightPoints = (effectivePdfHeight * fillScale - usableTargetHeight) / 2;

      // Add the excess cropping to the overlay, scaled to CSS pixels
      overlay.left += excessWidthPoints * pdfRenderScale;
      overlay.right += excessWidthPoints * pdfRenderScale;
      overlay.top += excessHeightPoints * pdfRenderScale;
      overlay.bottom += excessHeightPoints * pdfRenderScale;
    }

    setCropOverlay(overlay);

  }, [sourceKind, file, pdfSize, trim, adjusters, focusedAdjusterId, renderedPdfCssSize, pdfRenderScale]);

  useEffect(() => {
    if (!file || sourceKind !== 'pdf' || !renderedPdfCssSize || !canvasRef.current || !resultPreviewCanvasRef.current || !pdfSize || pdfRenderScale === null) {
      setResultPreviewFrame(null);
      return;
    }
    const focusedAdjuster =
      adjusters.find(adj => adj.id === focusedAdjusterId) ||
      adjusters.find(adj => adj.kind === 'pdf');
    if (!focusedAdjuster || focusedAdjuster.kind !== 'pdf') {
      setResultPreviewFrame(null);
      return;
    }
    const layoutMm = getPaddingLayoutMm(focusedAdjuster);
    const targetWmm = layoutMm.pageWidthMm;
    const targetHmm = layoutMm.pageHeightMm;
    // Use target page aspect ratio (same as export page) in preview container.
    const pageScale = Math.min(PREVIEW_WIDTH / targetWmm, PREVIEW_HEIGHT / targetHmm);
    const frameWidthCss = Math.max(1, targetWmm * pageScale);
    const frameHeightCss = Math.max(1, targetHmm * pageScale);
    const frameLeftCss = (PREVIEW_WIDTH - frameWidthCss) / 2;
    const frameTopCss = (PREVIEW_HEIGHT - frameHeightCss) / 2;
    setResultPreviewFrame({
      top: frameTopCss,
      left: frameLeftCss,
      width: frameWidthCss,
      height: frameHeightCss,
    });

    let cancelled = false;
    (async () => {
      try {
        const previewBytes = await renderPngBytes(
          file,
          {
            ...focusedAdjuster,
            width: Math.max(1, Number(focusedAdjuster.width)),
            height: Math.max(1, Number(focusedAdjuster.height)),
          },
          currentPage,
          trim
        );
        if (cancelled || !resultPreviewCanvasRef.current) return;
        const blob = new Blob([previewBytes], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        if (cancelled || !resultPreviewCanvasRef.current) {
          bitmap.close();
          return;
        }
        const out = resultPreviewCanvasRef.current;
        out.width = Math.max(1, Math.round(frameWidthCss));
        out.height = Math.max(1, Math.round(frameHeightCss));
        const ctx = out.getContext('2d');
        if (!ctx) {
          bitmap.close();
          return;
        }
        ctx.clearRect(0, 0, out.width, out.height);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, out.width, out.height);
        bitmap.close();
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to render result preview simulation', err);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, sourceKind, adjusters, focusedAdjusterId, renderedPdfCssSize, currentPage, trim, pdfSize, pdfRenderScale]);

  // Redraw PDF preview on theme change
  useEffect(() => {
    if (!file || sourceKind !== 'pdf') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      renderPDFPreview(file, currentPage);
    };
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  }, [file, currentPage, sourceKind]);

  // Calculate trimmed size for aspect ratio (avoid redeclaration)
  const trimmedForAspect = sourceKind === 'pdf' && trim > 0 && pdfSize ? getTrimmedSize(pdfSize, trim) : pdfSize;
  const sourceAspectFromPdf = trimmedForAspect ? trimmedForAspect.width / trimmedForAspect.height : null;
  const sourceAspectFromImage = imageSizePx && imageSizePx.height > 0 ? imageSizePx.width / imageSizePx.height : null;
  const aspectRatio = sourceAspectFromPdf || sourceAspectFromImage || 1;
  const getPdfAdjusters = (adjs: Adjuster[]) => adjs.filter(adj => adj.kind === 'pdf');
  const getFirstPdfAdjusterIndex = (adjs: Adjuster[]) => adjs.findIndex(adj => adj.kind === 'pdf');

  const makeDefaultPngAdjuster = (): Adjuster => {
    const sourceWidthMm = sourceKind === 'pdf'
      ? pdfSize?.width
      : (imageSizePx ? (imageSizePx.width / 300) * 25.4 : undefined);
    const sourceHeightMm = sourceKind === 'pdf'
      ? pdfSize?.height
      : (imageSizePx ? (imageSizePx.height / 300) * 25.4 : undefined);
    const ratio = sourceWidthMm && sourceHeightMm && sourceHeightMm > 0
      ? sourceWidthMm / sourceHeightMm
      : (Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1);
    let widthPx = 2500;
    let heightPx = 2500;
    if (ratio >= 1) {
      widthPx = Math.round(2500 * ratio);
      heightPx = 2500;
    } else {
      widthPx = 2500;
      heightPx = Math.round(2500 / ratio);
    }
    const sourceSmallSideMm = sourceWidthMm && sourceHeightMm ? Math.min(sourceWidthMm, sourceHeightMm) : null;
    const defaultPpi = sourceSmallSideMm
      ? Math.max(1, Number((2500 / (sourceSmallSideMm / 25.4)).toFixed(2)))
      : 300;
    return {
      id: crypto.randomUUID(),
      kind: 'png',
      mode: 'fill',
      width: widthPx,
      height: heightPx,
      ppi: defaultPpi,
      pngSourceWidthMm: sourceWidthMm || undefined,
      pngSourceHeightMm: sourceHeightMm || undefined,
      pngLockField: 'ppi',
      source: 'png',
    };
  };

  // Drag and drop handlers
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (isTauri) return;
    handleFiles(e.dataTransfer.files);
  };
  const onClick = async () => {
    if (isTauri) {
      try {
        const selected = await open({
          multiple: false,
          title: 'Select PDF or image',
          filters: [
            { name: 'PDF, AI and Images', extensions: ['pdf', 'ai', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'heif'] },
          ],
        });
        if (!selected || typeof selected !== 'string') return;
        await importFileByPath(selected);
        return;
      } catch (err) {
        console.error('Tauri file import failed, falling back to input picker.', err);
      }
    }
    inputRef.current?.click();
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
  };

  useEffect(() => {
    const hasSourceSize =
      (sourceKind === 'pdf' && pdfSize) ||
      (sourceKind === 'image' && imageSizePx);
    if (hasSourceSize && file) {
      setAdjusters(adjs => {
        const effectivePdfWidth = sourceKind === 'pdf'
          ? Math.max((pdfSize as { width: number; height: number }).width - 2 * trim, 1)
          : 0;
        const effectivePdfHeight = sourceKind === 'pdf'
          ? Math.max((pdfSize as { width: number; height: number }).height - 2 * trim, 1)
          : 0;
        const sourceWidthMm = sourceKind === 'pdf'
          ? Number(effectivePdfWidth.toFixed(2))
          : Number((((imageSizePx as { width: number; height: number }).width / 300) * 25.4).toFixed(2));
        const sourceHeightMm = sourceKind === 'pdf'
          ? Number(effectivePdfHeight.toFixed(2))
          : Number((((imageSizePx as { width: number; height: number }).height / 300) * 25.4).toFixed(2));
        let changed = false;
        let next = adjs;

        if (sourceKind === 'pdf') {
          const pdfIndices = adjs
            .map((adj, idx) => ({ adj, idx }))
            .filter(({ adj }) => adj.kind === 'pdf')
            .map(({ idx }) => idx);

          if (pdfIndices.length === 1) {
            const idx = pdfIndices[0];
            if (adjs[idx].source === 'pdf' || adjs[idx].source === 'trimmed') {
              next = next.map((adj, i) => (
                i === idx
                  ? {
                      ...adj,
                      width: sourceWidthMm,
                      height: sourceHeightMm,
                      source: trim > 0 ? 'trimmed' : 'pdf',
                    }
                  : adj
              ));
              changed = true;
            }
          }
        }

        next = next.map(adj => {
          if (adj.kind !== 'pdf') return adj;
          const normalizedMode = adj.mode === 'fit' ? 'scale' : (adj.mode || 'fill');
          const normalizedMargin = Math.max(0, Number(adj.marginMm ?? 0));
          const normalizedPaddingMode = adj.paddingMode === 'outside' ? 'outside' : 'inside';
          const normalizedScale = Math.max(0.01, Number(adj.scaleFactor ?? sessionScaleFactor ?? 1));
          const shouldApplyScale = sourceKind === 'pdf' && normalizedMode === 'scale';
          const scaledWidth = shouldApplyScale ? Number((sourceWidthMm * normalizedScale).toFixed(2)) : adj.width;
          const scaledHeight = shouldApplyScale ? Number((sourceHeightMm * normalizedScale).toFixed(2)) : adj.height;
          const hasDiff =
            adj.mode !== normalizedMode ||
            Number(adj.marginMm ?? 0) !== normalizedMargin ||
            (adj.paddingMode === 'outside' ? 'outside' : 'inside') !== normalizedPaddingMode ||
            Number(adj.scaleFactor ?? 0) !== normalizedScale ||
            adj.width !== scaledWidth ||
            adj.height !== scaledHeight;
          if (hasDiff) changed = true;
          return hasDiff
            ? {
                ...adj,
                mode: normalizedMode,
                marginMm: normalizedMargin,
                paddingMode: normalizedPaddingMode,
                scaleFactor: normalizedScale,
                width: scaledWidth,
                height: scaledHeight,
              }
            : adj;
        });

        next = next.map(adj => {
          if (adj.kind !== 'png') return adj;
          const lockField = (adj.pngLockField === 'width' || adj.pngLockField === 'height' || adj.pngLockField === 'ppi')
            ? adj.pngLockField
            : 'ppi';
          const sourceWidthIn = Math.max(1e-6, sourceWidthMm / 25.4);
          const sourceHeightIn = Math.max(1e-6, sourceHeightMm / 25.4);
          let nextPpi = Math.max(1, Number(adj.ppi ?? 300));
          let widthPx = Math.max(1, Math.round(sourceWidthIn * nextPpi));
          let heightPx = Math.max(1, Math.round(sourceHeightIn * nextPpi));

          if (lockField === 'width') {
            widthPx = Math.max(1, Math.round(Number(adj.width) || 1));
            nextPpi = Math.max(1, Number((widthPx / sourceWidthIn).toFixed(2)));
            heightPx = Math.max(1, Math.round(sourceHeightIn * nextPpi));
          } else if (lockField === 'height') {
            heightPx = Math.max(1, Math.round(Number(adj.height) || 1));
            nextPpi = Math.max(1, Number((heightPx / sourceHeightIn).toFixed(2)));
            widthPx = Math.max(1, Math.round(sourceWidthIn * nextPpi));
          } else {
            nextPpi = Math.max(1, Number((Number(adj.ppi ?? 300)).toFixed(2)));
            widthPx = Math.max(1, Math.round(sourceWidthIn * nextPpi));
            heightPx = Math.max(1, Math.round(sourceHeightIn * nextPpi));
          }

          const hasDiff =
            adj.width !== widthPx ||
            adj.height !== heightPx ||
            Number(adj.ppi ?? 0) !== nextPpi ||
            (adj.pngLockField || 'ppi') !== lockField ||
            Number(adj.pngSourceWidthMm ?? 0) !== sourceWidthMm ||
            Number(adj.pngSourceHeightMm ?? 0) !== sourceHeightMm;
          if (hasDiff) changed = true;
          return hasDiff
            ? {
                ...adj,
                width: widthPx,
                height: heightPx,
                ppi: nextPpi,
                pngLockField: lockField,
                pngSourceWidthMm: sourceWidthMm,
                pngSourceHeightMm: sourceHeightMm,
              }
            : adj;
        });

        return changed ? next : adjs;
      });
    }
  }, [sourceKind, pdfSize, imageSizePx, trim, file]);

  // Add handlers above the return statement
  const handleSetToPdfDimensions = () => {
    if (!pdfSize) return;
    setAdjusters(adjs => {
      const idx = getFirstPdfAdjusterIndex(adjs);
      if (idx < 0) return adjs;
      return adjs.map((adj, i) => (
        i === idx
          ? {
              ...adj,
              width: Number(pdfSize.width.toFixed(2)),
              height: Number(pdfSize.height.toFixed(2)),
              ...(adj.mode === 'scale' ? { scaleFactor: 1 } : {}),
              source: 'pdf',
            }
          : adj
      ));
    });
  };
  const handleSetToTrimmedDimensions = () => {
    if (!pdfSize) return;
    const trimmedWidth = Math.max(pdfSize.width - 2 * trim, 1);
    const trimmedHeight = Math.max(pdfSize.height - 2 * trim, 1);
    setAdjusters(adjs => {
      const idx = getFirstPdfAdjusterIndex(adjs);
      if (idx < 0) return adjs;
      return adjs.map((adj, i) => (
        i === idx
          ? {
              ...adj,
              width: Number(trimmedWidth.toFixed(2)),
              height: Number(trimmedHeight.toFixed(2)),
              source: 'manual',
            }
          : adj
      ));
    });
  };

  const applyTrimLive = (rawTrim: number) => {
    const nextTrim = Number.isFinite(rawTrim) ? Math.max(rawTrim, 0) : 0;
    setTrim(nextTrim);
    const firstPdfAdjuster = adjusters.find(adj => adj.kind === 'pdf');
    if (pdfSize && firstPdfAdjuster && (firstPdfAdjuster.source === 'pdf' || firstPdfAdjuster.source === 'trimmed')) {
      const trimmedWidth = Math.max(pdfSize.width - 2 * nextTrim, 1);
      const trimmedHeight = Math.max(pdfSize.height - 2 * nextTrim, 1);
      setAdjusters(adjs => {
        const idx = getFirstPdfAdjusterIndex(adjs);
        if (idx < 0) return adjs;
        return adjs.map((adj, i) => (
          i === idx
            ? {
                ...adj,
                width: Number(trimmedWidth.toFixed(2)),
                height: Number(trimmedHeight.toFixed(2)),
                source: nextTrim > 0 ? 'trimmed' : 'pdf',
              }
            : adj
        ));
      });
    }
  };

  // Global drag and drop prevention
  useEffect(() => {
    const preventDefaults = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('dragover', preventDefaults, false);
    window.addEventListener('drop', preventDefaults, false);
    return () => {
      window.removeEventListener('dragover', preventDefaults, false);
      window.removeEventListener('drop', preventDefaults, false);
    };
  }, []);

  // Keep fit/scale outputs in sync with source size changes (e.g., trim changes).
  useEffect(() => {
    if (sourceKind !== 'pdf' || !pdfSize) return;
    const sourceWidth = Math.max(pdfSize.width - 2 * trim, 1);
    const sourceHeight = Math.max(pdfSize.height - 2 * trim, 1);
    setAdjusters(adjs => adjs.map(adj => {
      if (adj.kind === 'png') return adj;
      if (adj.mode === 'scale') {
        const nextScale = Math.max(0.01, Number(adj.scaleFactor ?? sessionScaleFactor ?? 1));
        return {
          ...adj,
          scaleFactor: nextScale,
          width: Number((sourceWidth * nextScale).toFixed(2)),
          height: Number((sourceHeight * nextScale).toFixed(2)),
        };
      }
      if (adj.mode === 'fitHeight' && sourceWidth > 0) {
        const lockedWidth = Math.max(1, Number(adj.width));
        return {
          ...adj,
          width: lockedWidth,
          height: Number((lockedWidth * (sourceHeight / sourceWidth)).toFixed(2)),
        };
      }
      if (adj.mode === 'fitWidth' && sourceHeight > 0) {
        const lockedHeight = Math.max(1, Number(adj.height));
        return {
          ...adj,
          height: lockedHeight,
          width: Number((lockedHeight * (sourceWidth / sourceHeight)).toFixed(2)),
        };
      }
      return adj;
    }));
  }, [sourceKind, pdfSize, trim, sessionScaleFactor]);

  // When a new file is loaded, set the filename and original filename
  useEffect(() => {
    if (file) {
      const base = file.name.replace(/\.[^.]+$/, '');
      setFileName(base);
      setOriginalFileName(base);
      // Default export folder to the imported PDF's location (Tauri only)
      // (Moved to handleFiles)
    } else {
      setFileName('');
      setOriginalFileName('');
      setOriginalImportedName('');
    }
  }, [file]);

  // Reset status to idle on new file
  useEffect(() => {
    setSaveStatus('idle');
    if (fadeTimeout.current) clearTimeout(fadeTimeout.current);
  }, [file]);

  // If conflict is resolved (filename changed from 'conflict'), fade to idle
  // This useEffect is no longer needed as the popover is dismissed by user action.
  // Keeping it commented out for reference if needed in the future.
  /*
  useEffect(() => {
    if (saveStatus === 'conflict' && fileName.trim().toLowerCase() !== 'conflict') {
      fadeTimeout.current = setTimeout(() => setSaveStatus('idle'), 1200);
    }
  }, [fileName, saveStatus]);
  */

  // If error, reset to idle on new save attempt or new file
  useEffect(() => {
    if (saveStatus === 'error') {
      const reset = () => setSaveStatus('idle');
      return () => reset();
    }
  }, [file, fileName]);

  // Reset saveStatus on export location change
  useEffect(() => {
    if (saveStatus !== 'idle') setSaveStatus('idle');
    // eslint-disable-next-line
  }, [exportFolder, useSubfolder, subfolderName]);

  // Folder picker handler (uses input type="file" with webkitdirectory for now)
  const folderInputRef = useRef<HTMLInputElement>(null);
  const handleFolderPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // Use the parent directory of the first file as the folder
      const path = files[0].webkitRelativePath.split('/')[0];
      setExportFolder(path);
    }
  };

  const handlePickFolder = async () => {
    // @ts-ignore
    if (window && window.__TAURI_IPC__) {
      // Running in Tauri
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select export folder',
      });
      if (typeof selected === 'string') {
        setExportFolder(selected);
      }
    } else if ('showDirectoryPicker' in window) {
      // Web: Use File System Access API
      try {
        // @ts-ignore
        const handle = await window.showDirectoryPicker();
        setExportDirHandle(handle);
        setExportFolder(handle.name);
      } catch (err) {
        // User cancelled or error
        console.log('Directory picker cancelled or failed', err);
      }
    } else {
      // Fallback for web: trigger the hidden file input
      folderInputRef.current?.click();
    }
  };

  // Helper to detect Tauri
  const isTauri = typeof window !== 'undefined' && Boolean((window as any).__TAURI_IPC__);
  const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);
  const isFileSystemAccessSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const isExportDirSupported = isTauri || isFileSystemAccessSupported;

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let unlistenFileDrop: (() => void) | null = null;
    let unlistenFileDropHover: (() => void) | null = null;
    let unlistenFileDropCancelled: (() => void) | null = null;
    (async () => {
      try {
        const pendingPaths = await invoke<string[]>('take_pending_open_paths');
        for (const absPath of pendingPaths || []) {
          try {
            await importFileByPath(absPath);
          } catch (e) {
            console.error('Failed to import pending path', absPath, e);
          }
        }
      } catch (e) {
        console.error('Failed to fetch pending open paths', e);
      }
      try {
        unlisten = await listen<string[]>('external-files-opened', async (event) => {
          const paths = Array.isArray(event.payload) ? event.payload : [];
          for (const absPath of paths) {
            try {
              await importFileByPath(absPath);
            } catch (e) {
              console.error('Failed to import opened path', absPath, e);
            }
          }
        });
      } catch (e) {
        console.error('Failed to subscribe to external-files-opened', e);
      }
      try {
        unlistenFileDrop = await listen<string[]>('tauri://file-drop', async (event) => {
          setDragActive(false);
          const paths = Array.isArray(event.payload) ? event.payload : [];
          if (paths.length === 0) return;
          const firstPath = String(paths[0]);
          try {
            await importFileByPath(firstPath);
          } catch (e) {
            console.error('Failed to import dropped path', firstPath, e);
          }
        });
      } catch (e) {
        console.error('Failed to subscribe to tauri://file-drop', e);
      }
      try {
        unlistenFileDropHover = await listen('tauri://file-drop-hover', () => {
          setDragActive(true);
        });
      } catch (e) {
        console.error('Failed to subscribe to tauri://file-drop-hover', e);
      }
      try {
        unlistenFileDropCancelled = await listen('tauri://file-drop-cancelled', () => {
          setDragActive(false);
        });
      } catch (e) {
        console.error('Failed to subscribe to tauri://file-drop-cancelled', e);
      }
    })();
    return () => {
      if (unlisten) unlisten();
      if (unlistenFileDrop) unlistenFileDrop();
      if (unlistenFileDropHover) unlistenFileDropHover();
      if (unlistenFileDropCancelled) unlistenFileDropCancelled();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTauri]);

  const [exportDirHandle, setExportDirHandle] = useState<any>(null);

  const buildExportTasks = (adjs: Adjuster[], pagesToProcess: number[], baseFileName: string): ExportTask[] => {
    const tasks: ExportTask[] = [];
    const safeBase = baseFileName.trim() ? baseFileName.trim() : 'output';
    for (const adj of adjs) {
      const processedFileName = replaceFilenameTokens(safeBase, adj.width, adj.height, adj.kind);
      if (adj.kind === 'pdf') {
        tasks.push({
          id: crypto.randomUUID(),
          kind: 'pdf',
          adjuster: adj,
          pages: pagesToProcess,
          outputBaseName: processedFileName,
          extension: 'pdf',
        });
      } else {
        for (const pageIdx of pagesToProcess) {
          tasks.push({
            id: crypto.randomUUID(),
            kind: 'png',
            adjuster: adj,
            pages: [pageIdx],
            pageIdx,
            outputBaseName: pagesToProcess.length > 1 ? `${processedFileName}_p${pageIdx + 1}` : processedFileName,
            extension: 'png',
          });
        }
      }
    }
    return tasks;
  };

  const writeExportFile = async (folder: string, fileNameWithExt: string, bytes: Uint8Array, mimeType: string, dirHandle?: any) => {
    if (isTauri) {
      const savePath = folder.replace(/\/+$/, '') + '/' + fileNameWithExt;
      await writeBinaryFile({ path: savePath, contents: bytes });
      return;
    }
    if (dirHandle) {
      let targetHandle = dirHandle;
      if (useSubfolder && subfolderName.trim()) {
        targetHandle = await dirHandle.getDirectoryHandle(subfolderName.trim(), { create: true });
      }
      const fileHandle = await targetHandle.getFileHandle(fileNameWithExt, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return;
    }
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameWithExt;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 5000);
  };

  const renderPngBytes = async (fileToSave: File, adj: Adjuster, pageIdx: number, currentTrim: number) => {
    if (sourceKind === 'image') {
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(fileToSave);
      } catch {
        const objectUrl = URL.createObjectURL(fileToSave);
        try {
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const node = new Image();
            node.onload = () => resolve(node);
            node.onerror = () => reject(new Error('Failed to decode image for export.'));
            node.src = objectUrl;
          });
          bitmap = await createImageBitmap(img);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }
      if (!bitmap) throw new Error('Failed to decode image for export.');

      const srcWidth = bitmap.width;
      const srcHeight = bitmap.height;
      const layoutMm = getPaddingLayoutMm(adj);
      const targetWidth = Math.max(1, Math.round(layoutMm.pageWidthMm));
      const targetHeight = Math.max(1, Math.round(layoutMm.pageHeightMm));
      const contentOffsetPx = Math.max(0, Math.round(layoutMm.contentOffsetMm));
      const usableTargetWidth = Math.max(1, Math.round(layoutMm.contentWidthMm));
      const usableTargetHeight = Math.max(1, Math.round(layoutMm.contentHeightMm));
      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = targetWidth;
      outputCanvas.height = targetHeight;
      const outCtx = outputCanvas.getContext('2d');
      if (!outCtx) throw new Error('Failed to create PNG output context.');
      outCtx.fillStyle = '#fff';
      outCtx.fillRect(0, 0, targetWidth, targetHeight);
      outCtx.imageSmoothingEnabled = true;
      outCtx.imageSmoothingQuality = 'high';

      if (adj.mode === 'fill') {
        const scale = Math.max(usableTargetWidth / srcWidth, usableTargetHeight / srcHeight);
        const drawW = srcWidth * scale;
        const drawH = srcHeight * scale;
        const offsetX = contentOffsetPx + (usableTargetWidth - drawW) / 2;
        const offsetY = contentOffsetPx + (usableTargetHeight - drawH) / 2;
        outCtx.drawImage(bitmap, offsetX, offsetY, drawW, drawH);
      } else if (adj.mode === 'scale') {
        const scale = Math.min(usableTargetWidth / srcWidth, usableTargetHeight / srcHeight);
        const drawW = srcWidth * scale;
        const drawH = srcHeight * scale;
        const offsetX = contentOffsetPx + (usableTargetWidth - drawW) / 2;
        const offsetY = contentOffsetPx + (usableTargetHeight - drawH) / 2;
        outCtx.drawImage(bitmap, offsetX, offsetY, drawW, drawH);
      } else {
        outCtx.drawImage(bitmap, contentOffsetPx, contentOffsetPx, usableTargetWidth, usableTargetHeight);
      }
      if (layoutMm.maskPaddingMm > 0) {
        applyCanvasPaddingMask(outCtx, targetWidth, targetHeight, Math.round(layoutMm.maskPaddingMm), Math.round(layoutMm.maskPaddingMm));
      }
      bitmap.close();
      const blob = await new Promise<Blob | null>(resolve => outputCanvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Failed to encode PNG image.');
      const pngBuffer = await blob.arrayBuffer();
      return new Uint8Array(pngBuffer);
    }

    let pdf = pdfDocRef.current;
    if (!pdf) {
      const arrayBuffer = await fileToSave.arrayBuffer();
      pdf = await getDocument({ data: arrayBuffer }).promise;
      pdfDocRef.current = pdf;
    }
    const page = await pdf.getPage(pageIdx + 1);
    const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
    const POINTS_PER_MM = 1 / MM_PER_POINT;
    const trimPoints = currentTrim > 0 ? currentTrim * POINTS_PER_MM : 0;

    const cropX = trimPoints;
    const cropY = trimPoints;
    const cropWidth = Math.max(viewport.width - 2 * trimPoints, 1);
    const cropHeight = Math.max(viewport.height - 2 * trimPoints, 1);

    const layoutMm = getPaddingLayoutMm(adj);
    const targetWidth = Math.max(1, Math.round(layoutMm.pageWidthMm));
    const targetHeight = Math.max(1, Math.round(layoutMm.pageHeightMm));
    const contentOffsetPx = Math.max(0, Math.round(layoutMm.contentOffsetMm));
    const usableTargetWidth = Math.max(1, Math.round(layoutMm.contentWidthMm));
    const usableTargetHeight = Math.max(1, Math.round(layoutMm.contentHeightMm));
    const fillScale = Math.max(usableTargetWidth / cropWidth, usableTargetHeight / cropHeight);
    const fitScale = Math.min(usableTargetWidth / cropWidth, usableTargetHeight / cropHeight);
    const renderScale = adj.mode === 'scale' ? fitScale : fillScale;

    const renderViewport = page.getViewport({ scale: renderScale, rotation: page.rotate });
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.max(1, Math.ceil(renderViewport.width));
    tempCanvas.height = Math.max(1, Math.ceil(renderViewport.height));
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) throw new Error('Failed to create PNG render context.');

    await page.render({
      canvasContext: tempCtx,
      viewport: renderViewport,
      backgroundColor: 'rgba(255,255,255,1)',
    }).promise;

    const srcX = cropX * renderScale;
    const srcY = tempCanvas.height - (cropY + cropHeight) * renderScale;
    const srcW = cropWidth * renderScale;
    const srcH = cropHeight * renderScale;

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = targetWidth;
    outputCanvas.height = targetHeight;
    const outCtx = outputCanvas.getContext('2d');
    if (!outCtx) throw new Error('Failed to create PNG output context.');

    outCtx.clearRect(0, 0, targetWidth, targetHeight);
    outCtx.fillStyle = '#fff';
    outCtx.fillRect(0, 0, targetWidth, targetHeight);
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';

    if (adj.mode === 'fill') {
      const drawW = srcW;
      const drawH = srcH;
      const offsetX = contentOffsetPx + (usableTargetWidth - drawW) / 2;
      const offsetY = contentOffsetPx + (usableTargetHeight - drawH) / 2;
      outCtx.drawImage(tempCanvas, srcX, srcY, srcW, srcH, offsetX, offsetY, drawW, drawH);
    } else if (adj.mode === 'scale') {
      const drawW = srcW;
      const drawH = srcH;
      const offsetX = contentOffsetPx + (usableTargetWidth - drawW) / 2;
      const offsetY = contentOffsetPx + (usableTargetHeight - drawH) / 2;
      outCtx.drawImage(tempCanvas, srcX, srcY, srcW, srcH, offsetX, offsetY, drawW, drawH);
    } else {
      outCtx.drawImage(tempCanvas, srcX, srcY, srcW, srcH, contentOffsetPx, contentOffsetPx, usableTargetWidth, usableTargetHeight);
    }
    if (layoutMm.maskPaddingMm > 0) {
      applyCanvasPaddingMask(outCtx, targetWidth, targetHeight, Math.round(layoutMm.maskPaddingMm), Math.round(layoutMm.maskPaddingMm));
    }

    const blob = await new Promise<Blob | null>(resolve => outputCanvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Failed to encode PNG image.');
    const pngBuffer = await blob.arrayBuffer();
    return new Uint8Array(pngBuffer);
  };

  const runExportTasks = async (folder: string, tasks: ExportTask[], fileToSave: File, currentTrim: number, dirHandle?: any) => {
    let processedPdfBuffer: ArrayBuffer | null = null;
    const needsPdf = tasks.some(t => t.kind === 'pdf');
    let imageSourcePngBytes: Uint8Array | null = null;
    let imageSourceSize: { width: number; height: number } | null = null;
    if (needsPdf) {
      if (sourceKind === 'pdf') {
        processedPdfBuffer = await fileToSave.arrayBuffer();
        if (flatten && isTauri) {
          try {
            const flattenedBytes: number[] = await invoke('flatten_pdf', {
              pdfBytes: Array.from(new Uint8Array(processedPdfBuffer)),
            });
            processedPdfBuffer = new Uint8Array(flattenedBytes).buffer;
          } catch (e: any) {
            throw new Error(`Flatten failed: ${e}`);
          }
        }
      } else if (sourceKind === 'image') {
        let bitmap: ImageBitmap | null = null;
        try {
          bitmap = await createImageBitmap(fileToSave);
        } catch {
          const objectUrl = URL.createObjectURL(fileToSave);
          try {
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
              const node = new Image();
              node.onload = () => resolve(node);
              node.onerror = () => reject(new Error('Failed to decode image for PDF export.'));
              node.src = objectUrl;
            });
            bitmap = await createImageBitmap(img);
          } finally {
            URL.revokeObjectURL(objectUrl);
          }
        }
        if (!bitmap) throw new Error('Failed to decode image for PDF export.');
        imageSourceSize = { width: bitmap.width, height: bitmap.height };
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to prepare image for PDF export.');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Failed to encode image for PDF export.');
        imageSourcePngBytes = new Uint8Array(await blob.arrayBuffer());
      }
    }

    for (const task of tasks) {
      const fileNameWithExt = `${task.outputBaseName}.${task.extension}`;
      if (task.kind === 'pdf') {
        const newPdf = await PDFDocument.create();
        if (sourceKind === 'pdf') {
          if (!processedPdfBuffer) throw new Error('PDF source buffer missing.');
          const pdfDoc = await PDFDocument.load(processedPdfBuffer);
          for (const pageIdx of task.pages) {
            const srcPage = pdfDoc.getPage(pageIdx);
            const { width: srcWidth, height: srcHeight } = srcPage.getSize();
            let cropX = 0, cropY = 0, cropWidth = srcWidth, cropHeight = srcHeight;
            if (currentTrim > 0) {
              const POINTS_PER_MM = 1 / MM_PER_POINT;
              const trimPoints = currentTrim * POINTS_PER_MM;
              cropX = trimPoints;
              cropY = trimPoints;
              cropWidth = Math.max(srcWidth - 2 * trimPoints, 1);
              cropHeight = Math.max(srcHeight - 2 * trimPoints, 1);
            }
            const POINTS_PER_MM = 1 / MM_PER_POINT;
            const layoutMm = getPaddingLayoutMm(task.adjuster);
            const targetWidth = layoutMm.pageWidthMm * POINTS_PER_MM;
            const targetHeight = layoutMm.pageHeightMm * POINTS_PER_MM;
            const contentOffsetPoints = layoutMm.contentOffsetMm * POINTS_PER_MM;
            const usableTargetWidth = Math.max(layoutMm.contentWidthMm * POINTS_PER_MM, 1);
            const usableTargetHeight = Math.max(layoutMm.contentHeightMm * POINTS_PER_MM, 1);
            const [embeddedPage] = await newPdf.embedPages([srcPage], [
              { left: cropX, bottom: cropY, right: cropX + cropWidth, top: cropY + cropHeight },
            ]);
            let scaleX = 1;
            let scaleY = 1;
            let offsetX = contentOffsetPoints;
            let offsetY = contentOffsetPoints;
            if (task.adjuster.mode === 'fill') {
              const scale = Math.max(usableTargetWidth / cropWidth, usableTargetHeight / cropHeight);
              scaleX = scale;
              scaleY = scale;
              offsetX = contentOffsetPoints + (usableTargetWidth - cropWidth * scale) / 2;
              offsetY = contentOffsetPoints + (usableTargetHeight - cropHeight * scale) / 2;
            } else if (task.adjuster.mode === 'scale') {
              const scale = Math.min(usableTargetWidth / cropWidth, usableTargetHeight / cropHeight);
              scaleX = scale;
              scaleY = scale;
              offsetX = contentOffsetPoints + (usableTargetWidth - cropWidth * scale) / 2;
              offsetY = contentOffsetPoints + (usableTargetHeight - cropHeight * scale) / 2;
            } else {
              scaleX = usableTargetWidth / cropWidth;
              scaleY = usableTargetHeight / cropHeight;
            }
            const newPage = newPdf.addPage([targetWidth, targetHeight]);
            newPage.drawPage(embeddedPage, { x: offsetX, y: offsetY, xScale: scaleX, yScale: scaleY });
            if (layoutMm.maskPaddingMm > 0) {
              applyPdfPaddingMask(newPage, targetWidth, targetHeight, layoutMm.maskPaddingMm * POINTS_PER_MM);
            }
          }
        } else if (sourceKind === 'image') {
          if (!imageSourcePngBytes || !imageSourceSize) throw new Error('Image source buffer missing.');
          const POINTS_PER_MM = 1 / MM_PER_POINT;
          const layoutMm = getPaddingLayoutMm(task.adjuster);
          const targetWidth = layoutMm.pageWidthMm * POINTS_PER_MM;
          const targetHeight = layoutMm.pageHeightMm * POINTS_PER_MM;
          const contentOffsetPoints = layoutMm.contentOffsetMm * POINTS_PER_MM;
          const usableTargetWidth = Math.max(layoutMm.contentWidthMm * POINTS_PER_MM, 1);
          const usableTargetHeight = Math.max(layoutMm.contentHeightMm * POINTS_PER_MM, 1);
          const embeddedImage = await newPdf.embedPng(imageSourcePngBytes);
          const srcWidth = imageSourceSize.width;
          const srcHeight = imageSourceSize.height;
          let drawWidth = usableTargetWidth;
          let drawHeight = usableTargetHeight;
          let offsetX = contentOffsetPoints;
          let offsetY = contentOffsetPoints;
          if (task.adjuster.mode === 'fill') {
            const scale = Math.max(usableTargetWidth / srcWidth, usableTargetHeight / srcHeight);
            drawWidth = srcWidth * scale;
            drawHeight = srcHeight * scale;
            offsetX = contentOffsetPoints + (usableTargetWidth - drawWidth) / 2;
            offsetY = contentOffsetPoints + (usableTargetHeight - drawHeight) / 2;
          } else if (task.adjuster.mode === 'scale') {
            const scale = Math.min(usableTargetWidth / srcWidth, usableTargetHeight / srcHeight);
            drawWidth = srcWidth * scale;
            drawHeight = srcHeight * scale;
            offsetX = contentOffsetPoints + (usableTargetWidth - drawWidth) / 2;
            offsetY = contentOffsetPoints + (usableTargetHeight - drawHeight) / 2;
          }
          const newPage = newPdf.addPage([targetWidth, targetHeight]);
          newPage.drawImage(embeddedImage, {
            x: offsetX,
            y: offsetY,
            width: drawWidth,
            height: drawHeight,
          });
          if (layoutMm.maskPaddingMm > 0) {
            applyPdfPaddingMask(newPage, targetWidth, targetHeight, layoutMm.maskPaddingMm * POINTS_PER_MM);
          }
        } else {
          throw new Error('Unsupported source type for PDF export.');
        }
        const pdfBytes = await newPdf.save();
        await writeExportFile(folder, fileNameWithExt, pdfBytes, 'application/octet-stream', dirHandle);
      } else {
        const pngBytes = await renderPngBytes(fileToSave, task.adjuster, task.pageIdx ?? task.pages[0], currentTrim);
        await writeExportFile(folder, fileNameWithExt, pngBytes, 'image/png', dirHandle);
      }
    }
  };

  const resolvePagesToProcess = async (fileToSave: File): Promise<number[]> => {
    if (sourceKind === 'image') return [0];
    if (pageSelection === 'single') return [currentPage];
    const known = pdfDocRef.current?.numPages;
    if (known && known > 0) return Array.from({ length: known }, (_, i) => i);
    const arrayBuffer = await fileToSave.arrayBuffer();
    const pdf = await getDocument({ data: arrayBuffer }).promise;
    pdfDocRef.current = pdf;
    return Array.from({ length: pdf.numPages }, (_, i) => i);
  };

  // Tauri-based export handler
  const handleSave = async () => {
    if (!file) return;
    if (adjusters.length === 0) {
      setErrorMessage('No size adjusters found. Add at least one size adjuster to export.');
      setSaveStatus('error');
      setShowPopover(true);
      return;
    }
    setSaveStatus('saving');
    setErrorMessage(null);
    if (fadeTimeout.current) clearTimeout(fadeTimeout.current);
    try {
      console.log('[Export] Starting export. isTauri:', isTauri);
      let folder = exportFolder;
      let dirHandle = exportDirHandle;

      if (!specifyExportLocation) {
        if (!isTauri) {
          dirHandle = null; // Force download behavior on web
        }
        // On Tauri, we use the default 'folder' (source path)
      } else {
        if (isTauri) {
          if (!folder) {
            const selected = await open({ directory: true, multiple: false, title: 'Select export folder' });
            if (typeof selected === 'string') {
              folder = selected;
              setExportFolder(selected);
            } else {
              setSaveStatus('idle');
              return;
            }
          }
        }
      }

      const pagesToProcess = await resolvePagesToProcess(file);
      const tasks = buildExportTasks(adjusters, pagesToProcess, fileName);
      if (tasks.length === 0) {
        throw new Error('No export tasks could be created for this source file type.');
      }
      setPendingExportTasks(tasks);

      if (isTauri) {
        if (specifyExportLocation && useSubfolder && subfolderName.trim()) {
          folder = folder.replace(/\/+$/, '') + '/' + subfolderName.trim().replace(/\/+$/, '');
        }

        const filePathsToCheck: string[] = [];
        const proposedFiles: Array<{ fileName: string; isConflict: boolean; shouldOverwrite: boolean; originalPath?: string; taskId?: string }> = [];

        for (const task of tasks) {
          const fullName = `${task.outputBaseName}.${task.extension}`;
          const savePath = folder.replace(/\/+$/, '') + '/' + fullName;
          filePathsToCheck.push(savePath);
          proposedFiles.push({
            fileName: fullName,
            isConflict: false,
            shouldOverwrite: true,
            originalPath: savePath,
            taskId: task.id,
          });
        }

        const existenceResults: boolean[] = await invoke('check_file_existence', { filePaths: filePathsToCheck });
        let hasConflicts = false;
        const updatedConflictFiles = proposedFiles.map((file, index) => {
          const isConflict = existenceResults[index];
          if (isConflict) hasConflicts = true;
          return { ...file, isConflict, shouldOverwrite: true };
        });

        if (hasConflicts) {
          setConflictFiles(updatedConflictFiles);
          setSaveStatus('conflict');
          setShowPopover(true);
          return;
        }
      } else if (dirHandle) {
        // Web: Check for conflicts using File System Access API
        let targetHandle = dirHandle;
        if (specifyExportLocation && useSubfolder && subfolderName.trim()) {
          try {
            targetHandle = await dirHandle.getDirectoryHandle(subfolderName.trim(), { create: false });
          } catch (e) {
            // Subfolder doesn't exist, so no conflicts possible inside it
            targetHandle = null;
          }
        }

        if (targetHandle) {
          const proposedFiles: Array<{ fileName: string; isConflict: boolean; shouldOverwrite: boolean; taskId?: string }> = [];
          let hasConflicts = false;

          for (const task of tasks) {
            const finalName = `${task.outputBaseName}.${task.extension}`;
            let isConflict = false;
            try {
              await targetHandle.getFileHandle(finalName, { create: false });
              isConflict = true;
              hasConflicts = true;
            } catch (e) {
              // File doesn't exist
            }
            proposedFiles.push({
              fileName: finalName,
              isConflict,
              shouldOverwrite: true,
              taskId: task.id,
            });
          }

          if (hasConflicts) {
            setConflictFiles(proposedFiles);
            setSaveStatus('conflict');
            setShowPopover(true);
            return;
          }
        }
      }

      // If no conflicts or in browser, proceed with saving
      await runExportTasks(folder, tasks, file, trim, dirHandle);
      setSaveStatus('success');
      fadeTimeout.current = setTimeout(() => setSaveStatus('idle'), 5000);
      setPendingExportTasks([]);

    } catch (err: any) {
      console.error('[Export] Error during export:', err);
      setErrorMessage(err?.message || String(err));
      setSaveStatus('error');
      setShowPopover(true);
    }
  };

  const handleContinueSave = async () => {
    if (!file) return;
    setSaveStatus('saving');
    setShowPopover(false);
    setErrorMessage(null);

    try {
      const selectedTaskIds = new Set(
        conflictFiles.filter(fileItem => fileItem.shouldOverwrite).map(fileItem => fileItem.taskId).filter(Boolean)
      );
      const tasksToSave = pendingExportTasks.filter(task => selectedTaskIds.has(task.id));

      let folder = exportFolder;
      if (specifyExportLocation && useSubfolder && subfolderName.trim()) {
        folder = folder.replace(/\/+$/, '') + '/' + subfolderName.trim().replace(/\/+$/, '');
      }

      await runExportTasks(folder, tasksToSave, file, trim, exportDirHandle);
      setSaveStatus('success');
      fadeTimeout.current = setTimeout(() => setSaveStatus('idle'), 5000);
      setConflictFiles([]); // Clear conflicts after saving
      setPendingExportTasks([]);
    } catch (err: any) {
      setErrorMessage(err?.message || String(err));
      setSaveStatus('error');
      setShowPopover(true);
    }
  };

  // Handler for canceling overwrite
  const handleCancelOverwrite = () => {
    setSaveStatus('idle');
    setShowPopover(false);
    setConflictFiles([]); // Clear conflicts on cancel
    setPendingExportTasks([]);
  };

  const handleAddPdfAdjuster = () => {
    setAdjusters(adjs => {
      const pdfAdjusters = getPdfAdjusters(adjs);
      const lastPdf = pdfAdjusters[pdfAdjusters.length - 1];
      const fallbackWidth = pdfSize ? Number(pdfSize.width.toFixed(2)) : 210;
      const fallbackHeight = pdfSize ? Number(pdfSize.height.toFixed(2)) : 297;
      return [
        ...adjs,
        lastPdf
          ? { ...lastPdf, id: crypto.randomUUID() }
          : {
              id: crypto.randomUUID(),
              kind: 'pdf',
              mode: 'fill',
              width: fallbackWidth,
              height: fallbackHeight,
              marginMm: 0,
              paddingMode: 'inside',
              scaleFactor: sessionScaleFactor,
              source: 'manual',
            },
      ];
    });
  };

  const handleAddPngAdjuster = () => {
    setAdjusters(adjs => [...adjs, makeDefaultPngAdjuster()]);
  };

  const activePdfAdjuster =
    adjusters.find(adj => adj.id === focusedAdjusterId && adj.kind === 'pdf') ||
    adjusters.find(adj => adj.kind === 'pdf') ||
    null;
  const showResultPaddingPreview =
    sourceKind === 'pdf' &&
    Boolean(renderedPdfCssSize) &&
    Boolean(resultPreviewFrame) &&
    Boolean(activePdfAdjuster) &&
    Number(activePdfAdjuster?.width ?? 0) > 0 &&
    Number(activePdfAdjuster?.height ?? 0) > 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      minHeight: '100vh',
      width: '100%',
      boxSizing: 'border-box',
      paddingTop: 32,
      paddingBottom: 32,
      background: 'var(--bg-color)',
    }}>
      {!isTauri && (
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 32, color: 'var(--text-color)', letterSpacing: 0.5 }}>PDF Resizer</h1>
      )}
      {unsupportedFormatMessage && (
        <div style={{
          background: '#000',
          color: '#fff',
          padding: '8px 14px',
          borderRadius: 8,
          fontSize: 14,
          marginBottom: 12,
        }}>
          {unsupportedFormatMessage}
        </div>
      )}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={onClick}
        style={{
          width: PREVIEW_WIDTH,
          height: PREVIEW_HEIGHT,
          border: dragActive ? '1px dashed var(--border-color-accent)' : '1px solid var(--secondary-color)',
          borderRadius: 16,
          background: 'var(--bg-color)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'border 0.2s',
          position: 'relative',
          boxSizing: 'border-box',
          marginBottom: 0,
          overflow: 'hidden',
          transform: 'translateZ(0)',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.ai,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.avif,.heic,.heif,image/*"
          style={{ display: 'none' }}
          onChange={onFileChange}
        />
        {file ? (
          <>
            {isLoading && (
              <div className="pdf-skeleton-loader" style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                borderRadius: 16,
                zIndex: 10,
                pointerEvents: 'none',
              }} />
            )}
            {renderError && (
              <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#FF3B30', background: 'var(--modal-bg)', opacity: 0.9, zIndex: 20, borderRadius: 16, fontWeight: 600, fontSize: 16 }}>
                {renderError}
              </div>
            )}
            <canvas
              ref={canvasRef}
              width={PREVIEW_WIDTH - 6}
              height={PREVIEW_HEIGHT - 6}
              style={{
                display: 'block',
                background: 'transparent',
                pointerEvents: 'none',
              }}
            />
            {showResultPaddingPreview && renderedPdfCssSize && resultPreviewFrame && (
              <div style={{
                position: 'absolute',
                top: (PREVIEW_HEIGHT - renderedPdfCssSize.height) / 2 + resultPreviewFrame.top,
                left: (PREVIEW_WIDTH - renderedPdfCssSize.width) / 2 + resultPreviewFrame.left,
                width: resultPreviewFrame.width,
                height: resultPreviewFrame.height,
                pointerEvents: 'none',
                overflow: 'hidden',
              }}>
                <canvas
                  ref={resultPreviewCanvasRef}
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    background: '#fff',
                  }}
                />
              </div>
            )}
            {sourceKind === 'pdf' && cropOverlay && renderedPdfCssSize && !showResultPaddingPreview && (
              <div style={{
                position: 'absolute',
                top: (PREVIEW_HEIGHT - renderedPdfCssSize.height) / 2,
                left: (PREVIEW_WIDTH - renderedPdfCssSize.width) / 2,
                width: renderedPdfCssSize.width,
                height: renderedPdfCssSize.height,
                pointerEvents: 'none',
                overflow: 'hidden',
              }}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: cropOverlay.top, background: 'rgba(0,0,0,0.5)' }} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: cropOverlay.bottom, background: 'rgba(0,0,0,0.5)' }} />
                <div style={{ position: 'absolute', top: cropOverlay.top, bottom: cropOverlay.bottom, left: 0, width: cropOverlay.left, background: 'rgba(0,0,0,0.5)' }} />
                <div style={{ position: 'absolute', top: cropOverlay.top, bottom: cropOverlay.bottom, right: 0, width: cropOverlay.right, background: 'rgba(0,0,0,0.5)' }} />
              </div>
            )}
            {/* Pagination overlay */}
            {sourceKind === 'pdf' && totalPages > 1 && (
              <div style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'auto',
                zIndex: 3,
                userSelect: 'none',
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: 'rgba(0,0,0,0.5)',
                  borderRadius: 8,
                  padding: '0 8px',
                  height: 32,
                  minWidth: 100,
                }}>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); setCurrentPage(p => Math.max(0, p - 1)); }}
                    disabled={currentPage === 0}
                    style={{
                      background: 'none',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      width: 28,
                      height: 28,
                      marginRight: 4,
                      cursor: currentPage === 0 ? 'not-allowed' : 'pointer',
                      opacity: currentPage === 0 ? 0.5 : 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    tabIndex={-1}
                    aria-label="Previous page"
                  >
                    ←
                  </button>
                  <span style={{ color: '#fff', fontSize: 15, fontWeight: 500, minWidth: 48, textAlign: 'center', letterSpacing: 0.5 }}>
                    {currentPage + 1} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); setCurrentPage(p => Math.min(totalPages - 1, p + 1)); }}
                    disabled={currentPage === totalPages - 1}
                    style={{
                      background: 'none',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      width: 28,
                      height: 28,
                      marginLeft: 4,
                      cursor: currentPage === totalPages - 1 ? 'not-allowed' : 'pointer',
                      opacity: currentPage === totalPages - 1 ? 0.5 : 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    tabIndex={-1}
                    aria-label="Next page"
                  >
                    →
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                setFile(null);
                setSourceKind(null);
                setFileName('');
                setOriginalFileName('');
                setOriginalImportedName('');
                setFileSize(null);
                setPdfSize(null);
                setImageSizePx(null);
                setTrim(0);
                setCurrentPage(0);
                setTotalPages(1);
                setCropOverlay(null);
                setRenderedPdfCssSize(null);
                setPdfRenderScale(null);
                pdfDocRef.current = null;
              }}
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                width: 28,
                height: 28,
                padding: 0,
                border: 'none',
                background: 'transparent',
                borderRadius: '50%',
                color: 'var(--secondary-color)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 2,
                transition: 'background 0.2s',
                lineHeight: 1,
                textAlign: 'center',
              }}
              aria-label="Close file preview"
            >
              <svg width="22" height="22" viewBox="0 0 20.2832 19.9316" style={{ display: 'block' }} xmlns="http://www.w3.org/2000/svg">
                <g>
                  <rect height="19.9316" opacity="0" width="20.2832" x="0" y="0" />
                  <path d="M19.9219 9.96094C19.9219 15.4492 15.459 19.9219 9.96094 19.9219C4.47266 19.9219 0 15.4492 0 9.96094C0 4.46289 4.47266 0 9.96094 0C15.459 0 19.9219 4.46289 19.9219 9.96094ZM12.7051 6.11328L9.96094 8.83789L7.23633 6.12305C7.08008 5.97656 6.9043 5.89844 6.67969 5.89844C6.23047 5.89844 5.87891 6.24023 5.87891 6.69922C5.87891 6.91406 5.95703 7.10938 6.11328 7.26562L8.81836 9.9707L6.11328 12.6855C5.95703 12.832 5.87891 13.0371 5.87891 13.252C5.87891 13.7012 6.23047 14.0625 6.67969 14.0625C6.9043 14.0625 7.10938 13.9844 7.26562 13.8281L9.96094 11.1133L12.666 13.8281C12.8125 13.9844 13.0176 14.0625 13.2422 14.0625C13.7012 14.0625 14.0625 13.7012 14.0625 13.252C14.0625 13.0273 13.9844 12.8223 13.8184 12.6758L11.1133 9.9707L13.8281 7.25586C14.0039 7.08008 14.0723 6.9043 14.0723 6.67969C14.0723 6.23047 13.7109 5.87891 13.2617 5.87891C13.0469 5.87891 12.8711 5.94727 12.7051 6.11328Z" fill="currentColor" fillOpacity="0.85" />
                </g>
              </svg>
            </button>
          </>
        ) : (
          <span style={{ color: 'var(--secondary-color)', fontSize: 18, userSelect: 'none', textAlign: 'center', lineHeight: 1.35 }}>
            Drop .pdf, .ai or image here
            <br />
            or click to select
          </span>
        )}
      </div>
      {/* Filename under preview: always show imported name with extension if file is loaded */}
      {file && originalImportedName && (
        <div style={{
          marginTop: 12,
          color: 'var(--text-color)',
          fontSize: 16,
          textAlign: 'center',
          width: '100%',
          maxWidth: 'none',
          wordBreak: 'break-all',
          alignSelf: 'center',
        }}>
          {originalImportedName}
        </div>
      )}
      {file && sourceKind === 'pdf' && totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 8, gap: 16 }}>
          <span style={{ color: 'var(--secondary-color)', fontSize: 14 }}>Process:</span>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: 14 }}>
            <input
              type="radio"
              checked={pageSelection === 'single'}
              onChange={() => setPageSelection('single')}
              style={{ marginRight: 4 }}
            />
            This page
          </label>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: 14 }}>
            <input
              type="radio"
              checked={pageSelection === 'all'}
              onChange={() => setPageSelection('all')}
              style={{ marginRight: 4 }}
            />
            All pages
          </label>
        </div>
      )}
      {file && sourceKind === 'pdf' && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          maxWidth: 'none',
          margin: '0 auto',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 8, gap: 6, width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--secondary-color)', fontSize: 14 }}>
                {pdfSize ? formatSizePoints(pdfSize.width, pdfSize.height) : ''}
              </span>
              {trim === 0 && (
                <button
                  type="button"
                  onClick={handleSetToPdfDimensions}
                  style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', color: 'var(--secondary-color)', display: 'flex', alignItems: 'center' }}
                  title="Reset size adjuster to PDF dimensions"
                >
                  <svg width="18" height="14" viewBox="0 0 22.3773 17.8571" style={{ display: 'block' }} xmlns="http://www.w3.org/2000/svg">
                    <g>
                      <rect height="17.8571" opacity="0" width="22.3773" x="0" y="0" />
                      <path d="M2.46305 0.271327C1.35954 1.53109 0.509927 3.07406 0.0314117 4.68539C-0.212729 5.535 1.03727 5.97445 1.33024 4.99789C1.75016 3.59164 2.50211 2.26351 3.47868 1.15023C4.12321 0.417811 3.10758-0.451329 2.46305 0.271327ZM2.46305 14.2362C3.10758 14.9686 4.12321 14.0995 3.47868 13.3573C2.50211 12.2537 1.75016 10.9256 1.33024 9.51937C1.03727 8.53305-0.212729 8.9725 0.0314117 9.83187C0.509927 11.4432 1.35954 12.9862 2.46305 14.2362Z" fill="currentColor" fillOpacity="0.85" />
                      <path d="M14.299 17.6248C17.922 17.6248 22.0138 15.3202 22.0138 10.3104C22.0138 7.89828 20.7443 2.60531 19.1037 2.60531C18.8205 2.60531 18.6252 2.78109 18.6935 2.97641L18.9084 3.61117C19.1037 4.20687 18.342 4.45101 18.1173 3.88461L17.7463 2.97641C17.2091 1.67758 15.9396 1.56039 15.2463 1.87289C15.0705 1.96078 15.0412 2.10726 15.1095 2.22445C15.4318 2.80062 15.6955 3.35726 15.9591 3.93344C16.2521 4.58773 15.3634 5.00766 15.0021 4.3143C14.7775 3.87484 14.4845 3.33773 14.1916 2.97641C13.1173 1.57016 11.2912 1.17953 9.30876 1.69711L6.28141 2.48812C4.29899 3.01547 5.1193 5.36898 6.95524 4.98812L9.90446 4.39242C10.8029 4.20687 11.5744 4.43148 12.0041 4.98812C12.6681 5.8768 13.3517 7.25375 13.3517 8.24984C13.3517 9.63656 12.5119 11.2772 10.7443 11.2772C9.87516 11.2772 8.85954 10.8768 7.87321 9.91L5.96891 8.04476C4.79704 6.89242 2.75602 8.39633 4.10368 9.96859L7.31657 13.7381C9.62126 16.4432 11.9552 17.6248 14.299 17.6248Z" fill="currentColor" fillOpacity="0.85" />
                    </g>
                  </svg>
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--secondary-color)', fontSize: 14 }}>
              <label
                title={!isTauri ? 'Requires desktop app with Ghostscript installed' :
                  !ghostscriptAvailable
                    ? (isWindows
                      ? 'Ghostscript is unavailable. Use the portable ZIP build (includes gs.exe) or install Ghostscript.'
                      : 'Ghostscript is unavailable. This app expects a bundled sidecar; install Ghostscript only as fallback.')
                    : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  cursor: (isTauri && ghostscriptAvailable) ? 'pointer' : 'not-allowed',
                  opacity: (isTauri && ghostscriptAvailable) ? 1 : 0.5,
                  color: 'var(--text-color)',
                }}
              >
                <input
                  type="checkbox"
                  checked={flatten}
                  onChange={e => setFlatten(e.target.checked)}
                  disabled={!isTauri || !ghostscriptAvailable}
                  style={{ marginRight: 6 }}
                />
                Flatten
              </label>
              <span>Trim:</span>
              <input
              type="text"
              min={0}
              max={20}
              value={trimInput}
              onChange={e => {
                let val = e.target.value.replace(/[^\d.,]/g, '');
                val = val.replace(/(\d+[.,]\d{0,2}).*/, '$1');
                setTrimInput(val);
                if (/^\d*[.,]?\d{0,2}$/.test(val)) {
                  const t = parseTrimInput(val);
                  const liveTrim = (!isNaN(t) && val !== '' && val !== '.' && val !== ',') ? t : 0;
                  applyTrimLive(liveTrim);
                }
              }}
              onBlur={() => {
                const t = parseTrimInput(trimInput);
                setTrimInput(Number.isFinite(t) ? formatTrim(t) : '');
                applyTrimLive(Number.isFinite(t) ? t : 0);
              }}
              onKeyDown={e => {
                let t = parseTrimInput(trimInput);
                if (!Number.isFinite(t)) t = 0;
                let next = t;
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  let step = 1;
                  if (e.shiftKey) step = 10;
                  if (e.shiftKey) {
                    if (e.key === 'ArrowUp') {
                      next = Math.ceil(t / 10) * 10;
                      if (next === t) next += 10;
                    } else {
                      next = Math.floor(t / 10) * 10;
                      if (next === t) next -= 10;
                      if (next < 0) next = 0;
                    }
                  } else {
                    if (e.key === 'ArrowUp') {
                      next = Math.ceil(t);
                      if (next === t) next += 1;
                    } else {
                      next = Math.floor(t);
                      if (next === t) next -= 1;
                      if (next < 0) next = 0;
                    }
                  }
                  setTrimInput(formatTrimInput(next));
                  applyTrimLive(next);
                  e.preventDefault();
                }
              }}
              style={{ width: 36, fontSize: 14, padding: '2px 2px', borderRadius: 4, border: '1px solid var(--input-border)', textAlign: 'right', marginRight: 0, background: 'var(--input-bg)', color: 'var(--text-color)' }}
              />
              {trimmedForAspect && trim > 0 && (
                <>
                  <span>→</span>
                  <span>{formatSizePoints(trimmedForAspect.width, trimmedForAspect.height)}</span>
                  <button
                    type="button"
                    onClick={handleSetToTrimmedDimensions}
                    style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', color: 'var(--secondary-color)', display: 'flex', alignItems: 'center' }}
                    title="Reset size adjuster to trimmed dimensions"
                  >
                    <svg width="18" height="14" viewBox="0 0 22.3773 17.8571" style={{ display: 'block' }} xmlns="http://www.w3.org/2000/svg">
                      <g>
                        <rect height="17.8571" opacity="0" width="22.3773" x="0" y="0" />
                        <path d="M2.46305 0.271327C1.35954 1.53109 0.509927 3.07406 0.0314117 4.68539C-0.212729 5.535 1.03727 5.97445 1.33024 4.99789C1.75016 3.59164 2.50211 2.26351 3.47868 1.15023C4.12321 0.417811 3.10758-0.451329 2.46305 0.271327ZM2.46305 14.2362C3.10758 14.9686 4.12321 14.0995 3.47868 13.3573C2.50211 12.2537 1.75016 10.9256 1.33024 9.51937C1.03727 8.53305-0.212729 8.9725 0.0314117 9.83187C0.509927 11.4432 1.35954 12.9862 2.46305 14.2362Z" fill="currentColor" fillOpacity="0.85" />
                        <path d="M14.299 17.6248C17.922 17.6248 22.0138 15.3202 22.0138 10.3104C22.0138 7.89828 20.7443 2.60531 19.1037 2.60531C18.8205 2.60531 18.6252 2.78109 18.6935 2.97641L18.9084 3.61117C19.1037 4.20687 18.342 4.45101 18.1173 3.88461L17.7463 2.97641C17.2091 1.67758 15.9396 1.56039 15.2463 1.87289C15.0705 1.96078 15.0412 2.10726 15.1095 2.22445C15.4318 2.80062 15.6955 3.35726 15.9591 3.93344C16.2521 4.58773 15.3634 5.00766 15.0021 4.3143C14.7775 3.87484 14.4845 3.33773 14.1916 2.97641C13.1173 1.57016 11.2912 1.17953 9.30876 1.69711L6.28141 2.48812C4.29899 3.01547 5.1193 5.36898 6.95524 4.98812L9.90446 4.39242C10.8029 4.20687 11.5744 4.43148 12.0041 4.98812C12.6681 5.8768 13.3517 7.25375 13.3517 8.24984C13.3517 9.63656 12.5119 11.2772 10.7443 11.2772C9.87516 11.2772 8.85954 10.8768 7.87321 9.91L5.96891 8.04476C4.79704 6.89242 2.75602 8.39633 4.10368 9.96859L7.31657 13.7381C9.62126 16.4432 11.9552 17.6248 14.299 17.6248Z" fill="currentColor" fillOpacity="0.85" />
                      </g>
                    </svg>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {file && sourceKind === 'image' && imageSizePx && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          maxWidth: 'none',
          margin: '0 auto',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 8, gap: 8, width: '100%' }}>
            <span style={{ color: 'var(--secondary-color)', fontSize: 14 }}>
              {`${Math.round(imageSizePx.width)} × ${Math.round(imageSizePx.height)} px`}
            </span>
          </div>
        </div>
      )}
      {file && (
        <div style={{ width: '100%', maxWidth: 500, margin: '32px auto 0 auto', overflow: 'visible' }}>
          {adjusters.map((adjuster, idx) => (
            <SizeAdjusterCard
              key={adjuster.id}
              adjuster={adjuster}
              onChange={(updated: any) => {
                setAdjusters(adjs => adjs.map((a, i) => i === idx ? { ...a, ...updated } : a));
              }}
              onFocus={setFocusedAdjusterId}
              onBlur={() => setFocusedAdjusterId(null)}
              onRemove={() => setAdjusters(adjs => adjs.filter((_, i) => i !== idx))}
              isRemovable={adjusters.length > 1}
              aspectRatio={aspectRatio}
              sourceSizeMm={sourceKind === 'pdf' ? trimmedForAspect : null}
              pdfMaxDimensionMm={PDF_MAX_DIMENSION_MM}
              pdfMinDimensionMm={PDF_MIN_DIMENSION_MM}
              sessionScaleFactor={sessionScaleFactor}
              onSessionScaleFactorChange={setSessionScaleFactor}
              SwapIcon={ArrowLeftArrowRight}
              RemoveIcon={MinusCircleFill}
              presets={presets}
              onEditPresets={() => setShowPresetsEditor(true)}
            />
          ))}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 8 }}>
            <button
              type="button"
              onClick={handleAddPdfAdjuster}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-color)', fontSize: 16, cursor: 'pointer', fontWeight: 500
              }}
            >
              <PlusCircleFill style={{ width: 20, height: 20, display: 'block', color: 'var(--secondary-color)' }} />
              <span style={{ color: 'var(--text-color)' }}>Add .pdf size</span>
            </button>
            <button
              type="button"
              onClick={handleAddPngAdjuster}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-color)', fontSize: 16, cursor: 'pointer', fontWeight: 500
              }}
            >
              <PlusCircleFill style={{ width: 20, height: 20, display: 'block', color: 'var(--secondary-color)' }} />
              <span style={{ color: 'var(--text-color)' }}>Add .png</span>
            </button>
          </div>
        </div>
      )}
      {/* Filename Editor Section */}
      {file && (
        <FileNameEditor
          value={fileName}
          originalValue={originalFileName}
          onChange={setFileName}
          disabled={!file}
          onRestore={() => setFileName(originalFileName)}
        />
      )}
      {/* Export location section */}
      {file && (
        <div
          title={!isExportDirSupported ? "Not supported by your browser. Chromium-based browsers are recommended" : undefined}
          style={{
            width: 400,
            maxWidth: '100%',
            margin: '24px auto 0 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            opacity: isExportDirSupported ? 1 : 0.5,
          }}
        >
          <label style={{
            display: 'flex',
            alignItems: 'center',
            fontWeight: 500,
            fontSize: 16,
            marginBottom: 10,
            color: 'var(--text-color)',
            cursor: isExportDirSupported ? 'pointer' : 'not-allowed'
          }}>
            <input
              type="checkbox"
              checked={specifyExportLocation}
              onChange={e => setSpecifyExportLocation(e.target.checked)}
              style={{ marginRight: 8 }}
              disabled={!isExportDirSupported}
            />
            Specify export location
          </label>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            opacity: specifyExportLocation ? 1 : 0.5,
            pointerEvents: specifyExportLocation ? 'auto' : 'none',
            transition: 'opacity 0.2s'
          }}>
            <button
              type="button"
              onClick={handlePickFolder}
              disabled={!file}
              style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--input-border)', color: 'var(--text-color)', fontWeight: 500, fontSize: 15, cursor: !file ? 'not-allowed' : 'pointer', width: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', display: 'inline-block', background: 'var(--input-bg)' }}
            >
              <span style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}>{exportFolder ? exportFolder : 'Browse…'}</span>
            </button>
            {/* fallback file input for browser */}
            <input
              ref={folderInputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={handleFolderPick}
              disabled={!file}
            />
            <label style={{ display: 'flex', alignItems: 'center', fontSize: 15, gap: 2, marginLeft: 6 }}>
              <input
                type="checkbox"
                checked={useSubfolder}
                onChange={e => setUseSubfolder(e.target.checked)}
                disabled={!file}
              />
              Subfolder
            </label>
            <input
              type="text"
              value={subfolderName}
              onChange={e => setSubfolderName(e.target.value)}
              disabled={!file || !useSubfolder}
              style={{ fontSize: 15, borderRadius: 6, border: '1px solid var(--input-border)', padding: '4px 10px', width: 60, background: 'var(--input-bg)', color: 'var(--text-color)' }}
              placeholder="Subfolder name"
            />
          </div>
        </div>
      )}
      {/* Save Button Section */}
      {file && (
        <SaveButtonWithStatus
          status={saveStatus}
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          showPopover={showPopover}
          setShowPopover={setShowPopover}
          conflictFiles={conflictFiles}
          setConflictFiles={setConflictFiles}
          onOverwrite={handleContinueSave}
          onCancel={handleCancelOverwrite}
          onContinue={handleContinueSave}
          onErrorAcknowledge={() => {
            setShowPopover(false);
            setSaveStatus('idle');
          }}
        />
      )}
      {showPresetsEditor && (
        <PresetsEditor
          presets={presets}
          defaultPresets={DEFAULT_PRESETS}
          onSave={(newPresets) => setPresets(newPresets)}
          onClose={() => setShowPresetsEditor(false)}
          newPresetState={newPresetState}
          onNewPresetStateChange={setNewPresetState}
        />
      )}
    </div>
  );
}

export default PDFDropZone; 
