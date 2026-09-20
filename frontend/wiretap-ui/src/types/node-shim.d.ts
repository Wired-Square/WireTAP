// Minimal Node type shims to satisfy tests without @types/node.

declare const __dirname: string;

declare module "node:fs" {
  export function readFileSync(path: string | Buffer | URL, options?: any): any;
  export function readdirSync(path: string): string[];
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
}
