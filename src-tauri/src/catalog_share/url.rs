//! Normalising parser for the "git URL someone shared with you".
//!
//! People paste whatever their browser or terminal gave them: a repo page, a
//! directory listing, a single-file blob view, a `raw.githubusercontent.com`
//! link, or an SSH clone URL. All of those describe the same three things — a
//! repository, an optional git ref, and an optional path within it — so they all
//! normalise onto [`CatalogSource`].
//!
//! Parsing lives in Rust (rather than the frontend) so the browse, import and
//! publish paths cannot disagree about what a URL meant.

use serde::{Deserialize, Serialize};

/// Longest input we will even look at. Real URLs are far shorter; anything past
/// this is a paste accident.
const MAX_INPUT_LEN: usize = 2048;

/// What the URL pointed at within the repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    /// The repository as a whole — scan it for catalogues.
    Repo,
    /// A subdirectory — scan only that subtree.
    Directory,
    /// A single `.toml` file.
    File,
}

/// A repository reference plus the optional ref/path the URL narrowed it to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSource {
    pub host: String,
    pub owner: String,
    pub repo: String,
    /// Branch, tag or commit sha. `None` means "the repository's default branch",
    /// which only the API can tell us.
    pub reference: Option<String>,
    /// Repo-relative path to a directory or file.
    pub path: Option<String>,
    pub kind: SourceKind,
    /// Set when the ref/path split in a `/tree/…` or `/blob/…` URL was ambiguous
    /// because the branch name may itself contain slashes. The caller should
    /// confirm `reference` against the API and re-split if it does not resolve.
    #[serde(default)]
    pub ref_is_ambiguous: bool,
}

impl CatalogSource {
    /// Stable registry key for the repository, independent of ref or path.
    ///
    /// Host-derived rather than hardcoded, so a GitHub Enterprise or GitLab
    /// `owner/repo` cannot collide with the github.com one in the same keyspace.
    pub fn repo_id(&self) -> String {
        let host = match self.host.as_str() {
            "github.com" | "raw.githubusercontent.com" => "gh",
            other => other,
        };
        format!("{host}:{}/{}", self.owner, self.repo)
    }

    /// Canonical `https://{host}/{owner}/{repo}` URL for the repository, dropping
    /// any ref and path.
    ///
    /// Lets a saved repository be stored as a URL rather than as a decomposed
    /// identity, so the publish path keeps re-parsing it server-side instead of
    /// trusting owner/repo fields sent by the frontend. `raw.githubusercontent.com`
    /// normalises to `github.com`, which is the browsable form.
    pub fn repo_url(&self) -> String {
        let host = match self.host.as_str() {
            "raw.githubusercontent.com" => "github.com",
            other => other,
        };
        format!("https://{host}/{}/{}", self.owner, self.repo)
    }

    /// Override the ref and directory from values the caller already knows exactly
    /// (a saved repository), leaving identity — host, owner, repo — untouched.
    ///
    /// Expressing scope as arguments rather than re-encoding it into a URL for us to
    /// parse back out is not just tidier: `/tree/{ref}/{dir}` cannot express "the
    /// default branch, but this directory" at all, and re-parsing one would set
    /// `ref_is_ambiguous` and cost an extra API request to re-derive a split the
    /// caller already had.
    pub fn apply_scope(
        &mut self,
        git_ref: Option<String>,
        directory: Option<String>,
    ) -> Result<(), ParseError> {
        let given = |v: Option<String>| v.map(|s| s.trim().trim_matches('/').to_string()).filter(|s| !s.is_empty());

        if let Some(git_ref) = given(git_ref) {
            self.reference = Some(git_ref);
            self.ref_is_ambiguous = false;
        }
        if let Some(directory) = given(directory) {
            self.path = Some(directory);
            self.kind = SourceKind::Directory;
            // The same guard a pasted path goes through — a directory typed into the
            // edit dialog must not be the one way traversal gets in.
            validate_path(self)?;
        }
        Ok(())
    }

    /// The ref to address, falling back to a caller-supplied default branch.
    pub fn reference_or<'a>(&'a self, default_branch: &'a str) -> &'a str {
        self.reference.as_deref().unwrap_or(default_branch)
    }

    /// The repo-relative subtree this source is scoped to, if any.
    ///
    /// A property of the source rather than of the call site: browse, resolve and
    /// import must all apply the same scope, or a file visible when browsing a
    /// subdirectory can vanish from the unscoped listing on import.
    pub fn scope(&self) -> Option<&str> {
        match self.kind {
            SourceKind::Repo => None,
            SourceKind::Directory | SourceKind::File => self.path.as_deref(),
        }
    }
}

/// Why an input could not be understood. Each variant carries a message aimed at
/// the person who pasted it, not at us.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "message")]
pub enum ParseError {
    Empty(String),
    TooLong(String),
    /// A recognised GitHub URL, but one that points at something that is not a
    /// place catalogues live (a pull request, an issue, a commit view).
    NotARepoUrl(String),
    Malformed(String),
}

impl ParseError {
    pub fn message(&self) -> &str {
        match self {
            Self::Empty(m) | Self::TooLong(m) | Self::NotARepoUrl(m) | Self::Malformed(m) => m,
        }
    }
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

/// GitHub web paths that are definitely not a repository, directory or file
/// view. Listed so the error can name what was actually pasted.
const NON_SOURCE_SEGMENTS: &[(&str, &str)] = &[
    ("pull", "a pull-request URL"),
    ("pulls", "a pull-request URL"),
    ("issues", "an issue URL"),
    ("commit", "a commit URL"),
    ("commits", "a commit-history URL"),
    ("compare", "a compare URL"),
    ("releases", "a releases URL"),
    ("actions", "an Actions URL"),
    ("wiki", "a wiki URL"),
    ("discussions", "a discussions URL"),
    ("settings", "a repository settings URL"),
];

/// Parse and normalise a shared source URL.
///
/// Non-GitHub hosts parse successfully so the caller can reject them with a
/// message about capability ("only github.com is supported") rather than one
/// about syntax.
pub fn parse_catalog_source(input: &str) -> Result<CatalogSource, ParseError> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(ParseError::Empty("Enter a repository URL".into()));
    }
    if raw.len() > MAX_INPUT_LEN {
        return Err(ParseError::TooLong("That URL is implausibly long".into()));
    }

    // Strip fragment and query — neither ever carries repo identity.
    let raw = raw.split(['#', '?']).next().unwrap_or(raw);

    let (host, path) = split_host_and_path(raw)?;
    let segments: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(percent_decode)
        .collect();

    if segments.len() < 2 {
        return Err(ParseError::Malformed(
            "That does not look like a repository URL — expected owner/repo".into(),
        ));
    }

    let owner = segments[0].clone();
    let repo = strip_git_suffix(&segments[1]);
    if owner.is_empty() || repo.is_empty() {
        return Err(ParseError::Malformed(
            "That does not look like a repository URL — expected owner/repo".into(),
        ));
    }

    // raw.githubusercontent.com has no /tree/ or /blob/ marker: everything after
    // owner/repo is <ref>/<path...>, with an optional refs/heads/ prefix.
    if host == "raw.githubusercontent.com" {
        return parse_raw_host(host, owner, repo, &segments[2..]);
    }

    if segments.len() == 2 {
        return Ok(CatalogSource {
            host,
            owner,
            repo,
            reference: None,
            path: None,
            kind: SourceKind::Repo,
            ref_is_ambiguous: false,
        });
    }

    let marker = segments[2].as_str();
    let kind = match marker {
        "tree" => SourceKind::Directory,
        "blob" | "raw" => SourceKind::File,
        other => {
            if let Some((_, label)) = NON_SOURCE_SEGMENTS.iter().find(|(seg, _)| *seg == other) {
                return Err(ParseError::NotARepoUrl(format!(
                    "That is {label} — paste the repository, directory or file URL instead"
                )));
            }
            return Err(ParseError::Malformed(format!(
                "Unrecognised GitHub URL segment '{other}'"
            )));
        }
    };

    let rest = &segments[3..];
    if rest.is_empty() {
        // ".../tree" or ".../blob" with nothing after it — treat as the repo.
        return Ok(CatalogSource {
            host,
            owner,
            repo,
            reference: None,
            path: None,
            kind: SourceKind::Repo,
            ref_is_ambiguous: false,
        });
    }

    let (reference, path) = split_ref_and_path(rest);
    let source = CatalogSource {
        host,
        owner,
        repo,
        reference: Some(reference),
        // A path here means the ref/path boundary was inferred, not given.
        ref_is_ambiguous: path.is_some(),
        path,
        kind,
    };
    validate_path(&source)?;
    Ok(source)
}

/// `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}`, where `{ref}` may
/// appear as `refs/heads/{branch}`.
fn parse_raw_host(
    host: String,
    owner: String,
    repo: String,
    rest: &[String],
) -> Result<CatalogSource, ParseError> {
    if rest.is_empty() {
        return Err(ParseError::Malformed(
            "That raw URL has no branch or file path".into(),
        ));
    }
    // Drop a leading refs/heads or refs/tags so the ref is the bare name.
    let rest = if rest.len() >= 3 && rest[0] == "refs" && (rest[1] == "heads" || rest[1] == "tags") {
        &rest[2..]
    } else {
        rest
    };

    let (reference, path) = split_ref_and_path(rest);
    let kind = match path.as_deref() {
        Some(p) if looks_like_file(p) => SourceKind::File,
        Some(_) => SourceKind::Directory,
        None => SourceKind::Repo,
    };
    let source = CatalogSource {
        host,
        owner,
        repo,
        reference: Some(reference),
        ref_is_ambiguous: path.is_some(),
        path,
        kind,
    };
    validate_path(&source)?;
    Ok(source)
}

/// Split `{ref}/{path...}` where the ref itself may contain slashes.
///
/// GitHub's own web URLs are genuinely ambiguous here: `tree/feature/x/catalogs`
/// is either branch `feature` + path `x/catalogs`, or branch `feature/x` + path
/// `catalogs`. We take the first segment as the ref — correct for the common
/// case. A returned path means the split was a guess, so the caller should
/// confirm it against the API using [`ref_path_candidates`].
fn split_ref_and_path(segments: &[String]) -> (String, Option<String>) {
    let path = (segments.len() > 1).then(|| segments[1..].join("/"));
    (segments[0].clone(), path)
}

/// Candidate `(ref, path)` splits for an ambiguous URL, longest ref first.
///
/// Used when the initial single-segment ref guess fails to resolve: the caller
/// probes each candidate against the refs API and keeps the one that exists.
pub fn ref_path_candidates(source: &CatalogSource) -> Vec<(String, Option<String>)> {
    let Some(reference) = source.reference.as_deref() else {
        return Vec::new();
    };
    let mut segments: Vec<&str> = vec![reference];
    if let Some(path) = source.path.as_deref() {
        segments.extend(path.split('/').filter(|s| !s.is_empty()));
    }
    // Longest ref first — a branch called `feature/x` should win over `feature`
    // when both happen to exist.
    (1..=segments.len())
        .rev()
        .map(|n| {
            let reference = segments[..n].join("/");
            let path = if n < segments.len() {
                Some(segments[n..].join("/"))
            } else {
                None
            };
            (reference, path)
        })
        .collect()
}

/// Split an input into a lowercased host and a path, accepting https, ssh,
/// scp-like `git@host:owner/repo`, and the bare `owner/repo` shorthand.
fn split_host_and_path(raw: &str) -> Result<(String, String), ParseError> {
    let Some((_, after_scheme)) = raw.split_once("://") else {
        return split_schemeless(raw);
    };
    let (authority, path) = after_scheme.split_once('/').unwrap_or((after_scheme, ""));
    // Drop any userinfo and port.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        return Err(ParseError::Malformed("That URL has no host".into()));
    }
    Ok((normalise_host(host), path.to_string()))
}

/// The two schemeless forms: scp-like `git@host:owner/repo` and the bare
/// `owner/repo` shorthand (with `host/owner/repo` accepted as a courtesy).
fn split_schemeless(raw: &str) -> Result<(String, String), ParseError> {
    // scp-like: a colon whose right side is not an absolute path, left side a host.
    if let Some((before, after)) = raw.split_once(':') {
        let host = before.rsplit('@').next().unwrap_or(before);
        if !host.is_empty() && !after.starts_with('/') && host.contains('.') {
            return Ok((normalise_host(host), after.to_string()));
        }
    }
    if raw.split('/').filter(|s| !s.is_empty()).count() < 2 {
        return Err(ParseError::Malformed(
            "Enter a GitHub URL or owner/repo".into(),
        ));
    }
    let Some((first, rest)) = raw.split_once('/') else {
        return Err(ParseError::Malformed(
            "Enter a GitHub URL or owner/repo".into(),
        ));
    };
    // A dot in the first segment means it is a hostname, not an owner.
    if first.contains('.') {
        Ok((normalise_host(first), rest.to_string()))
    } else {
        Ok(("github.com".to_string(), raw.to_string()))
    }
}

fn normalise_host(host: &str) -> String {
    let host = host.trim().to_lowercase();
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

fn strip_git_suffix(repo: &str) -> String {
    repo.strip_suffix(".git").unwrap_or(repo).to_string()
}

fn looks_like_file(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .map(|last| last.contains('.'))
        .unwrap_or(false)
}

/// Reject traversal and absolute paths before they reach any request builder.
fn validate_path(source: &CatalogSource) -> Result<(), ParseError> {
    let Some(path) = source.path.as_deref() else {
        return Ok(());
    };
    if path.starts_with('/') {
        return Err(ParseError::Malformed(
            "The path within the repository must be relative".into(),
        ));
    }
    if path.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(ParseError::Malformed(
            "The path within the repository must not contain '..'".into(),
        ));
    }
    Ok(())
}

/// Minimal percent-decoding for path segments. Invalid escapes are left as-is,
/// which is the right call for a user-facing paste field: show them what they
/// gave us rather than mangling it.
fn percent_decode(segment: &str) -> String {
    if !segment.contains('%') {
        return segment.to_string();
    }
    let bytes = segment.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| segment.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> CatalogSource {
        parse_catalog_source(input).unwrap_or_else(|e| panic!("{input} → {e}"))
    }

    /// A saved repository stores a URL, and that URL is re-parsed on every use —
    /// so the formatter must land back on the same identity from every accepted
    /// input form, however the user originally pasted it.
    #[test]
    fn repo_url_round_trips_through_the_parser() {
        for input in [
            "https://github.com/Wired-Square/wiretap-catalogs",
            "https://github.com/Wired-Square/wiretap-catalogs.git",
            "https://github.com/Wired-Square/wiretap-catalogs/tree/main/catalogs",
            "https://github.com/Wired-Square/wiretap-catalogs/blob/main/catalogs/x.toml",
            "https://raw.githubusercontent.com/Wired-Square/wiretap-catalogs/main/x.toml",
            "git@github.com:Wired-Square/wiretap-catalogs.git",
            "ssh://git@github.com/Wired-Square/wiretap-catalogs.git",
            "Wired-Square/wiretap-catalogs",
        ] {
            let url = parse(input).repo_url();
            assert_eq!(
                url, "https://github.com/Wired-Square/wiretap-catalogs",
                "{input}"
            );
            let reparsed = parse(&url);
            assert_eq!(reparsed.repo_id(), parse(input).repo_id(), "{input}");
            assert_eq!(reparsed.kind, SourceKind::Repo, "{input}");
        }
    }

    #[test]
    fn plain_repo_urls() {
        for input in [
            "https://github.com/Wired-Square/wiretap-catalogs",
            "https://github.com/Wired-Square/wiretap-catalogs/",
            "https://github.com/Wired-Square/wiretap-catalogs.git",
            "https://www.github.com/Wired-Square/wiretap-catalogs",
            "http://github.com/Wired-Square/wiretap-catalogs",
            "Wired-Square/wiretap-catalogs",
        ] {
            let s = parse(input);
            assert_eq!(s.host, "github.com", "{input}");
            assert_eq!(s.owner, "Wired-Square", "{input}");
            assert_eq!(s.repo, "wiretap-catalogs", "{input}");
            assert_eq!(s.reference, None, "{input}");
            assert_eq!(s.path, None, "{input}");
            assert_eq!(s.kind, SourceKind::Repo, "{input}");
        }
    }

    #[test]
    fn ssh_urls() {
        for input in [
            "git@github.com:Wired-Square/wiretap-catalogs.git",
            "git@github.com:Wired-Square/wiretap-catalogs",
            "ssh://git@github.com/Wired-Square/wiretap-catalogs.git",
        ] {
            let s = parse(input);
            assert_eq!(s.host, "github.com", "{input}");
            assert_eq!(s.owner, "Wired-Square", "{input}");
            assert_eq!(s.repo, "wiretap-catalogs", "{input}");
            assert_eq!(s.kind, SourceKind::Repo, "{input}");
        }
    }

    #[test]
    fn tree_directory_url() {
        let s = parse("https://github.com/owner/repo/tree/main/catalogs");
        assert_eq!(s.reference.as_deref(), Some("main"));
        assert_eq!(s.path.as_deref(), Some("catalogs"));
        assert_eq!(s.kind, SourceKind::Directory);
    }

    #[test]
    fn tree_url_with_no_path_is_repo_scoped() {
        let s = parse("https://github.com/owner/repo/tree/main");
        assert_eq!(s.reference.as_deref(), Some("main"));
        assert_eq!(s.path, None);
        assert!(!s.ref_is_ambiguous);
    }

    #[test]
    fn blob_file_url() {
        let s = parse("https://github.com/owner/repo/blob/main/catalogs/sbrxxx.toml");
        assert_eq!(s.reference.as_deref(), Some("main"));
        assert_eq!(s.path.as_deref(), Some("catalogs/sbrxxx.toml"));
        assert_eq!(s.kind, SourceKind::File);
    }

    #[test]
    fn raw_host_urls() {
        let s = parse("https://raw.githubusercontent.com/owner/repo/main/catalogs/sbrxxx.toml");
        assert_eq!(s.host, "raw.githubusercontent.com");
        assert_eq!(s.reference.as_deref(), Some("main"));
        assert_eq!(s.path.as_deref(), Some("catalogs/sbrxxx.toml"));
        assert_eq!(s.kind, SourceKind::File);
    }

    #[test]
    fn raw_host_strips_refs_heads_prefix() {
        let s = parse("https://raw.githubusercontent.com/owner/repo/refs/heads/main/x.toml");
        assert_eq!(s.reference.as_deref(), Some("main"));
        assert_eq!(s.path.as_deref(), Some("x.toml"));
        assert_eq!(s.kind, SourceKind::File);
    }

    #[test]
    fn query_and_fragment_are_dropped() {
        let s = parse("https://github.com/owner/repo/tree/main/catalogs?tab=readme#L4");
        assert_eq!(s.path.as_deref(), Some("catalogs"));
        assert_eq!(s.reference.as_deref(), Some("main"));
    }

    #[test]
    fn percent_encoded_segments_are_decoded() {
        let s = parse("https://github.com/owner/repo/tree/main/my%20catalogs");
        assert_eq!(s.path.as_deref(), Some("my catalogs"));
    }

    #[test]
    fn slashed_branch_is_flagged_ambiguous_with_candidates() {
        let s = parse("https://github.com/owner/repo/tree/feature/x/catalogs");
        // First guess: the shortest ref.
        assert_eq!(s.reference.as_deref(), Some("feature"));
        assert_eq!(s.path.as_deref(), Some("x/catalogs"));
        assert!(s.ref_is_ambiguous);

        // Candidates are offered longest-ref-first so a real `feature/x` branch wins.
        let candidates = ref_path_candidates(&s);
        assert_eq!(
            candidates,
            vec![
                ("feature/x/catalogs".to_string(), None),
                ("feature/x".to_string(), Some("catalogs".to_string())),
                ("feature".to_string(), Some("x/catalogs".to_string())),
            ]
        );
    }

    #[test]
    fn non_github_hosts_parse_so_rejection_can_be_about_capability() {
        let s = parse("https://gitlab.com/owner/repo");
        assert_eq!(s.host, "gitlab.com");
        assert_eq!(s.owner, "owner");
        assert_eq!(s.repo, "repo");

        let s = parse("https://git.example.com/owner/repo.git");
        assert_eq!(s.host, "git.example.com");
    }

    #[test]
    fn rejects_non_source_github_urls_by_name() {
        for (input, needle) in [
            ("https://github.com/owner/repo/pull/42", "pull-request"),
            ("https://github.com/owner/repo/issues/7", "issue"),
            ("https://github.com/owner/repo/commit/abc123", "commit"),
            ("https://github.com/owner/repo/releases", "releases"),
            ("https://github.com/owner/repo/compare/a...b", "compare"),
        ] {
            let err = parse_catalog_source(input).expect_err(input);
            assert!(matches!(err, ParseError::NotARepoUrl(_)), "{input}");
            assert!(
                err.message().contains(needle),
                "{input} → {err} (wanted {needle})"
            );
        }
    }

    #[test]
    fn rejects_empty_and_incomplete() {
        assert!(matches!(
            parse_catalog_source("   "),
            Err(ParseError::Empty(_))
        ));
        assert!(matches!(
            parse_catalog_source("https://github.com/owner"),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_catalog_source("not a url"),
            Err(ParseError::Malformed(_))
        ));
    }

    #[test]
    fn rejects_overlong_input() {
        let long = format!("https://github.com/owner/{}", "a".repeat(MAX_INPUT_LEN));
        assert!(matches!(
            parse_catalog_source(&long),
            Err(ParseError::TooLong(_))
        ));
    }

    #[test]
    fn rejects_traversal_in_path() {
        assert!(matches!(
            parse_catalog_source("https://github.com/owner/repo/tree/main/../../etc"),
            Err(ParseError::Malformed(_))
        ));
    }

    #[test]
    fn repo_id_is_stable_across_ref_and_path() {
        let a = parse("https://github.com/owner/repo");
        let b = parse("https://github.com/owner/repo/tree/dev/catalogs");
        assert_eq!(a.repo_id(), b.repo_id());
        assert_eq!(a.repo_id(), "gh:owner/repo");
    }

    /// Two hosts serving the same owner/repo must not share a registry key.
    #[test]
    fn repo_id_is_host_scoped() {
        assert_eq!(parse("https://gitlab.com/o/r").repo_id(), "gitlab.com:o/r");
        assert_eq!(
            parse("https://ghe.example.com/o/r").repo_id(),
            "ghe.example.com:o/r"
        );
        // The raw CDN is still github.com as far as identity goes.
        assert_eq!(
            parse("https://raw.githubusercontent.com/o/r/main/x.toml").repo_id(),
            "gh:o/r"
        );
        assert_ne!(
            parse("https://github.com/o/r").repo_id(),
            parse("https://gitlab.com/o/r").repo_id()
        );
    }

    /// The scope must be identical whichever command asks — browse, resolve and
    /// import applying different scopes is what makes a file vanish on import.
    #[test]
    fn scope_follows_the_source_kind() {
        assert_eq!(parse("https://github.com/o/r").scope(), None);
        assert_eq!(parse("https://github.com/o/r/tree/main").scope(), None);
        assert_eq!(
            parse("https://github.com/o/r/tree/main/catalogs").scope(),
            Some("catalogs")
        );
        assert_eq!(
            parse("https://github.com/o/r/blob/main/catalogs/x.toml").scope(),
            Some("catalogs/x.toml")
        );
    }

    #[test]
    fn reference_or_falls_back_to_default_branch() {
        let a = parse("https://github.com/owner/repo");
        assert_eq!(a.reference_or("main"), "main");
        let b = parse("https://github.com/owner/repo/tree/dev");
        assert_eq!(b.reference_or("main"), "dev");
    }
}
