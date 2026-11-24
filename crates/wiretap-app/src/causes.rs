use std::error::Error;

/// An error's message and every cause behind it, outermost first. The wslib
/// crates say only their own layer and leave the rest to `source()`.
pub(crate) fn with_causes(error: impl Error) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("{says}")]
    struct Layer {
        says: &'static str,
        #[source]
        cause: Option<Box<Layer>>,
    }

    fn layers(says: &[&'static str]) -> Layer {
        let (&says, rest) = says.split_first().unwrap();
        Layer {
            says,
            cause: (!rest.is_empty()).then(|| Box::new(layers(rest))),
        }
    }

    #[test]
    fn every_cause_follows_its_error() {
        assert_eq!(
            with_causes(layers(&["API request failed", "error sending request", "os error 65"])),
            "API request failed: error sending request: os error 65"
        );
        assert_eq!(with_causes(layers(&["closed"])), "closed");
    }

    #[test]
    fn a_cause_its_error_already_ends_with_is_not_repeated() {
        assert_eq!(
            with_causes(layers(&["open failed: no such port", "no such port"])),
            "open failed: no such port"
        );
    }
}
