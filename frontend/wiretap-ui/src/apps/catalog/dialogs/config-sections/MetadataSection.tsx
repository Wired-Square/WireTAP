// ui/src/apps/catalog/dialogs/config-sections/MetadataSection.tsx
// Catalog metadata section for unified config dialog

import { useTranslation } from "react-i18next";
import { textMedium } from "../../../../styles";
import { Input } from "../../../../components/forms";

export type MetadataSectionProps = {
  name: string;
  setName: (name: string) => void;
  version: number;
  setVersion: (version: number) => void;
};

export default function MetadataSection({
  name,
  setName,
  version,
  setVersion,
}: MetadataSectionProps) {
  const { t } = useTranslation("catalog");
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-primary uppercase tracking-wide">
        {t("configSections.metadata")}
      </h3>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={`block ${textMedium} mb-2`}>
            {t("configSections.name")} <span className="text-danger">*</span>
          </label>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            size="lg"
            placeholder={t("configSections.namePlaceholder")}
          />
        </div>
        <div>
          <label className={`block ${textMedium} mb-2`}>
            {t("configSections.version")} <span className="text-danger">*</span>
          </label>
          <Input
            type="number"
            min={1}
            value={version || ""}
            onChange={(e) => {
              const val = e.target.value;
              setVersion(val === "" ? 0 : parseInt(val));
            }}
            size="lg"
            aria-invalid={!version || version < 1}
            placeholder="1"
          />
        </div>
      </div>
    </div>
  );
}
