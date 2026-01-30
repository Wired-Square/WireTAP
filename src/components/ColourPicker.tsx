// ui/src/components/ColourPicker.tsx

type ColourPickerProps = {
  label: string;
  value: string;
  onChange: (val: string) => void;
};

export default function ColourPicker({ label, value, onChange }: ColourPickerProps) {
  return (
    <label
      className="flex items-center gap-3 text-sm"
      style={{ color: 'var(--text-primary)' }}
    >
      <span className="w-28">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-12 cursor-pointer bg-transparent border border-[color:var(--border-default)] rounded"
      />
      <span
        className="text-xs font-mono"
        style={{ color: 'var(--text-secondary)' }}
      >
        {value}
      </span>
    </label>
  );
}
