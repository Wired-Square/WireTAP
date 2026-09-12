// ui/src/components/MessageBytes.tsx
//
// The bytes of one frame as hex, the one way both Discovery's tables and the
// Decoder's lists show them. A whole Modbus RTU message ends in its CRC; the two
// bytes are set apart so the body reads as the message and the check as the
// check. An incomplete serial frame reads in the warning colour.

import { textDataGreen, textDataOrange, textDataTertiary } from '../styles';

type Props = {
  bytes: number[];
  /** Pre-computed hex, when the caller already has it. */
  hexBytes?: string[];
  protocol?: string;
  incomplete?: boolean;
  /** Colour for the body; defaults to the data green. */
  className?: string;
};

export default function MessageBytes({ bytes, hexBytes, protocol, incomplete, className }: Props) {
  const hex = hexBytes ?? bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase());
  const body = className ?? (incomplete ? textDataOrange : textDataGreen);
  if (protocol === 'modbus_rtu' && hex.length >= 4) {
    return (
      <span className={`break-all ${body}`}>
        {hex.slice(0, -2).join(' ')}
        <span className={`ml-2 ${textDataTertiary}`}>{hex.slice(-2).join(' ')}</span>
      </span>
    );
  }
  return <span className={`break-all ${body}`}>{hex.join(' ')}</span>;
}
