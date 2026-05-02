// ui/src/components/forms/BaudRateSelect.tsx

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Select from './Select';
import Input from './Input';

const STANDARD_RATES = [
  '9600',
  '19200',
  '38400',
  '57600',
  '115200',
  '230400',
  '460800',
  '500000',
  '576000',
  '921600',
  '1000000',
  '1152000',
  '1500000',
  '2000000',
  '3000000',
];

interface BaudRateSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Which rate to label as the default (e.g. "115200") */
  defaultRate?: string;
  /** Text appended to the default rate label (e.g. "default for CANable") */
  defaultLabel?: string;
  variant?: 'default' | 'simple';
}

export default function BaudRateSelect({
  value,
  onChange,
  defaultRate = '115200',
  defaultLabel,
  variant = 'default',
}: BaudRateSelectProps) {
  const { t } = useTranslation('common');
  const isStandard = STANDARD_RATES.includes(value);
  const [customMode, setCustomMode] = useState(!isStandard && value !== '');

  // If the value changes externally to a non-standard rate, switch to custom mode
  useEffect(() => {
    if (value && !STANDARD_RATES.includes(value)) {
      setCustomMode(true);
    }
  }, [value]);

  if (customMode) {
    return (
      <div className="flex gap-2">
        <Input
          variant={variant}
          type="number"
          min="1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('baudRate.placeholder')}
        />
        <button
          type="button"
          onClick={() => {
            setCustomMode(false);
            // If the current value isn't a standard rate, reset to default
            if (!STANDARD_RATES.includes(value)) {
              onChange(defaultRate);
            }
          }}
          className="shrink-0 px-3 text-sm text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors"
          title={t('baudRate.switchBack')}
        >
          {t('baudRate.presets')}
        </button>
      </div>
    );
  }

  return (
    <Select
      variant={variant}
      value={value}
      onChange={(e) => {
        if (e.target.value === '__custom__') {
          setCustomMode(true);
        } else {
          onChange(e.target.value);
        }
      }}
    >
      {STANDARD_RATES.map((rate) => (
        <option key={rate} value={rate}>
          {rate}
          {rate === defaultRate && defaultLabel ? ` (${defaultLabel})` : ''}
        </option>
      ))}
      <option value="__custom__">{t('baudRate.custom')}</option>
    </Select>
  );
}
