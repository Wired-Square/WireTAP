// ui/src/apps/discovery/views/tools/SerialFramingToolPanel.tsx
//
// Options panel for Serial Framing Analysis tool in the Toolbox dialog.
// Analyzes raw bytes to detect framing protocol (SLIP, Modbus RTU, delimiters).

import { Alert } from "../../../../components/Alert";

type Props = {
  bytesCount: number;
};

export default function SerialFramingToolPanel({ bytesCount }: Props) {
  return (
    <div className="space-y-3 text-xs">
      <Alert tone="info" size="sm">
        <p className="font-medium">Detect Framing Protocol</p>
        <p className="mt-1">Analyze {bytesCount.toLocaleString()} raw bytes to identify the framing protocol.</p>
      </Alert>
      <p className="text-muted">
        Will test for:
      </p>
      <ul className="text-muted list-disc list-inside space-y-0.5">
        <li>SLIP framing (0xC0 delimiter with escapes)</li>
        <li>Modbus RTU (CRC-16 validation)</li>
        <li>Common delimiters (CRLF, LF, NUL, etc.)</li>
      </ul>
      <p className="text-muted mt-2 italic">
        After detecting framing, apply it to get frames for payload analysis.
      </p>
    </div>
  );
}
