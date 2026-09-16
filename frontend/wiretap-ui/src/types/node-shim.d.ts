// Minimal Node type shims to satisfy tests without @types/node.

declare const __dirname: string;

declare module "node:fs" {
  export function readFileSync(path: string | Buffer | URL, options?: any): any;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}
