#![cfg(feature = "ts")]
//! The source declarations as the desktop's generated `OrderStart.ts` and
//! `InventoryRow.ts` declare them, doc comments aside.

use ts_rs::{Config, TS};
use wiretap_analysis::source::{InventoryRow, OrderStart};

fn decl<T: TS>() -> String {
    T::decl(&Config::new().with_large_int("number"))
        .lines()
        .filter(|line| !line.starts_with("/**") && !line.starts_with(" *"))
        .collect()
}

#[test]
fn an_order_start_is_camel_case_with_an_optional_protocol() {
    assert_eq!(
        decl::<OrderStart>(),
        "type OrderStart = { protocol?: string, frameId: number, isExtended: boolean, };"
    );
}

#[test]
fn an_inventory_row_is_snake_case() {
    assert_eq!(
        decl::<InventoryRow>(),
        "type InventoryRow = { protocol: string, frame_id: number, frame_id_hex: string, \
         is_extended: boolean, count: number, first_us: number, last_us: number, \
         max_dlc: number, };"
    );
}
