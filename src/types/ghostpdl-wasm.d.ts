declare module '@okathira/ghostpdl-wasm' {
  interface GhostscriptFileSystem {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  }

  interface GhostscriptModule {
    readonly FS: GhostscriptFileSystem;
    callMain(args: string[]): number;
  }

  interface GhostscriptModuleOptions {
    locateFile?(fileName: string, prefix?: string): string;
  }

  export default function createGhostscript(options?: GhostscriptModuleOptions): Promise<GhostscriptModule>;
}
