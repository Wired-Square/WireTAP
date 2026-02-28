// ui/src/apps/discovery/views/tools/ModbusScanResultView.tsx

import { X } from "lucide-react";
import type { ModbusScanResults } from "../../../../stores/discoveryToolboxStore";
import { bgDataView, textMuted, textPrimary, textSecondary, borderDefault } from "../../../../styles";
import { iconSm } from "../../../../styles/spacing";
import { bytesToHex } from "../../../../utils/byteUtils";

type Props = {
  results: ModbusScanResults;
  onClose: () => void;
  onCancel?: () => void;
};

export default function ModbusScanResultView({ results, onClose, onCancel }: Props) {
  const { frames, scanType, isScanning, progress, deviceInfo } = results;
  const hasDeviceInfo = deviceInfo.size > 0;

  return (
    <div className={`flex flex-col h-full ${bgDataView}`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${borderDefault}`}>
        <div className="flex items-center gap-3">
          <h3 className={`text-sm font-medium ${textPrimary}`}>
            {scanType === 'register' ? 'Register Scan' : 'Unit ID Scan'}
          </h3>
          {isScanning && progress && (
            <span className={`text-xs ${textMuted}`}>
              Scanning {progress.current}/{progress.total} — {progress.found_count} found
            </span>
          )}
          {!isScanning && (
            <span className={`text-xs ${textMuted}`}>
              {frames.length} {scanType === 'register' ? 'register' : 'device'}{frames.length !== 1 ? 's' : ''} found
              {hasDeviceInfo && ` (${deviceInfo.size} identified via FC43)`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isScanning && onCancel && (
            <button
              onClick={onCancel}
              className="px-2 py-0.5 rounded text-xs hover:bg-red-600 hover:text-white transition-colors text-[color:var(--text-muted)]"
            >
              Cancel
            </button>
          )}
          {!isScanning && (
            <button onClick={onClose} className={`${textMuted} hover:${textPrimary}`} title="Close">
              <X className={iconSm} />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {isScanning && progress && (
        <div className="h-1 bg-[var(--bg-surface)]">
          <div
            className="h-full bg-purple-500 transition-all duration-200"
            style={{ width: `${(progress.current / progress.total) * 100}%` }}
          />
        </div>
      )}

      {/* Results table */}
      <div className="flex-1 overflow-auto">
        {frames.length === 0 ? (
          <div className={`flex items-center justify-center h-full text-sm ${textMuted}`}>
            {isScanning ? 'Scanning...' : 'No results found'}
          </div>
        ) : scanType === 'unit-id' ? (
          /* Unit ID scan table — shows device identification when available */
          <table className="w-full text-xs">
            <thead className={`sticky top-0 ${bgDataView}`}>
              <tr className={`border-b ${borderDefault}`}>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>#</th>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>Unit ID</th>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>Vendor</th>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>Product</th>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>Revision</th>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>Data</th>
              </tr>
            </thead>
            <tbody>
              {frames.map((frame, i) => {
                const info = deviceInfo.get(frame.bus);
                return (
                  <tr
                    key={`${frame.frame_id}-${frame.bus}-${i}`}
                    className={`border-b border-[color:var(--border-default)]/30 hover:bg-[var(--bg-surface)]`}
                  >
                    <td className={`px-4 py-1 ${textMuted} font-mono`}>{i + 1}</td>
                    <td className={`px-4 py-1 ${textSecondary} font-mono`}>{frame.bus}</td>
                    <td className={`px-4 py-1 ${textPrimary}`}>{info?.vendor ?? '—'}</td>
                    <td className={`px-4 py-1 ${textSecondary}`}>{info?.product_code ?? '—'}</td>
                    <td className={`px-4 py-1 ${textMuted}`}>{info?.revision ?? '—'}</td>
                    <td className={`px-4 py-1 ${textMuted} font-mono`}>
                      {frame.bytes.length > 0 ? bytesToHex(frame.bytes) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          /* Register scan table */
          <table className="w-full text-xs">
            <thead className={`sticky top-0 ${bgDataView}`}>
              <tr className={`border-b ${borderDefault}`}>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>#</th>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>Register</th>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>Length</th>
                <th className={`text-left px-4 py-1.5 ${textMuted} font-medium`}>Data</th>
              </tr>
            </thead>
            <tbody>
              {frames.map((frame, i) => (
                <tr
                  key={`${frame.frame_id}-${frame.bus}-${i}`}
                  className={`border-b border-[color:var(--border-default)]/30 hover:bg-[var(--bg-surface)]`}
                >
                  <td className={`px-4 py-1 ${textMuted} font-mono`}>{i + 1}</td>
                  <td className={`px-4 py-1 ${textPrimary} font-mono`}>{frame.frame_id}</td>
                  <td className={`px-4 py-1 ${textMuted} font-mono`}>{frame.bytes.length}</td>
                  <td className={`px-4 py-1 ${textMuted} font-mono`}>
                    {bytesToHex(frame.bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
