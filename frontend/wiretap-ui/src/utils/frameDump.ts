// ui/src/utils/frameDump.ts

import { formatFilenameDate } from "./timeFormat";

/**
 * The CSV columns are SavvyCAN's and carry no protocol, so the file name does:
 * the CSV importer seeds its protocol from the stem's last `-` token.
 */
export function frameExportBasename(protocol: string | undefined, date: Date = new Date()): string {
  return `${formatFilenameDate(date)}-${protocol ?? "frames"}`;
}
