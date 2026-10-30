#![cfg(feature = "ts")]
//! The catalogue export's declarations under the desktop's `Config`
//! (`large_int` as `number`), doc comments aside.

use ts_rs::{Config, TS};
use wiretap_analysis::draft::{
    ExportFinding, ExportFrame, ExportMeta, ModbusExportConfig, ModbusRegister,
};

fn decl<T: TS>() -> String {
    T::decl(&Config::new().with_large_int("number"))
        .lines()
        .filter(|line| !line.starts_with("/**") && !line.starts_with(" *"))
        .collect()
}

#[test]
fn export_meta_and_modbus_config_are_snake_case() {
    assert_eq!(
        decl::<ExportMeta>(),
        "type ExportMeta = { name: string, version: number, \
         default_byte_order: Endianness, default_interval: number, };"
    );
    for decl in [
        ExportMeta::decl(&Config::new()),
        ModbusExportConfig::decl(&Config::new()),
    ] {
        assert!(decl.contains("default_interval: number,"));
    }
    assert_eq!(
        decl::<ModbusExportConfig>(),
        "type ModbusExportConfig = { device_address: number, register_base: number, \
         register_type: RegisterType, default_interval: number, };"
    );
}

#[test]
fn a_finding_is_tagged_by_its_camel_case_code() {
    assert_eq!(
        decl::<ExportFinding>(),
        r#"type ExportFinding = { "code": "headerFieldOutOfRange", field: string, startByte: number, bytes: number, };"#
    );
}

#[test]
fn frames_and_registers_are_camel_case() {
    assert_eq!(
        decl::<ExportFrame>(),
        "type ExportFrame = { id: number, len: number, isExtended: boolean, \
         protocol: string | null, };"
    );
    assert_eq!(
        decl::<ModbusRegister>(),
        "type ModbusRegister = { frameId: number, dlc: number, };"
    );
}
