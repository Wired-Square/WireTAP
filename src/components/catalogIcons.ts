// ui/src/components/catalogIcons.ts
//
// The catalogue-sharing icon vocabulary — every glyph the journey uses, in one file.
//
// ## One family per axis
//
// A glyph answers either *where things stand* or *what this button does*, never both.
// That rule exists because it was broken: the "Local ahead" status and the "Push"
// action were literally the same component — lucide re-exports `UploadCloud` as an
// alias of `CloudUpload`, so the two names made a total on-screen collision invisible
// to grep. On a settings row the pill said "Local ahead" while the ⋮ menu offered
// "Push local changes…" under the same picture.
//
// Both tables live in this one file on purpose: the collision happened because there
// was nowhere the two vocabularies were visible at once. The section rules below say
// which family owns which axis. `src/tests/catalogIcons.test.ts` asserts no two names
// resolve to one glyph — the only check that can see through a lucide alias.
//
// `Alert`, `Success` and `Busy` are entirely generic and carry most of the traffic
// here; they are the entries to promote first if this ever becomes an app-wide
// vocabulary. Note `apps/dashboard/widgets/lucideByName.ts` is a separate, data-keyed
// registry — not a competing home for these.

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bookmark,
  CircleCheck,
  CircleDashed,
  CloudDownload,
  CloudUpload,
  Copy,
  FileDiff,
  FilePlus,
  FileX,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Github,
  GitPullRequestArrow,
  HardDrive,
  Import,
  Info,
  LoaderCircle,
  Pencil,
  Radio,
  RefreshCw,
  ShieldAlert,
  Star,
  Trash2,
  TriangleAlert,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import type { CatalogSyncStatus } from "../api/catalogShare";
import {
  badgeSmallDanger,
  badgeSmallInfo,
  badgeSmallNeutral,
  badgeSmallSuccess,
  badgeSmallWarning,
} from "../styles/badgeStyles";
import {
  textDanger,
  textInfo,
  textMuted,
  textSuccess,
  textWarning,
} from "../styles/colourTokens";

/**
 * State — how a catalogue stands against its repository. Arrows, because that is what
 * "ahead" and "behind" mean, and because the action vocabulary below owns the clouds.
 *
 * Icon, glyph colour and pill class together: the one tone decision, so a glyph and
 * the label beside it can never disagree.
 */
export const SYNC_STATUS_DRESS: Record<
  CatalogSyncStatus,
  { Icon: LucideIcon; tone: string; badge: string }
> = {
  localOnly: { Icon: HardDrive, tone: textMuted, badge: badgeSmallNeutral },
  inSync: { Icon: CircleCheck, tone: textSuccess, badge: badgeSmallSuccess },
  localAhead: { Icon: ArrowUp, tone: textInfo, badge: badgeSmallInfo },
  remoteAhead: { Icon: ArrowDown, tone: textWarning, badge: badgeSmallWarning },
  diverged: { Icon: ArrowUpDown, tone: textDanger, badge: badgeSmallDanger },
  missing: { Icon: FileX, tone: textDanger, badge: badgeSmallDanger },
  unchecked: { Icon: CircleDashed, tone: textMuted, badge: badgeSmallNeutral },
};

/**
 * Actions and objects — the verbs and the things they act on.
 *
 * Named by meaning rather than by picture, so a site says what it does and this file
 * decides what that looks like.
 *
 * **Named exports, not one object literal**, so a duplicate name is a duplicate export
 * — a compile error — rather than a silently overwritten key.
 *
 * They are *not* tree-shaken, and that is a measured decision rather than an oversight.
 * Call sites `import * as ShareIcon`, and a namespace import makes rollup materialise
 * the whole namespace: the catalogue picker's chunk carries `github`, `cloud-upload`
 * and four others it never renders, ~1.8 KB raw / ~700 B gzip, growing by ~250 B per
 * entry. Switching call sites to named imports would drop that, at the cost of the
 * `ShareIcon.` prefix at ~60 sites — the prefix being the thing that makes a glyph
 * visibly part of the vocabulary. In a desktop app reading assets off local disk, the
 * prefix is worth more than the kilobyte. Revisit if this ever ships over a network.
 */
// ── Transfer. Clouds, paired by direction. ──────────────────────────────────
export const Push: LucideIcon = CloudUpload;
/** Take upstream bytes — pulling, and applying a reviewed update. */
export const Pull: LucideIcon = CloudDownload;
/** Poll for upstream movement. Writes nothing, so it is not a transfer. */
export const CheckUpdates: LucideIcon = RefreshCw;
/** Open the upstream change for review. Same glyph as the push dialog's tab. */
export const Diff: LucideIcon = FileDiff;

// ── Repository objects. Git marks. ──────────────────────────────────────────
export const Repository: LucideIcon = FolderGit2;
/** A branch or ref. Only this — not a stand-in for the repository. */
export const Branch: LucideIcon = GitBranch;
export const PullRequest: LucideIcon = GitPullRequestArrow;
export const RevealClone: LucideIcon = FolderOpen;
export const GitHub: LucideIcon = Github;

// ── Catalogue actions. ──────────────────────────────────────────────────────
export const NewCatalog: LucideIcon = FilePlus;
export const ImportCatalog: LucideIcon = Import;
export const Edit: LucideIcon = Pencil;
export const Duplicate: LucideIcon = Copy;
export const Delete: LucideIcon = Trash2;
/** Stop tracking a catalogue's git provenance. The file itself is untouched. */
export const Forget: LucideIcon = Unlink;
export const Properties: LucideIcon = Info;
/** Keep a repository in the saved list. Distinct from `Favourite`, which marks
 *  which saved repository is the publish default — one glyph cannot be both. */
export const SaveRepository: LucideIcon = Bookmark;
/**
 * The publish default.
 *
 * One exception, and it is not a slip: `RepoPicker` marks the starred repository
 * with a literal `"★"` because it renders inside a native `<option>`, which can
 * hold text and nothing else. Do not "fix" it to this component.
 */
export const Favourite: LucideIcon = Star;

// ── Feedback. One glyph per meaning. ────────────────────────────────────────
/**
 * Every alert, at every severity — tone already carries how bad it is, and a
 * per-site icon prop is precisely how four glyphs accumulated for one job.
 */
export const Alert: LucideIcon = TriangleAlert;
/**
 * A security finding, which is a section of its own rather than an alert box. The
 * one deliberate exception to `Alert`: the shield carries meaning the triangle
 * does not.
 */
export const Secret: LucideIcon = ShieldAlert;
export const Success: LucideIcon = CircleCheck;
export const Busy: LucideIcon = LoaderCircle;
/** Frames that would put traffic on a live bus. */
export const TransmitRisk: LucideIcon = Radio;

