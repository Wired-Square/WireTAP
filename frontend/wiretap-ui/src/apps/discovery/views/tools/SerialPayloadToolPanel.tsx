// ui/src/apps/discovery/views/tools/SerialPayloadToolPanel.tsx
//
// Options panel for Serial Payload Analysis tool in the Toolbox dialog.
// Analyzes framed data to identify ID bytes and checksum positions.

import { Alert } from "../../../../components/Alert";

type Props = {
  framesCount: number;
};

export default function SerialPayloadToolPanel({ framesCount }: Props) {
  return (
    <div className="space-y-3 text-xs">
      <Alert tone="success" size="sm">
        <p className="font-medium">Analyze Frame Structure</p>
        <p className="mt-1">Analyze {framesCount.toLocaleString()} frames to identify payload structure.</p>
      </Alert>
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
