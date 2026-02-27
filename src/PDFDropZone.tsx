import React, { useRef, useState, useEffect } from 'react';
import { GlobalWorkerOptions, getDocument, version as pdfjsVersion } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import SizeAdjusterCard from './SizeAdjusterCard';
import ArrowLeftArrowRight from './assets/arrow.left.arrow.right.svg?react';
import MinusCircleFill from './assets/minus.circle.fill.svg?react';
import PlusCircleFill from './assets/plus.circle.fill.svg?react';
import ArrowCounterclockwiseCircleFill from './assets/arrow.counterclockwise.circle.fill.svg?react';
import ArrowCounterclockwise from './assets/arrow.counterclockwise.svg?react';
import FileNameEditor from './FileNameEditor';
import SaveButtonWithStatus from './SaveButtonWithStatus';
import './pdf-skeleton.css';
import { PDFDocument } from 'pdf-lib';
import { writeBinaryFile, exists } from '@tauri-apps/api/fs';
import { open } from '@tauri-apps/api/dialog';
import { invoke } from '@tauri-apps/api/tauri';
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

function replaceFilenameTokens(name: string, width: number, height: number) {
  // Ensure tokens are surrounded by underscores if not already
  let result = name
    .replace(/\*size\*/g, '_*size*_')
    .replace(/\*YYMMDD\*/g, '_*YYMMDD*_')
    .replace(/\*DDMMYY\*/g, '_*DDMMYY*_');

  // Remove duplicate underscores from token insertion
  result = result.replace(/_+/g, '_');

  // Replace *size* with e.g. 210x297
  result = result.replace(/_\*size\*_/g, `_${Math.round(width)}x${Math.round(height)}_`);
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
    return Number.isInteger(val)
      ? val.toString().replace('.', ',')
      : val.toFixed(1).replace('.', ',');
  }
  return `${fmt(width)} × ${fmt(height)} mm`;
}

function getTrimmedSize(pdfSize: { width: number; height: number } | null, trimMM: number = 0) {
  if (!pdfSize) return null;
  const trimmedWidth = Math.max(pdfSize.width - 2 * trimMM, 1);
  const trimmedHeight = Math.max(pdfSize.height - 2 * trimMM, 1);
  return { width: trimmedWidth, height: trimmedHeight };
}

interface Adjuster {
  id: string;
  mode: string;
  width: number;
  height: number;
  source: string;
}

function PDFDropZone() {
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [originalFileName, setOriginalFileName] = useState('');
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [pdfSize, setPdfSize] = useState<{ width: number; height: number } | null>(null);
  const [trim, setTrim] = useState(0); // in mm
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [pageSelection, setPageSelection] = useState<'single' | 'all'>('single');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pdfDocRef = useRef<any>(null); // store loaded pdf.js doc

  const STORAGE_KEY_PRESETS = 'pdf_resizer_presets';
  const STORAGE_KEY_ADJUSTERS = 'pdf_resizer_adjusters';

  const [adjusters, setAdjusters] = useState<Adjuster[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ADJUSTERS);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error('Failed to load adjusters', e);
    }
    return [{ id: crypto.randomUUID(), mode: 'fill', width: 210, height: 297, source: 'pdf' }];
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
  const [conflictFiles, setConflictFiles] = useState<Array<{ fileName: string; isConflict: boolean; shouldOverwrite: boolean; originalPath?: string }>>([]);
  const [focusedAdjusterId, setFocusedAdjusterId] = useState<string | null>(null);
  const [cropOverlay, setCropOverlay] = useState<{ top: number; right: number; bottom: number; left: number } | null>(null);
  const [renderedPdfCssSize, setRenderedPdfCssSize] = useState<{ width: number; height: number } | null>(null);
  const [pdfRenderScale, setPdfRenderScale] = useState<number | null>(null);
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
    return val.toFixed(2).replace('.', ',');
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

  // Handle file selection
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const pdfFile = files[0];
    if (pdfFile.type !== 'application/pdf') return;
    setFile(pdfFile);
    setFileName(pdfFile.name);
    setOriginalFileName(pdfFile.name);
    setFileSize(pdfFile.size);
    setTrim(0);
    setCurrentPage(0);
    setTotalPages(1);
    setPdfSize(null);
    pdfDocRef.current = null;
    // Set export folder to imported PDF's location (Tauri only, if available)
    if (isTauri && (pdfFile as any).path) {
      const path = (pdfFile as any).path;
      const folder = path.substring(0, path.lastIndexOf('/'));
      setExportFolder(folder);
    }
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

  // Use effect to render preview when file, canvas, or currentPage are ready
  useEffect(() => {
    if (file && canvasRef.current) {
      renderPDFPreview(file, currentPage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, currentPage]);

  // --- Crop preview logic ---
  useEffect(() => {
    if (!file || !pdfSize || !canvasRef.current || !renderedPdfCssSize || pdfRenderScale === null) {
      setCropOverlay(null);
      return;
    }

    const POINTS_PER_MM = 1 / MM_PER_POINT;
    const trimPoints = trim * POINTS_PER_MM;

    // Calculate trim overlay based on the actual rendered PDF size
    let overlay = {
      top: trimPoints * pdfRenderScale,
      bottom: trimPoints * pdfRenderScale,
      left: trimPoints * pdfRenderScale,
      right: trimPoints * pdfRenderScale,
    };

    const focusedAdjuster = adjusters.find(adj => adj.id === focusedAdjusterId);

    if (focusedAdjuster && focusedAdjuster.mode === 'fill') {
      const targetWidth = focusedAdjuster.width * POINTS_PER_MM;
      const targetHeight = focusedAdjuster.height * POINTS_PER_MM;

      // Calculate the scale needed to fill the target dimensions, considering the trimmed PDF size
      const effectivePdfWidth = pdfSize.width - 2 * trimPoints;
      const effectivePdfHeight = pdfSize.height - 2 * trimPoints;

      const fillScale = Math.max(targetWidth / effectivePdfWidth, targetHeight / effectivePdfHeight);

      // Calculate the excess area in PDF points that will be cropped by the fill operation
      const excessWidthPoints = (effectivePdfWidth * fillScale - targetWidth) / 2;
      const excessHeightPoints = (effectivePdfHeight * fillScale - targetHeight) / 2;

      // Add the excess cropping to the overlay, scaled to CSS pixels
      overlay.left += excessWidthPoints * pdfRenderScale;
      overlay.right += excessWidthPoints * pdfRenderScale;
      overlay.top += excessHeightPoints * pdfRenderScale;
      overlay.bottom += excessHeightPoints * pdfRenderScale;
    }

    setCropOverlay(overlay);

  }, [file, pdfSize, trim, adjusters, focusedAdjusterId, renderedPdfCssSize, pdfRenderScale]);

  // Redraw PDF preview on theme change
  useEffect(() => {
    if (!file) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      renderPDFPreview(file, currentPage);
    };
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  }, [file, currentPage]);

  // Keyboard navigation for multipage
  useEffect(() => {
    if (!file || totalPages <= 1) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && currentPage > 0) {
        setCurrentPage(p => Math.max(0, p - 1));
      } else if (e.key === 'ArrowRight' && currentPage < totalPages - 1) {
        setCurrentPage(p => Math.min(totalPages - 1, p + 1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [file, currentPage, totalPages]);

  // Calculate trimmed size for aspect ratio (avoid redeclaration)
  const trimmedForAspect = trim > 0 && pdfSize ? getTrimmedSize(pdfSize, trim) : pdfSize;
  const aspectRatio = trimmedForAspect ? trimmedForAspect.width / trimmedForAspect.height : 1;

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
    handleFiles(e.dataTransfer.files);
  };
  const onClick = () => {
    inputRef.current?.click();
  };
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
  };

  useEffect(() => {
    if (pdfSize && file) {
      setAdjusters(adjs => {
        if (adjs.length === 1 && (adjs[0].source === 'pdf' || adjs[0].source === 'trimmed')) {
          return [{
            ...adjs[0],
            width: Number(pdfSize.width.toFixed(2)),
            height: Number(pdfSize.height.toFixed(2)),
            source: 'pdf',
          }];
        }
        return adjs;
      });
    }
  }, [pdfSize, file]);

  // Add handlers above the return statement
  const handleSetToPdfDimensions = () => {
    if (!pdfSize) return;
    setAdjusters(adjs => [
      {
        ...adjs[0],
        width: Number(pdfSize.width.toFixed(2)),
        height: Number(pdfSize.height.toFixed(2)),
        source: 'pdf',
      },
      ...adjs.slice(1)
    ]);
  };
  const handleSetToTrimmedDimensions = () => {
    if (!pdfSize) return;
    const trimmedWidth = Math.max(pdfSize.width - 2 * trim, 1);
    const trimmedHeight = Math.max(pdfSize.height - 2 * trim, 1);
    setAdjusters(adjs => [
      {
        ...adjs[0],
        width: Number(trimmedWidth.toFixed(2)),
        height: Number(trimmedHeight.toFixed(2)),
        source: 'trimmed',
      },
      ...adjs.slice(1)
    ]);
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

  // Update adjusters when aspect ratio changes (e.g., when trim changes)
  useEffect(() => {
    setAdjusters(adjs => adjs.map(adj => {
      if (adj.mode === 'fitHeight' && aspectRatio) {
        return { ...adj, height: Number((adj.width / aspectRatio).toFixed(2)) };
      }
      if (adj.mode === 'fitWidth' && aspectRatio) {
        return { ...adj, width: Number((adj.height * aspectRatio).toFixed(2)) };
      }
      return adj;
    }));
  }, [aspectRatio]);

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
  const isFileSystemAccessSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  const isExportDirSupported = isTauri || isFileSystemAccessSupported;

  const [exportDirHandle, setExportDirHandle] = useState<any>(null);

  // Helper function to perform the actual PDF saving
  const performSave = async (folder: string, adjustersToSave: Adjuster[], pagesToProcess: number[], fileToSave: File, baseFileName: string, currentTrim: number, currentPageNum: number, pageSelectionType: 'single' | 'all', dirHandle?: any) => {
    let arrayBuffer = await fileToSave.arrayBuffer();

    // Pre-process: flatten via Ghostscript if enabled (Tauri only)
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

    for (const adj of adjustersToSave) {
      const newPdf = await PDFDocument.create();
      let pages: number[] = [];
      if (pageSelectionType === 'all') {
        pages = Array.from({ length: pdfDoc.getPageCount() }, (_, i) => i);
      } else {
        pages = [currentPageNum];
      }

      for (const pageIdx of pages) {
        const srcPage = pdfDoc.getPage(pageIdx);
        let { width: srcWidth, height: srcHeight } = srcPage.getSize();
        let cropX = 0, cropY = 0, cropWidth = srcWidth, cropHeight = srcHeight;
        if (currentTrim > 0) {
          const POINTS_PER_MM = 1 / MM_PER_POINT;
          const trimPoints = currentTrim * POINTS_PER_MM;
          cropX = trimPoints;
          cropY = trimPoints;
          cropWidth = Math.max(srcWidth - 2 * trimPoints, 1);
          cropHeight = Math.max(srcHeight - 2 * trimPoints, 1);
        }
        let targetWidth = cropWidth, targetHeight = cropHeight;
        if (adj) {
          const POINTS_PER_MM = 1 / MM_PER_POINT;
          targetWidth = adj.width * POINTS_PER_MM;
          targetHeight = adj.height * POINTS_PER_MM;
        }
        const [embeddedPage] = await newPdf.embedPages([srcPage], [
          {
            left: cropX,
            bottom: cropY,
            right: cropX + cropWidth,
            top: cropY + cropHeight,
          },
        ]);
        let scaleX = 1, scaleY = 1;
        let offsetX = 0, offsetY = 0;

        if (adj.mode === 'fill') {
          const scale = Math.max(targetWidth / cropWidth, targetHeight / cropHeight);
          scaleX = scale;
          scaleY = scale;
          offsetX = (targetWidth - cropWidth * scale) / 2;
          offsetY = (targetHeight - cropHeight * scale) / 2;
        } else { // 'fitWidth' or 'fitHeight' (current stretching behavior)
          scaleX = targetWidth / cropWidth;
          scaleY = targetHeight / cropHeight;
        }

        const newPage = newPdf.addPage([targetWidth, targetHeight]);
        newPage.drawPage(embeddedPage, {
          x: offsetX,
          y: offsetY,
          xScale: scaleX,
          yScale: scaleY,
        });
      }
      const pdfBytes = await newPdf.save();
      const processedFileName = replaceFilenameTokens(baseFileName.trim() ? baseFileName.trim() : 'output', adj.width, adj.height);
      const savePath = folder.replace(/\/+$/, '') + '/' + processedFileName + '.pdf';

      if (isTauri) {
        await writeBinaryFile({ path: savePath, contents: pdfBytes });
      } else if (dirHandle) {
        // Save using File System Access API
        let targetHandle = dirHandle;
        if (useSubfolder && subfolderName.trim()) {
          targetHandle = await dirHandle.getDirectoryHandle(subfolderName.trim(), { create: true });
        }
        const fileHandle = await targetHandle.getFileHandle(processedFileName + '.pdf', { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(pdfBytes);
        await writable.close();
      } else {
        // Browser fallback: trigger download
        // Use application/octet-stream to force download on iOS/mobile instead of opening preview
        const blob = new Blob([pdfBytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = processedFileName + '.pdf';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 5000);
      }
    }
  };

  // Tauri-based export handler
  const handleSave = async () => {
    if (!file) return;
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

      if (isTauri) {
        if (specifyExportLocation && useSubfolder && subfolderName.trim()) {
          folder = folder.replace(/\/+$/, '') + '/' + subfolderName.trim().replace(/\/+$/, '');
        }

        const filePathsToCheck: string[] = [];
        const proposedFiles: Array<{ fileName: string; isConflict: boolean; shouldOverwrite: boolean; originalPath?: string }> = [];

        for (const adj of adjusters) {
          const processedFileName = replaceFilenameTokens(fileName.trim() ? fileName.trim() : 'output', adj.width, adj.height);
          const savePath = folder.replace(/\/+$/, '') + '/' + processedFileName + '.pdf';
          filePathsToCheck.push(savePath);
          proposedFiles.push({
            fileName: processedFileName + '.pdf',
            isConflict: false,
            shouldOverwrite: true,
            originalPath: savePath,
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
          const proposedFiles: Array<{ fileName: string; isConflict: boolean; shouldOverwrite: boolean }> = [];
          let hasConflicts = false;

          for (const adj of adjusters) {
            const processedFileName = replaceFilenameTokens(fileName.trim() ? fileName.trim() : 'output', adj.width, adj.height);
            const finalName = processedFileName + '.pdf';
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
              shouldOverwrite: true
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
      const pagesToProcess: number[] = pageSelection === 'all'
        ? Array.from({ length: pdfDocRef.current?.numPages || 1 }, (_, i) => i)
        : [currentPage];

      await performSave(folder, adjusters, pagesToProcess, file, fileName, trim, currentPage, pageSelection, dirHandle);
      setSaveStatus('success');
      fadeTimeout.current = setTimeout(() => setSaveStatus('idle'), 5000);

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
      const adjustersToSave = adjusters.filter((_, idx) => conflictFiles[idx].shouldOverwrite);
      const pagesToProcess: number[] = pageSelection === 'all'
        ? Array.from({ length: pdfDocRef.current?.numPages || 1 }, (_, i) => i)
        : [currentPage];

      let folder = exportFolder;
      if (specifyExportLocation && useSubfolder && subfolderName.trim()) {
        folder = folder.replace(/\/+$/, '') + '/' + subfolderName.trim().replace(/\/+$/, '');
      }

      await performSave(folder, adjustersToSave, pagesToProcess, file, fileName, trim, currentPage, pageSelection, exportDirHandle);
      setSaveStatus('success');
      fadeTimeout.current = setTimeout(() => setSaveStatus('idle'), 5000);
      setConflictFiles([]); // Clear conflicts after saving
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
  };

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
      {/* Title: always show in Tauri */}
      <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 32, color: 'var(--text-color)', letterSpacing: 0.5 }}>PDF Resizer</h1>
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
          accept="application/pdf"
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
            {cropOverlay && renderedPdfCssSize && (
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
            {totalPages > 1 && (
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
              onClick={e => { e.stopPropagation(); setFile(null); setFileName(''); setFileSize(null); setPdfSize(null); setTrim(0); setCurrentPage(0); setTotalPages(1); pdfDocRef.current = null; }}
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
              aria-label="Close PDF preview"
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
          <span style={{ color: 'var(--secondary-color)', fontSize: 18, userSelect: 'none' }}>
            Drop PDF here or click to select
          </span>
        )}
      </div>
      {/* Filename under preview: always show originalFileName if file is loaded */}
      {file && originalFileName && (
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
          {originalFileName}
        </div>
      )}
      {file && totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 8, gap: 16 }}>
          <span style={{ color: 'var(--secondary-color)', fontSize: 14 }}>Process:</span>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: 14 }}>
            <input
              type="radio"
              checked={pageSelection === 'single'}
              onChange={() => setPageSelection('single')}
              style={{ marginRight: 4 }}
            />
            Single Page
          </label>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: 14 }}>
            <input
              type="radio"
              checked={pageSelection === 'all'}
              onChange={() => setPageSelection('all')}
              style={{ marginRight: 4 }}
            />
            All Pages
          </label>
        </div>
      )}
      {file && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          maxWidth: 'none',
          margin: '0 auto',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 8, gap: 8, width: '100%' }}>
            {/* Show PDF dimensions if available */}
            <span style={{ color: 'var(--secondary-color)', fontSize: 14 }}>
              {pdfSize ? formatSizePoints(pdfSize.width, pdfSize.height) : ''}
            </span>
            {/* Pinch button, only if trim is 0 */}
            {trim === 0 && (
              <button type="button" onClick={handleSetToPdfDimensions} style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', color: 'var(--secondary-color)', display: 'flex', alignItems: 'center', marginRight: 0 }} title="Reset size adjuster to PDF dimensions">
                <svg width="18" height="14" viewBox="0 0 22.3773 17.8571" style={{ display: 'block' }} xmlns="http://www.w3.org/2000/svg">
                  <g>
                    <rect height="17.8571" opacity="0" width="22.3773" x="0" y="0" />
                    <path d="M2.46305 0.271327C1.35954 1.53109 0.509927 3.07406 0.0314117 4.68539C-0.212729 5.535 1.03727 5.97445 1.33024 4.99789C1.75016 3.59164 2.50211 2.26351 3.47868 1.15023C4.12321 0.417811 3.10758-0.451329 2.46305 0.271327ZM2.46305 14.2362C3.10758 14.9686 4.12321 14.0995 3.47868 13.3573C2.50211 12.2537 1.75016 10.9256 1.33024 9.51937C1.03727 8.53305-0.212729 8.9725 0.0314117 9.83187C0.509927 11.4432 1.35954 12.9862 2.46305 14.2362Z" fill="currentColor" fillOpacity="0.85" />
                    <path d="M14.299 17.6248C17.922 17.6248 22.0138 15.3202 22.0138 10.3104C22.0138 7.89828 20.7443 2.60531 19.1037 2.60531C18.8205 2.60531 18.6252 2.78109 18.6935 2.97641L18.9084 3.61117C19.1037 4.20687 18.342 4.45101 18.1173 3.88461L17.7463 2.97641C17.2091 1.67758 15.9396 1.56039 15.2463 1.87289C15.0705 1.96078 15.0412 2.10726 15.1095 2.22445C15.4318 2.80062 15.6955 3.35726 15.9591 3.93344C16.2521 4.58773 15.3634 5.00766 15.0021 4.3143C14.7775 3.87484 14.4845 3.33773 14.1916 2.97641C13.1173 1.57016 11.2912 1.17953 9.30876 1.69711L6.28141 2.48812C4.29899 3.01547 5.1193 5.36898 6.95524 4.98812L9.90446 4.39242C10.8029 4.20687 11.5744 4.43148 12.0041 4.98812C12.6681 5.8768 13.3517 7.25375 13.3517 8.24984C13.3517 9.63656 12.5119 11.2772 10.7443 11.2772C9.87516 11.2772 8.85954 10.8768 7.87321 9.91L5.96891 8.04476C4.79704 6.89242 2.75602 8.39633 4.10368 9.96859L7.31657 13.7381C9.62126 16.4432 11.9552 17.6248 14.299 17.6248Z" fill="currentColor" fillOpacity="0.85" />
                  </g>
                </svg>
              </button>
            )}
            <span style={{ color: 'var(--secondary-color)', marginLeft: 10, fontSize: 14 }}>Trim:</span>
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
                  if (!isNaN(t) && val !== '' && val !== '.' && val !== ',') {
                    setTrim(t);
                    if (pdfSize && adjusters.length > 0 && (adjusters[0].source === 'pdf' || adjusters[0].source === 'trimmed')) {
                      const trimmedWidth = Math.max(pdfSize.width - 2 * t, 1);
                      const trimmedHeight = Math.max(pdfSize.height - 2 * t, 1);
                      setAdjusters(adjs => [
                        {
                          ...adjs[0],
                          width: Number(trimmedWidth.toFixed(2)),
                          height: Number(trimmedHeight.toFixed(2)),
                          source: 'trimmed',
                        },
                        ...adjs.slice(1)
                      ]);
                    }
                  }
                }
              }}
              onBlur={() => {
                const t = parseTrimInput(trimInput);
                setTrimInput(Number.isFinite(t) ? formatTrim(t) : '');
                if (Number.isFinite(t)) setTrim(t);
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
                  setTrim(next);
                  if (pdfSize && adjusters.length > 0 && (adjusters[0].source === 'pdf' || adjusters[0].source === 'trimmed')) {
                    const trimmedWidth = Math.max(pdfSize.width - 2 * next, 1);
                    const trimmedHeight = Math.max(pdfSize.height - 2 * next, 1);
                    setAdjusters(adjs => [
                      {
                        ...adjs[0],
                        width: Number(trimmedWidth.toFixed(2)),
                        height: Number(trimmedHeight.toFixed(2)),
                        source: 'trimmed',
                      },
                      ...adjs.slice(1)
                    ]);
                  }
                  e.preventDefault();
                }
              }}
              style={{ width: 36, fontSize: 14, padding: '2px 2px', borderRadius: 4, border: '1px solid var(--input-border)', textAlign: 'right', marginRight: 0, background: 'var(--input-bg)', color: 'var(--text-color)' }}
            />
            {/* Show trimmed size and pinch icon only if trim > 0 */}
            {trimmedForAspect && trim > 0 && (
              <>
                <span style={{ color: 'var(--secondary-color)', fontSize: 14 }}>→</span>
                <span style={{ color: 'var(--secondary-color)', fontSize: 14 }}>{formatSizePoints(trimmedForAspect.width, trimmedForAspect.height)}</span>
                <span style={{ display: 'flex', alignItems: 'center', color: 'var(--secondary-color)' }}>
                  <button type="button" onClick={handleSetToTrimmedDimensions} style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', color: 'var(--secondary-color)', display: 'flex', alignItems: 'center' }} title="Reset size adjuster to trimmed dimensions">
                    <svg width="18" height="14" viewBox="0 0 22.3773 17.8571" style={{ display: 'block' }} xmlns="http://www.w3.org/2000/svg">
                      <g>
                        <rect height="17.8571" opacity="0" width="22.3773" x="0" y="0" />
                        <path d="M2.46305 0.271327C1.35954 1.53109 0.509927 3.07406 0.0314117 4.68539C-0.212729 5.535 1.03727 5.97445 1.33024 4.99789C1.75016 3.59164 2.50211 2.26351 3.47868 1.15023C4.12321 0.417811 3.10758-0.451329 2.46305 0.271327ZM2.46305 14.2362C3.10758 14.9686 4.12321 14.0995 3.47868 13.3573C2.50211 12.2537 1.75016 10.9256 1.33024 9.51937C1.03727 8.53305-0.212729 8.9725 0.0314117 9.83187C0.509927 11.4432 1.35954 12.9862 2.46305 14.2362Z" fill="currentColor" fillOpacity="0.85" />
                        <path d="M14.299 17.6248C17.922 17.6248 22.0138 15.3202 22.0138 10.3104C22.0138 7.89828 20.7443 2.60531 19.1037 2.60531C18.8205 2.60531 18.6252 2.78109 18.6935 2.97641L18.9084 3.61117C19.1037 4.20687 18.342 4.45101 18.1173 3.88461L17.7463 2.97641C17.2091 1.67758 15.9396 1.56039 15.2463 1.87289C15.0705 1.96078 15.0412 2.10726 15.1095 2.22445C15.4318 2.80062 15.6955 3.35726 15.9591 3.93344C16.2521 4.58773 15.3634 5.00766 15.0021 4.3143C14.7775 3.87484 14.4845 3.33773 14.1916 2.97641C13.1173 1.57016 11.2912 1.17953 9.30876 1.69711L6.28141 2.48812C4.29899 3.01547 5.1193 5.36898 6.95524 4.98812L9.90446 4.39242C10.8029 4.20687 11.5744 4.43148 12.0041 4.98812C12.6681 5.8768 13.3517 7.25375 13.3517 8.24984C13.3517 9.63656 12.5119 11.2772 10.7443 11.2772C9.87516 11.2772 8.85954 10.8768 7.87321 9.91L5.96891 8.04476C4.79704 6.89242 2.75602 8.39633 4.10368 9.96859L7.31657 13.7381C9.62126 16.4432 11.9552 17.6248 14.299 17.6248Z" fill="currentColor" fillOpacity="0.85" />
                      </g>
                    </svg>
                  </button>
                </span>
              </>
            )}
          </div>
        </div>
      )}
      {file && (
        <div style={{ width: '100%', maxWidth: 400, margin: '32px auto 0 auto' }}>
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
              SwapIcon={ArrowLeftArrowRight}
              RemoveIcon={MinusCircleFill}
              presets={presets}
              onEditPresets={() => setShowPresetsEditor(true)}
            />
          ))}
          <button
            type="button"
            onClick={() => setAdjusters(adjs => {
              const last = adjs[adjs.length - 1];
              return [
                ...adjs,
                { ...last, id: crypto.randomUUID() }
              ];
            })}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, margin: '8px auto 0 auto', background: 'none', border: 'none', color: 'var(--text-color)', fontSize: 16, cursor: 'pointer', fontWeight: 500
            }}
          >
            <PlusCircleFill style={{ width: 20, height: 20, display: 'block', color: 'var(--secondary-color)' }} />
            <span style={{ color: 'var(--text-color)' }}>Add Size</span>
          </button>
        </div>
      )}
      {/* Export options section */}
      {file && (
        <div style={{
          width: 400,
          maxWidth: '100%',
          margin: '24px auto 0 auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
        }}>
          <label
            title={!isTauri ? 'Requires desktop app with Ghostscript installed' :
                   !ghostscriptAvailable ? 'Ghostscript not found. Install with: brew install ghostscript' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              fontWeight: 500,
              fontSize: 16,
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