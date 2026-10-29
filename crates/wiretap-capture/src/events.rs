use serde::{Deserialize, Serialize};

/// An annotation on a capture: a moment, or a span, with a note. Microseconds
/// since the epoch throughout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "Event"))]
pub struct CaptureEvent {
    pub id: i64,
    pub ts_us: i64,
    pub duration_us: i64,
    pub note: String,
    pub created_at_us: i64,
    pub updated_at_us: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "NewEvent"))]
pub struct NewCaptureEvent {
    pub ts_us: i64,
    #[serde(default)]
    pub duration_us: i64,
    #[serde(default)]
    pub note: String,
}

/// An absent field is left as it was.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(rename = "EventPatch"))]
pub struct CaptureEventPatch {
    pub ts_us: Option<i64>,
    pub duration_us: Option<i64>,
    pub note: Option<String>,
}

#[cfg(test)]
pub(crate) fn event(ts_us: i64, duration_us: i64, note: &str) -> NewCaptureEvent {
    NewCaptureEvent {
        ts_us,
        duration_us,
        note: note.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_serialises_with_its_id_first() {
        let stored = CaptureEvent {
            id: 7,
            ts_us: 1,
            duration_us: 0,
            note: String::new(),
            created_at_us: 2,
            updated_at_us: 3,
        };
        assert!(serde_json::to_string(&stored)
            .unwrap()
            .starts_with(r#"{"id":7,"#));
        let new: NewCaptureEvent = serde_json::from_str(r#"{"ts_us":5}"#).unwrap();
        assert_eq!(new, event(5, 0, ""));
    }
}
