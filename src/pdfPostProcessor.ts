import { invoke } from '@tauri-apps/api/core';
import {
  parseCmykEdgeSamples,
  type CmykEdgeSampleRequest,
  type CmykEdgeSamples,
} from './pdfVectorPadding';

export interface PdfPostProcessor {
  outlineText(pdf: ArrayBuffer, pageNumbers: readonly number[]): Promise<ArrayBuffer>;
  rasterizePdf(pdf: ArrayBuffer, dpi: number): Promise<ArrayBuffer>;
  renderCmykEdges(
    pdf: ArrayBuffer,
    pageNumber: number,
    request: CmykEdgeSampleRequest,
    outputIccProfile?: Uint8Array,
  ): Promise<CmykEdgeSamples>;
  dispose(): void;
}

interface OutlineRequest {
  readonly kind: 'outline';
  readonly pdf: ArrayBuffer;
  readonly pageNumbers: readonly number[];
}

interface RasterizeRequest {
  readonly kind: 'rasterize';
  readonly pdf: ArrayBuffer;
  readonly dpi: number;
}

interface EdgeRequest {
  readonly kind: 'edges';
  readonly pdf: ArrayBuffer;
  readonly pageNumber: number;
  readonly request: CmykEdgeSampleRequest;
  readonly outputIccProfile?: ArrayBuffer;
}

type WorkerRequestPayload = OutlineRequest | RasterizeRequest | EdgeRequest;

interface WorkerRequest {
  readonly id: number;
  readonly payload: WorkerRequestPayload;
}

interface WorkerSuccess {
  readonly id: number;
  readonly ok: true;
  readonly result: ArrayBuffer | CmykEdgeSamples;
}

interface WorkerFailure {
  readonly id: number;
  readonly ok: false;
  readonly message: string;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!value || typeof value !== 'object' || !('id' in value) || !Number.isInteger(value.id)) {
    return false;
  }
  if (!('ok' in value) || typeof value.ok !== 'boolean') return false;
  return value.ok
    ? 'result' in value
    : 'message' in value && typeof value.message === 'string';
}

function arrayBufferResult(value: ArrayBuffer | CmykEdgeSamples, operation: string): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) {
    throw new Error(`Ghostscript returned an invalid ${operation} result.`);
  }
  return value;
}

export class TauriPdfPostProcessor implements PdfPostProcessor {
  async outlineText(pdf: ArrayBuffer, pageNumbers: readonly number[]): Promise<ArrayBuffer> {
    const bytes = await invoke<number[]>('flatten_pdf', {
      pdfBytes: Array.from(new Uint8Array(pdf)),
      pageNumbers,
    });
    return new Uint8Array(bytes).buffer;
  }

  async rasterizePdf(pdf: ArrayBuffer, dpi: number): Promise<ArrayBuffer> {
    const bytes = await invoke<number[]>('rasterize_pdf', {
      pdfBytes: Array.from(new Uint8Array(pdf)),
      dpi,
    });
    return new Uint8Array(bytes).buffer;
  }

  async renderCmykEdges(
    pdf: ArrayBuffer,
    pageNumber: number,
    request: CmykEdgeSampleRequest,
    _outputIccProfile?: Uint8Array,
  ): Promise<CmykEdgeSamples> {
    const result: unknown = await invoke('render_pdf_page_cmyk_edges', {
      pdfBytes: Array.from(new Uint8Array(pdf)),
      pageNumber,
      ...request,
    });
    return parseCmykEdgeSamples(result);
  }

  dispose(): void {}
}

const WORKER_REQUEST_TIMEOUT_MS = 90_000;

export class BrowserPdfPostProcessor implements PdfPostProcessor {
  private nextRequestId = 1;
  private disposed = false;
  private requestQueue: Promise<void> = Promise.resolve();
  private activeWorker: Worker | null = null;
  private activeReject: ((error: Error) => void) | null = null;

  async outlineText(pdf: ArrayBuffer, pageNumbers: readonly number[]): Promise<ArrayBuffer> {
    const result = await this.request({ kind: 'outline', pdf, pageNumbers });
    return arrayBufferResult(result, 'outlined PDF');
  }

  async rasterizePdf(pdf: ArrayBuffer, dpi: number): Promise<ArrayBuffer> {
    const result = await this.request({ kind: 'rasterize', pdf, dpi });
    return arrayBufferResult(result, 'rasterized PDF');
  }

  async renderCmykEdges(
    pdf: ArrayBuffer,
    pageNumber: number,
    request: CmykEdgeSampleRequest,
    outputIccProfile?: Uint8Array,
  ): Promise<CmykEdgeSamples> {
    const result = await this.request({
      kind: 'edges',
      pdf,
      pageNumber,
      request,
      ...(outputIccProfile ? { outputIccProfile: transferableCopy(outputIccProfile) } : {}),
    });
    if (result instanceof ArrayBuffer) {
      throw new Error('Ghostscript returned PDF bytes instead of CMYK edge samples.');
    }
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.activeWorker?.terminate();
    this.activeWorker = null;
    this.activeReject?.(new Error('Ghostscript processing was cancelled.'));
    this.activeReject = null;
  }

  private request(payload: WorkerRequestPayload): Promise<ArrayBuffer | CmykEdgeSamples> {
    const queued = this.requestQueue.then(() => this.runRequest(payload));
    // A failed job must not block a later export from getting its own clean worker.
    this.requestQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private runRequest(payload: WorkerRequestPayload): Promise<ArrayBuffer | CmykEdgeSamples> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('Ghostscript processing was cancelled.'));
        return;
      }
      const worker = new Worker(new URL('./pdfPostProcessor.worker.ts', import.meta.url), {
        type: 'module',
      });
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (error: Error | null, result?: ArrayBuffer | CmykEdgeSamples) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        worker.terminate();
        if (this.activeWorker === worker) {
          this.activeWorker = null;
          this.activeReject = null;
        }
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error('Ghostscript worker returned no result.'));
      };
      timeout = setTimeout(() => {
        finish(new Error('Ghostscript stopped responding. The processor was restarted; please export again.'));
      }, WORKER_REQUEST_TIMEOUT_MS);
      this.activeWorker = worker;
      this.activeReject = error => finish(error);
      worker.addEventListener('error', event => {
        finish(new Error(event.message || 'Ghostscript worker failed.'));
      });
      worker.addEventListener('messageerror', () => {
        finish(new Error('Ghostscript worker sent an unreadable response.'));
      });
      worker.addEventListener('message', event => {
        const value: unknown = event.data;
        if (!isWorkerResponse(value) || value.id !== id) return;
        finish(value.ok ? null : new Error(value.message), value.ok ? value.result : undefined);
      });
      const workerPayload = copyPayloadForWorker(payload);
      const message: WorkerRequest = { id, payload: workerPayload };
      const transfer = [workerPayload.pdf];
      if (workerPayload.kind === 'edges' && workerPayload.outputIccProfile) {
        transfer.push(workerPayload.outputIccProfile);
      }
      worker.postMessage(message, transfer);
    });
  }
}

function copyPayloadForWorker(payload: WorkerRequestPayload): WorkerRequestPayload {
  switch (payload.kind) {
    case 'outline':
      return { kind: 'outline', pdf: payload.pdf.slice(0), pageNumbers: [...payload.pageNumbers] };
    case 'rasterize':
      return { kind: 'rasterize', pdf: payload.pdf.slice(0), dpi: payload.dpi };
    case 'edges':
      return {
        kind: 'edges',
        pdf: payload.pdf.slice(0),
        pageNumber: payload.pageNumber,
        request: payload.request,
        ...(payload.outputIccProfile ? { outputIccProfile: payload.outputIccProfile.slice(0) } : {}),
      };
    default: {
      const exhaustive: never = payload;
      throw new Error(`Unsupported Ghostscript request: ${String(exhaustive)}.`);
    }
  }
}

function transferableCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
