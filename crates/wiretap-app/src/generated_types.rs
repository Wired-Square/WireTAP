// crates/wiretap-app/src/generated_types.rs
//
// The TypeScript the frontend reads for the serde shapes it shares with this
// crate, written into `frontend/wiretap-ui/src/generated/` by `ts-rs`. The test
// regenerates the directory and fails while what was committed differs, so a
// stale or missing file cannot pass; `npm run gen:types` regenerates it.

use std::any::TypeId;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use ts_rs::{Config, TypeVisitor, TS};

const HEADER: &str = "// Generated from the Rust serde types by `npm run gen:types`. Do not edit.\n";

fn out_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/wiretap-ui/src/generated")
}

struct Render {
    cfg: Config,
    files: BTreeMap<PathBuf, (TypeId, String)>,
}

impl TypeVisitor for Render {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        let Some(path) = T::output_path() else { return };
        if let Some((id, _)) = self.files.get(&path) {
            assert_eq!(*id, TypeId::of::<T>(), "two Rust types export to {path:?}; rename one with #[ts(rename)]");
            return;
        }
        let text = T::export_to_string(&self.cfg).expect("ts-rs renders every derived type");
        let body = text.split_once('\n').map_or(text.as_str(), |(_, rest)| rest);
        self.files.insert(path, (TypeId::of::<T>(), format!("{HEADER}{body}")));
        T::visit_dependencies(self);
    }
}

fn render() -> BTreeMap<PathBuf, String> {
    let mut r = Render {
        cfg: Config::new().with_large_int("number"),
        files: BTreeMap::new(),
    };
    r.visit::<crate::io::GvretDeviceInfo>();
    r.files.into_iter().map(|(path, (_, text))| (path, text)).collect()
}

fn committed(dir: &Path) -> BTreeMap<PathBuf, String> {
    let Ok(entries) = fs::read_dir(dir) else { return BTreeMap::new() };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "ts"))
        .map(|p| (PathBuf::from(p.file_name().unwrap()), fs::read_to_string(&p).unwrap()))
        .collect()
}

#[test]
fn generated_types_match_the_rust_shapes() {
    let dir = out_dir();
    let want = render();
    let have = committed(&dir);
    if want == have {
        return;
    }

    fs::create_dir_all(&dir).unwrap();
    for stale in have.keys().filter(|p| !want.contains_key(*p)) {
        fs::remove_file(dir.join(stale)).unwrap();
    }
    for (path, text) in &want {
        if have.get(path) != Some(text) {
            fs::write(dir.join(path), text).unwrap();
        }
    }

    let changed: BTreeSet<_> = want.keys().chain(have.keys()).filter(|p| want.get(*p) != have.get(*p)).collect();
    assert!(
        std::env::var_os("WIRETAP_GEN_TYPES").is_some(),
        "src/generated was stale and has been rewritten; commit it: {changed:?}"
    );
}

