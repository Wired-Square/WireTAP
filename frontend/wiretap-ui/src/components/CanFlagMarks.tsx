import { Badge } from "./Badge";
import { textMuted } from "../styles";

export function RemoteRequest({ dlc }: { dlc?: number }) {
  return <span className={textMuted}>{`Remote request for ${dlc} ${dlc === 1 ? "byte" : "bytes"}`}</span>;
}

export function CanFlagBadges({ brs, esi }: { brs?: boolean; esi?: boolean }) {
  return (
    <>
      {brs && <Badge size="sm" tone="cyan" className="ml-2" title="Bit rate switch">BRS</Badge>}
      {esi && <Badge size="sm" tone="warning" className="ml-2" title="Error state indicator: the sender is error passive">ESI</Badge>}
    </>
  );
}
