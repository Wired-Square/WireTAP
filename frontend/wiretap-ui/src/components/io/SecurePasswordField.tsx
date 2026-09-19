// ui/src/apps/settings/components/SecurePasswordField.tsx
import { useState } from "react";
import { Shield, ShieldAlert, Eye, EyeOff } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../styles/spacing";
import { Input } from "../../components/forms";
import { labelDefault, helpText, alertWarning } from "../../styles";
import { Button, IconButton } from "../Button";

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
            <Button
              onClick={onMigrate}
              variant="solid"
              tone="warning"
              size="sm"
            >
              Migrate
            </Button>
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
        <IconButton
          onClick={() => setShowPassword(!showPassword)}
          size="sm"
          className="absolute right-2 top-1/2 -translate-y-1/2"
          title={showPassword ? "Hide password" : "Show password"}
        >
          {showPassword ? (
            <EyeOff className={iconMd} />
          ) : (
            <Eye className={iconMd} />
          )}
        </IconButton>
      </div>

      {hasStoredPassword && (
        <p className={`mt-1 ${helpText} text-[color:var(--accent-success)]`}>
          Password stored in system keychain. Leave empty to keep current password.
        </p>
      )}
    </div>
  );
}
