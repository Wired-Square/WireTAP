// ui/src/components/MessageBytes.tsx
//
// The bytes of one frame as hex, the one way both Discovery's tables and the
// Decoder's lists show them. A whole message ends in its check; those bytes are
// set apart so the body reads as the message and the check as the check.

import { textDataGreen, textDataTertiary } from '../styles';
import { byteToHex } from '../utils/byteUtils';
import { trailingCheckBytes } from '../utils/profileTraits';

type Props = {
  bytes: number[];
  /** Pre-computed hex, when the caller already has it. */
  hexBytes?: string[];
  protocol?: string;
  /** Colour for the body; defaults to the data green. */
  className?: string;
};

export default function MessageBytes({ bytes, hexBytes, protocol, className = textDataGreen }: Props) {
  const hex = hexBytes ?? bytes.map(byteToHex);
  const check = trailingCheckBytes(protocol);
  if (check > 0 && hex.length > check + 1) {
    return (
      <span className={`break-all ${className}`}>
        {hex.slice(0, -check).join(' ')}
        <span className={`ml-2 ${textDataTertiary}`}>{hex.slice(-check).join(' ')}</span>
      </span>
    );
  }
  return <span className={`break-all ${className}`}>{hex.join(' ')}</span>;
}
