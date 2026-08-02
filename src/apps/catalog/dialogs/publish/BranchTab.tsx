// ui/src/apps/catalog/dialogs/publish/BranchTab.tsx
//
// Where the commit lands, and whether it becomes a pull request.
//
// This was a collapsed `<details>`, which is exactly why it is now a tab: ticking
// "open a pull request" in here can disable the Push button, and a control that
// gates the primary action should not be one someone has to know to unfold.

import { useId } from "react";
import { textMedium } from "../../../../styles";
import { helpText } from "../../../../styles/inputStyles";
import { CheckboxField, FormField, Input, Textarea } from "../../../../components/forms";
import type { PublishPlan } from "../../../../api/catalogShare";
import { tabScroll } from "./parts";
import type { BranchForm, T } from "./types";

type Props = {
  t: T;
  plan: PublishPlan;
  form: BranchForm;
  onChange: <K extends keyof BranchForm>(key: K, value: BranchForm[K]) => void;
  /** A push in flight no longer reads any of this. */
  disabled: boolean;
};

export default function BranchTab({ t, plan, form, onChange, disabled }: Props) {
  const branchListId = useId();
  const hasBranches = plan.branches.length > 0;

  return (
    <div className={tabScroll}>
      <FormField label={t("publish.pathLabel")}>
        <Input
          value={form.targetPath}
          onChange={(e) => onChange("targetPath", e.target.value)}
          disabled={disabled}
        />
      </FormField>

      {/* Free text with suggestions, not a picker: naming a *new* branch is the
          primary use, and a select would make the common case impossible. The
          suggestions come from the local clone, so they cost nothing.

          Never prefilled. An empty field means "the base branch", and filling it in
          would silently turn the default direct push into an explicit branch name. */}
      <FormField label={t("publish.branchLabel")}>
        <Input
          value={form.branch}
          onChange={(e) => onChange("branch", e.target.value)}
          placeholder={form.openPr ? plan.suggestedBranch : plan.baseBranch}
          list={hasBranches ? branchListId : undefined}
          disabled={disabled}
        />
      </FormField>
      {hasBranches && (
        <datalist id={branchListId}>
          {plan.branches.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
      <p className={helpText}>
        {t("publish.branchHelp", { branch: plan.baseBranch })}
        {hasBranches && ` ${t("publish.branchPickerHint")}`}
      </p>

      <CheckboxField
        checked={form.openPr}
        onChange={(v) => onChange("openPr", v)}
        label={t("publish.openPrLabel")}
        labelClass={textMedium}
        disabled={disabled}
      />

      {form.openPr && (
        <>
          <FormField label={t("publish.prTitleLabel")}>
            <Input
              value={form.prTitle}
              onChange={(e) => onChange("prTitle", e.target.value)}
              disabled={disabled}
            />
          </FormField>
          <FormField label={t("publish.prBodyLabel")}>
            <Textarea
              value={form.prBody}
              onChange={(e) => onChange("prBody", e.target.value)}
              rows={4}
              disabled={disabled}
            />
          </FormField>
          <CheckboxField
            checked={form.draft}
            onChange={(v) => onChange("draft", v)}
            label={t("publish.draft")}
            disabled={disabled}
          />
        </>
      )}
    </div>
  );
}
