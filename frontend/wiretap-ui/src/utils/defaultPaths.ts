// ui/src/utils/defaultPaths.ts
// Cross-platform default directory utilities using Tauri path API

import { documentDir, join } from '@tauri-apps/api/path';
import { createDirectory } from '../api/settings';

const WIRETAP_DIR = 'WireTAP';

export type DefaultDirType = 'decoders' | 'dumps' | 'reports';

const DIR_NAMES: Record<DefaultDirType, string> = {
  decoders: 'Decoders',
  dumps: 'Dumps',
  reports: 'Reports',
};

/**
 * Get the default directory path for a given type.
 * Returns: ~/Documents/WireTAP/{Decoders|Dumps|Reports}
 *
 * Cross-platform:
 * - macOS: /Users/<user>/Documents/WireTAP/...
 * - Windows: C:\Users\<user>\Documents\WireTAP\...
 * - Linux: /home/<user>/Documents/WireTAP/...
 */
export async function getDefaultDir(type: DefaultDirType): Promise<string> {
  const docDir = await documentDir();
  return join(docDir, WIRETAP_DIR, DIR_NAMES[type]);
}

/**
 * Get the WireTAP base directory in Documents
 */
export async function getWiretapBaseDir(): Promise<string> {
  const docDir = await documentDir();
  return join(docDir, WIRETAP_DIR);
}

/**
 * Get all default directories
 */
export async function getAllDefaultDirs(): Promise<Record<DefaultDirType, string>> {
  const docDir = await documentDir();
  const baseDir = await join(docDir, WIRETAP_DIR);

  return {
    decoders: await join(baseDir, DIR_NAMES.decoders),
    dumps: await join(baseDir, DIR_NAMES.dumps),
    reports: await join(baseDir, DIR_NAMES.reports),
  };
}

/**
 * Get all default directories and create them if they don't exist.
 * This should be called when using defaults for empty settings.
 */
export async function getOrCreateDefaultDirs(): Promise<Record<DefaultDirType, string>> {
  const dirs = await getAllDefaultDirs();

  // Create all directories (create_dir_all is idempotent - won't error if exists)
  await Promise.all([
    createDirectory(dirs.decoders),
    createDirectory(dirs.dumps),
    createDirectory(dirs.reports),
  ]);

  return dirs;
}
