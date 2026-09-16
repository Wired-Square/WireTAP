// ui/src/apps/discovery/views/tools/SerialFramingToolPanel.tsx
//
// Options panel for Serial Framing Analysis tool in the Toolbox dialog.
// Analyzes raw bytes to detect framing protocol (SLIP, Modbus RTU, delimiters).

type Props = {
  bytesCount: number;
};

export default function SerialFramingToolPanel({ bytesCount }: Props) {
  return (
    <div className="space-y-3 text-xs">
      <div className="bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)] rounded p-2">
        <p className="text-[color:var(--status-info-text)] font-medium">
          Detect Framing Protocol
        </p>
        <p className="text-[color:var(--status-info-text)] mt-1">
          Analyze {bytesCount.toLocaleString()} raw bytes to identify the framing protocol.
        </p>
      </div>
      <p className="text-[color:var(--text-muted)]">
        Will test for:
      </p>
      <ul className="text-[color:var(--text-muted)] list-disc list-inside space-y-0.5">
        <li>SLIP framing (0xC0 delimiter with escapes)</li>
        <li>Modbus RTU (CRC-16 validation)</li>
        <li>Common delimiters (CRLF, LF, NUL, etc.)</li>
      </ul>
      <p className="text-[color:var(--text-muted)] mt-2 italic">
        After detecting framing, apply it to get frames for payload analysis.
      </p>
    </div>
  );
}
