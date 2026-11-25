use std::error::Error;

/// An error's message and every cause behind it, outermost first. The wslib
/// crates say only their own layer and leave the rest to `source()`.
pub fn with_causes(error: impl Error) -> String {
    let mut text = error.to_string();
    let mut cause = error.source();
    while let Some(next) = cause {
        let told = next.to_string();
        if !text.ends_with(&told) {
            text.push_str(": ");
            text.push_str(&told);
        }
        cause = next.source();
    }
    text
}
