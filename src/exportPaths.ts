export type ImportOrigin =
  | { kind: 'browser' }
  | { kind: 'desktop'; directory: string };

export type NativeFileError = {
  code: string;
  message: string;
  path?: string;
};

export function initialExportDirectory(origin: ImportOrigin): string {
  return origin.kind === 'desktop' ? origin.directory : '';
}

export function selectedSubfolder(enabled: boolean, value: string): string | null {
  if (!enabled) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function nativeErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = Reflect.get(error, 'message');
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (typeof error === 'string' && error.trim()) return error;
  return 'The destination could not be accessed.';
}
