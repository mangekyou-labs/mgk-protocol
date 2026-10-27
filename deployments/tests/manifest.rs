//! Behavior of the deployment manifest through its public boundary: the
//! checked-in `deployments/devnet.json`, and the validator that every
//! consumer (frontend, indexer, workers) will share.

use mgk_deployment::{AccountRef, Cluster, Manifest, SlotRef};
use serde_json::{json, Value};

const CHECKED_IN: &str = include_str!("../devnet.json");
const SCHEMA: &str = include_str!("../manifest.schema.json");

fn checked_in_value() -> Value {
    serde_json::from_str(CHECKED_IN).expect("devnet.json is valid JSON")
}

fn parse(value: &Value) -> Result<Manifest, mgk_deployment::ManifestError> {
    Manifest::parse(&value.to_string())
}

fn some_pubkey(seed: u8) -> String {
    bs58::encode([seed; 32]).into_string()
}

/// A manifest in which every address is deployed (no placeholders).
fn fully_deployed() -> Value {
    json!({
        "schema_version": 1,
        "name": "test",
        "cluster": "devnet",
        "programs": {
            "perps_core": some_pubkey(1),
            "perps_matcher": some_pubkey(2),
            "oracle": some_pubkey(3),
        },
        "accounts": {
            "registry": { "status": "deployed", "address": some_pubkey(4) },
            "instrument": { "status": "deployed", "address": some_pubkey(5) },
            "oracle": { "status": "deployed", "address": some_pubkey(6) },
            "insurance": { "status": "deployed", "address": some_pubkey(7) },
            "maker": { "status": "deployed", "address": some_pubkey(8) },
        },
        "start_slot": { "status": "set", "slot": 123 },
    })
}

#[test]
fn checked_in_manifest_is_valid() {
    let m = parse(&checked_in_value()).expect("checked-in manifest validates");
    assert_eq!(m.cluster, Cluster::Devnet);
}

#[test]
fn checked_in_program_ids_are_the_ids_compiled_into_the_programs() {
    let m = parse(&checked_in_value()).unwrap();
    assert_eq!(m.programs.perps_core, mgk_common::perps_core_program_id());
    assert_eq!(
        m.programs.perps_matcher,
        mgk_common::perps_matcher_program_id()
    );
    assert_eq!(m.programs.oracle, mgk_common::mgk_oracle_program_id());
}

#[test]
fn checked_in_manifest_marks_undeployed_addresses_as_explicit_placeholders() {
    let m = parse(&checked_in_value()).unwrap();
    assert_eq!(m.accounts.registry, AccountRef::Pending);
    assert_eq!(m.accounts.instrument, AccountRef::Pending);
    assert_eq!(m.accounts.oracle, AccountRef::Pending);
    assert_eq!(m.accounts.insurance, AccountRef::Pending);
    assert_eq!(m.accounts.maker, AccountRef::Pending);
    assert_eq!(m.start_slot, SlotRef::Pending);
}

#[test]
fn fully_deployed_manifest_exposes_addresses_and_start_slot() {
    let m = parse(&fully_deployed()).unwrap();
    assert_eq!(m.accounts.registry, AccountRef::Deployed([4; 32]));
    assert_eq!(m.accounts.maker, AccountRef::Deployed([8; 32]));
    assert_eq!(m.start_slot, SlotRef::Set(123));
}

#[test]
fn pending_entry_must_not_carry_an_address() {
    let mut v = fully_deployed();
    v["accounts"]["registry"] = json!({ "status": "pending", "address": some_pubkey(4) });
    let err = parse(&v).unwrap_err();
    assert_eq!(err.field, "accounts.registry");
}

#[test]
fn deployed_entry_requires_an_address() {
    let mut v = fully_deployed();
    v["accounts"]["registry"] = json!({ "status": "deployed" });
    assert_eq!(parse(&v).unwrap_err().field, "accounts.registry");
}

#[test]
fn bare_placeholder_strings_are_rejected() {
    let mut v = fully_deployed();
    v["accounts"]["registry"] = json!("TBD");
    assert_eq!(parse(&v).unwrap_err().field, "accounts.registry");
}

#[test]
fn unknown_status_is_rejected() {
    let mut v = fully_deployed();
    v["accounts"]["insurance"] = json!({ "status": "later" });
    assert_eq!(parse(&v).unwrap_err().field, "accounts.insurance");
}

#[test]
fn pending_start_slot_must_not_carry_a_slot() {
    let mut v = fully_deployed();
    v["start_slot"] = json!({ "status": "pending", "slot": 5 });
    assert_eq!(parse(&v).unwrap_err().field, "start_slot");
}

#[test]
fn set_start_slot_requires_a_non_negative_integer() {
    let mut v = fully_deployed();
    v["start_slot"] = json!({ "status": "set", "slot": -1 });
    assert_eq!(parse(&v).unwrap_err().field, "start_slot");
    v["start_slot"] = json!({ "status": "set" });
    assert_eq!(parse(&v).unwrap_err().field, "start_slot");
}

#[test]
fn program_ids_must_be_concrete_base58_pubkeys() {
    let mut v = fully_deployed();
    v["programs"]["perps_core"] = json!("not-a-pubkey-0OIl");
    assert_eq!(parse(&v).unwrap_err().field, "programs.perps_core");

    // Valid base58 but wrong length (16 bytes).
    v["programs"]["perps_core"] = json!(bs58::encode([9u8; 16]).into_string());
    assert_eq!(parse(&v).unwrap_err().field, "programs.perps_core");

    // A placeholder is not allowed for programs: their IDs are fixed up front.
    v["programs"]["perps_core"] = json!({ "status": "pending" });
    assert_eq!(parse(&v).unwrap_err().field, "programs.perps_core");
}

#[test]
fn deployed_address_must_be_a_valid_pubkey() {
    let mut v = fully_deployed();
    v["accounts"]["maker"] = json!({ "status": "deployed", "address": "nope" });
    assert_eq!(parse(&v).unwrap_err().field, "accounts.maker");
}

#[test]
fn duplicate_addresses_are_rejected() {
    let mut v = fully_deployed();
    v["accounts"]["insurance"] = json!({ "status": "deployed", "address": some_pubkey(4) });
    let err = parse(&v).unwrap_err();
    assert!(
        err.field == "accounts.insurance" || err.field == "accounts.registry",
        "unexpected field {}",
        err.field
    );
    assert!(err.reason.contains("duplicate"), "{}", err.reason);
}

#[test]
fn account_may_not_reuse_a_program_id() {
    let mut v = fully_deployed();
    v["accounts"]["maker"] = json!({ "status": "deployed", "address": some_pubkey(1) });
    assert!(parse(&v).unwrap_err().reason.contains("duplicate"));
}

#[test]
fn unknown_cluster_is_rejected() {
    let mut v = fully_deployed();
    v["cluster"] = json!("moonnet");
    assert_eq!(parse(&v).unwrap_err().field, "cluster");
}

#[test]
fn unsupported_schema_version_is_rejected() {
    let mut v = fully_deployed();
    v["schema_version"] = json!(2);
    assert_eq!(parse(&v).unwrap_err().field, "schema_version");
}

#[test]
fn missing_required_field_is_reported_by_name() {
    for key in ["name", "cluster", "programs", "accounts", "start_slot"] {
        let mut v = fully_deployed();
        v.as_object_mut().unwrap().remove(key);
        assert_eq!(parse(&v).unwrap_err().field, key, "removing {key}");
    }
    for key in ["registry", "instrument", "oracle", "insurance", "maker"] {
        let mut v = fully_deployed();
        v["accounts"].as_object_mut().unwrap().remove(key);
        assert_eq!(
            parse(&v).unwrap_err().field,
            format!("accounts.{key}"),
            "removing accounts.{key}"
        );
    }
    for key in ["perps_core", "perps_matcher", "oracle"] {
        let mut v = fully_deployed();
        v["programs"].as_object_mut().unwrap().remove(key);
        assert_eq!(parse(&v).unwrap_err().field, format!("programs.{key}"));
    }
}

#[test]
fn unknown_fields_are_rejected_so_consumers_cannot_drift() {
    let mut v = fully_deployed();
    v["batch_address"] = json!(some_pubkey(9));
    assert_eq!(parse(&v).unwrap_err().field, "batch_address");

    let mut v = fully_deployed();
    v["accounts"]["batch"] = json!({ "status": "pending" });
    assert_eq!(parse(&v).unwrap_err().field, "accounts.batch");
}

#[test]
fn malformed_json_is_an_error() {
    assert!(Manifest::parse("{ not json").is_err());
}

#[test]
fn schema_file_declares_the_same_required_fields_as_the_validator() {
    let schema: Value = serde_json::from_str(SCHEMA).expect("schema is valid JSON");
    let required = |v: &Value| -> Vec<String> {
        let mut r: Vec<String> = v["required"]
            .as_array()
            .expect("required array")
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect();
        r.sort();
        r
    };
    let mut top = vec![
        "schema_version",
        "name",
        "cluster",
        "programs",
        "accounts",
        "start_slot",
    ];
    top.sort();
    assert_eq!(required(&schema), top);
    assert_eq!(
        required(&schema["properties"]["accounts"]),
        ["instrument", "insurance", "maker", "oracle", "registry"]
    );
    assert_eq!(
        required(&schema["properties"]["programs"]),
        ["oracle", "perps_core", "perps_matcher"]
    );
    assert_eq!(schema["additionalProperties"], json!(false));
}
