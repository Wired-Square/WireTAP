// ui/src/apps/discovery/views/tools/SerialPayloadToolPanel.tsx
//
// Options panel for Serial Payload Analysis tool in the Toolbox dialog.
// Analyzes framed data to identify ID bytes and checksum positions.

type Props = {
  framesCount: number;
};

export default function SerialPayloadToolPanel({ framesCount }: Props) {
  return (
    <div className="space-y-3 text-xs">
      <div className="bg-[var(--status-success-bg)] border border-[color:var(--status-success-border)] rounded p-2">
        <p className="text-[color:var(--status-success-text)] font-medium">
          Analyze Frame Structure
        </p>
        <p className="text-[color:var(--text-green)] mt-1">
          Analyze {framesCount.toLocaleString()} frames to identify payload structure.
        </p>
      </div>
      <p className="text-[color:var(--text-muted)]">
        Will identify:
      </p>
      <ul className="text-[color:var(--text-muted)] list-disc list-inside space-y-0.5">
        <li>Candidate ID byte positions (frame type identifiers)</li>
        <li>Candidate source address positions</li>
        <li>Candidate checksum positions and algorithms</li>
      </ul>
      <p className="text-[color:var(--text-muted)] mt-2 italic">
        Works best with structured protocol frames.
      </p>
    </div>
  );
}
