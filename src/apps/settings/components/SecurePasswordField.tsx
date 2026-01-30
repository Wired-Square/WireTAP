// ui/src/apps/settings/components/SecurePasswordField.tsx
import { useState } from "react";
import { Shield, ShieldAlert, Eye, EyeOff } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../../styles/spacing";
import { Input } from "../../../components/forms";
import { labelDefault, helpText, alertWarning, hoverLight, roundedDefault } from "../../../styles";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** True if password is securely stored in system keyring */
  isSecurelyStored: boolean;
  /** True if there's a legacy plaintext password that needs migration */
  hasLegacyPassword: boolean;
  /** Called when user clicks migrate button */
  onMigrate?: () => void;
  placeholder?: string;
  label?: string;
  optional?: boolean;
};

export default function SecurePasswordField({
  value,
  onChange,
  isSecurelyStored,
  hasLegacyPassword,
  onMigrate,
  placeholder = "",
  label = "Password",
  optional = false,
}: Props) {
  const [showPassword, setShowPassword] = useState(false);

  // Determine the display state
  const hasStoredPassword = isSecurelyStored && !value;
  const showMigrationWarning = hasLegacyPassword && !isSecurelyStored;

  return (
    <div>
      <label className={`${labelDefault} mb-2`}>
        {label} {optional && <span className="text-slate-500">(optional)</span>}
        {isSecurelyStored && (
          <span className="ml-2 inline-flex items-center gap-1 text-xs text-[color:var(--accent-success)]">
            <Shield className={iconXs} />
            Secure
          </span>
        )}
      </label>

      {showMigrationWarning && (
        <div className={`${alertWarning} mb-2 flex items-center justify-between gap-2`}>
          <div className={flexRowGap2}>
            <ShieldAlert className={`${iconMd} flex-shrink-0`} />
            <span className="text-xs">
              Password stored in plain text. Migrate to secure storage.
            </span>
          </div>
          {onMigrate && (
            <button
              type="button"
              onClick={onMigrate}
              className={`px-2 py-1 text-xs bg-amber-600 text-white ${roundedDefault} hover:bg-amber-700 transition-colors flex-shrink-0`}
            >
              Migrate
            </button>
          )}
        </div>
      )}

      <div className="relative">
        <Input
          variant="default"
          type={showPassword ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={hasStoredPassword ? "••••••••••••" : placeholder}
          className={`pr-10 ${
            hasStoredPassword
              ? "border-[color:var(--border-success)] placeholder-[color:var(--accent-success)]"
              : ""
          }`}
        />
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 ${hoverLight} ${roundedDefault} text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]`}
          title={showPassword ? "Hide password" : "Show password"}
        >
          {showPassword ? (
            <EyeOff className={iconMd} />
          ) : (
            <Eye className={iconMd} />
          )}
        </button>
      </div>

      {hasStoredPassword && (
        <p className={`mt-1 ${helpText} text-[color:var(--accent-success)]`}>
          Password stored in system keychain. Leave empty to keep current password.
        </p>
      )}
    </div>
  );
}
