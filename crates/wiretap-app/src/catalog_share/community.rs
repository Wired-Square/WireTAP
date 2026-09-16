//! Community catalogue repositories: other people's, browsed and imported from but
//! never published to.
//!
//! Two sources, one list. The repositories that ship with WireTAP are compiled in
//! below; the rest are ones the user added, held in `Registry::community_repos`.
//! Shipped entries are deliberately *not* seeded into the registry on first run —
//! that would leave a copy in every existing install, so retiring one would never
//! actually retire it, and an install would silently keep a URL we had dropped.
//!
//! The publish target lives in the saved ("Mine") list and its star; nothing here
//! feeds it. See `mod.rs` for the saved-repository half.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::error::ShareError;
use super::registry::{CatalogSourceRegistry, Registry, SavedRepo};
use super::url::parse_catalog_source;
use super::{open_source, repo_view, saved_repo_from, SavedRepoView};

/// One repository that ships with the app.
struct Builtin {
    url: &'static str,
    label: &'static str,
    git_ref: Option<&'static str>,
    /// Repo-relative directory holding the catalogues. Saves every user a
    /// whole-repository walk to find where they live.
    directory: Option<&'static str>,
}

const BUILTIN: &[Builtin] = &[Builtin {
    url: "https://github.com/Wired-Square/wiretap-community",
    label: "Wired Square Community",
    git_ref: None,
    directory: Some("catalogs"),
}];

/// The shipped entries, as stored records.
///
/// Built through the same parser and scope rules as anything the user saves, so a
/// shipped URL cannot address a repository differently from a pasted one. A
/// malformed constant is dropped rather than failing the listing — one bad entry
/// must not take the dialog with it, and the tests below catch the typo instead.
static BUILTIN_REPOS: LazyLock<Vec<SavedRepo>> = LazyLock::new(|| {
    BUILTIN
        .iter()
        .filter_map(|b| {
            let source = parse_catalog_source(b.url).ok()?;
            let mut repo = saved_repo_from(
                &source,
                Some(b.label.to_string()),
                b.git_ref.map(str::to_string),
                b.directory.map(str::to_string),
            )
            .ok()?;
            // A shipped entry was never added, so it has no date to show.
            repo.saved_at = String::new();
            Some(repo)
        })
        .collect()
});

/// A community repository as the frontend lists it.
///
/// Composed rather than restated, so a field added to [`SavedRepo`] reaches both
/// lists instead of only the saved one. `builtin` is the whole of the difference;
/// a shipped entry carries an empty `savedAt`, which is what the properties panel
/// keys its date row off.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityRepoView {
    #[serde(flatten)]
    pub repo: SavedRepoView,
    /// Ships with WireTAP, so it cannot be edited or removed.
    pub builtin: bool,
}

/// The community list after a mutation, so callers patch state instead of re-listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityReposView {
    pub community_repos: Vec<CommunityRepoView>,
}

/// Whether an id belongs to a repository that ships with the app.
fn is_builtin(repo_id: &str) -> bool {
    BUILTIN_REPOS.iter().any(|r| r.id == repo_id)
}

/// The full community list: shipped entries first, then the user's own.
///
/// A user entry whose id matches a shipped one is skipped rather than shown twice —
/// it can only exist if the entry was added before we shipped that repository.
pub fn community_repo_views(app: &AppHandle, r: &Registry) -> Vec<CommunityRepoView> {
    let view = |repo: SavedRepo, builtin| CommunityRepoView {
        repo: repo_view(app, repo),
        builtin,
    };
    BUILTIN_REPOS
        .iter()
        .cloned()
        .map(|repo| view(repo, true))
        .chain(
            r.community_repos
                .iter()
                .filter(|repo| !is_builtin(&repo.id))
                .cloned()
                .map(|repo| view(repo, false)),
        )
        .collect()
}

impl CommunityReposView {
    fn of(app: &AppHandle, r: &Registry) -> Self {
        Self {
            community_repos: community_repo_views(app, r),
        }
    }
}

/// Add a community repository, or update the one already held under the same id.
///
/// The same command backs both, so the backend keeps one definition of what an
/// entry looks like — `saved_repo_from` fills the ref and directory from the URL
/// where the caller left them unset.
#[tauri::command(rename_all = "camelCase")]
pub fn save_community_repo(
    app: AppHandle,
    input: String,
    label: Option<String>,
    git_ref: Option<String>,
    directory: Option<String>,
) -> Result<CommunityReposView, ShareError> {
    let (source, _) = open_source(&input)?;
    let entry = saved_repo_from(&source, label, git_ref, directory)?;
    if is_builtin(&entry.id) {
        return Err(ShareError::invalid(
            "That repository already ships with WireTAP",
        ));
    }
    app.state::<CatalogSourceRegistry>()
        .write_checked(&app, |r| {
            r.save_community_repo(entry);
            (CommunityReposView::of(&app, r), true)
        })
        .map_err(ShareError::invalid)
}

/// Drop a community repository the user added. Catalogues imported from it keep
/// their provenance.
///
/// Removal is attempted before a built-in is refused, not after: an entry added
/// before we shipped that repository is hidden from the listing but still in the
/// file, and refusing on the id alone would strand it there with no way to delete it.
#[tauri::command(rename_all = "camelCase")]
pub fn forget_community_repo(
    app: AppHandle,
    repo_id: String,
) -> Result<CommunityReposView, ShareError> {
    let (removed, repos) = app
        .state::<CatalogSourceRegistry>()
        .write_checked(&app, |r| {
            let removed = r.forget_community_repo(&repo_id);
            ((removed, CommunityReposView::of(&app, r)), removed)
        })
        .map_err(ShareError::invalid)?;
    if !removed {
        return Err(if is_builtin(&repo_id) {
            ShareError::invalid("That repository ships with WireTAP and cannot be removed")
        } else {
            ShareError::not_found("That repository is not in the list")
        });
    }
    Ok(repos)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A typo in the shipped table would otherwise only show up as a missing row.
    #[test]
    fn every_builtin_parses() {
        assert_eq!(
            BUILTIN_REPOS.len(),
            BUILTIN.len(),
            "a shipped repository URL did not parse"
        );
    }

    #[test]
    fn builtins_carry_their_label_and_scope() {
        let wired = BUILTIN_REPOS
            .iter()
            .find(|r| r.id == "gh:Wired-Square/wiretap-community")
            .expect("the Wired Square community repository ships");
        assert_eq!(wired.label.as_deref(), Some("Wired Square Community"));
        assert_eq!(wired.directory.as_deref(), Some("catalogs"));
        assert_eq!(
            wired.url,
            "https://github.com/Wired-Square/wiretap-community"
        );
        assert!(wired.saved_at.is_empty(), "a shipped entry was never added");
        assert!(is_builtin(&wired.id));
        assert!(!is_builtin("gh:someone/else"));
    }
}
