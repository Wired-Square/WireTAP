use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One value in a profile's connection map: any JSON value, read and written
/// back as serde_json spells it. An integer stays an integer, one above
/// `i64::MAX` included, and an object's keys come back sorted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ConnValue {
    Null,
    Bool(bool),
    Int(i64),
    /// Only above `i64::MAX`; every other integer is an `Int`.
    UInt(u64),
    Float(f64),
    Str(String),
    List(Vec<ConnValue>),
    Map(BTreeMap<String, ConnValue>),
}

impl ConnValue {
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// `None` for a float, and for an integer above `i64::MAX`.
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(n) => Some(*n),
            _ => None,
        }
    }

    /// `None` for a float or a negative integer.
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Int(n) => u64::try_from(*n).ok(),
            Self::UInt(n) => Some(*n),
            _ => None,
        }
    }

    /// Any number, an integer converted.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Int(n) => Some(*n as f64),
            Self::UInt(n) => Some(*n as f64),
            Self::Float(f) => Some(*f),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[ConnValue]> {
        match self {
            Self::List(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&BTreeMap<String, ConnValue>> {
        match self {
            Self::Map(map) => Some(map),
            _ => None,
        }
    }

    /// `None` unless this is a map.
    pub fn get(&self, key: &str) -> Option<&ConnValue> {
        self.as_map()?.get(key)
    }
}

impl From<bool> for ConnValue {
    fn from(b: bool) -> Self {
        Self::Bool(b)
    }
}

impl From<i64> for ConnValue {
    fn from(n: i64) -> Self {
        Self::Int(n)
    }
}

impl From<u64> for ConnValue {
    fn from(n: u64) -> Self {
        i64::try_from(n).map_or(Self::UInt(n), Self::Int)
    }
}

impl From<f64> for ConnValue {
    fn from(f: f64) -> Self {
        Self::Float(f)
    }
}

impl From<&str> for ConnValue {
    fn from(s: &str) -> Self {
        Self::Str(s.to_owned())
    }
}

impl From<String> for ConnValue {
    fn from(s: String) -> Self {
        Self::Str(s)
    }
}

impl From<Vec<ConnValue>> for ConnValue {
    fn from(items: Vec<ConnValue>) -> Self {
        Self::List(items)
    }
}

impl From<BTreeMap<String, ConnValue>> for ConnValue {
    fn from(map: BTreeMap<String, ConnValue>) -> Self {
        Self::Map(map)
    }
}
