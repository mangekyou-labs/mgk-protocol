//! Deployment manifest schema and validator.
//!
//! One checked-in JSON file (`deployments/<name>.json`) is the source of every
//! on-chain address for a market (ADR 0004). This crate is host-side only: it
//! parses the file, enforces the schema and returns typed addresses. Anything
//! not yet deployed must be an explicit `{ "status": "pending" }` placeholder;
//! bare strings such as `"TBD"` are rejected.

use serde_json::{Map, Value};

pub type Address = [u8; 32];

/// The only `schema_version` this validator understands.
pub const SCHEMA_VERSION: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cluster {
    Localnet,
    Devnet,
    Testnet,
    MainnetBeta,
}

/// An address that is either not deployed yet (explicit placeholder) or known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountRef {
    Pending,
    Deployed(Address),
}

/// The indexer's backfill start: a placeholder until the market is created.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotRef {
    Pending,
    Set(u64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Programs {
    pub perps_core: Address,
    pub perps_matcher: Address,
    pub oracle: Address,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accounts {
    pub registry: AccountRef,
    pub instrument: AccountRef,
    pub oracle: AccountRef,
    pub insurance: AccountRef,
    pub maker: AccountRef,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub name: String,
    pub cluster: Cluster,
    pub programs: Programs,
    pub accounts: Accounts,
    pub start_slot: SlotRef,
}

/// A validation failure, naming the offending dotted field path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError {
    pub field: String,
    pub reason: String,
}

impl core::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "invalid manifest field `{}`: {}", self.field, self.reason)
    }
}

impl std::error::Error for ManifestError {}

fn err<T>(field: &str, reason: impl Into<String>) -> Result<T, ManifestError> {
    Err(ManifestError {
        field: field.to_string(),
        reason: reason.into(),
    })
}

fn join(parent: &str, key: &str) -> String {
    if parent.is_empty() {
        key.to_string()
    } else {
        format!("{parent}.{key}")
    }
}

/// Require `value` to be an object with exactly `keys` (no more, no fewer).
fn exact_object<'a>(
    value: &'a Value,
    path: &str,
    keys: &[&str],
) -> Result<&'a Map<String, Value>, ManifestError> {
    let Some(obj) = value.as_object() else {
        return err(path, "expected an object");
    };
    for key in keys {
        if !obj.contains_key(*key) {
            return err(&join(path, key), "missing required field");
        }
    }
    for key in obj.keys() {
        if !keys.contains(&key.as_str()) {
            return err(&join(path, key), "unknown field");
        }
    }
    Ok(obj)
}

fn parse_pubkey(value: &Value, path: &str) -> Result<Address, ManifestError> {
    let Some(s) = value.as_str() else {
        return err(path, "expected a base58 public key string");
    };
    let Ok(bytes) = bs58::decode(s).into_vec() else {
        return err(path, "not valid base58");
    };
    match <Address>::try_from(bytes.as_slice()) {
        Ok(addr) => Ok(addr),
        Err(_) => err(
            path,
            format!("decodes to {} bytes, expected 32", bytes.len()),
        ),
    }
}

fn status<'a>(obj: &'a Map<String, Value>, path: &str) -> Result<&'a str, ManifestError> {
    match obj.get("status").and_then(Value::as_str) {
        Some(s) => Ok(s),
        None => err(path, "`status` must be a string"),
    }
}

fn parse_account_ref(value: &Value, path: &str) -> Result<AccountRef, ManifestError> {
    let Some(obj) = value.as_object() else {
        return err(
            path,
            "expected {\"status\":\"pending\"} or {\"status\":\"deployed\",\"address\":...}",
        );
    };
    match status(obj, path)? {
        "pending" => {
            exact_object(value, path, &["status"])
                .or_else(|_| err(path, "a pending entry must not carry an address"))?;
            Ok(AccountRef::Pending)
        }
        "deployed" => {
            exact_object(value, path, &["status", "address"])
                .or_else(|_| err(path, "a deployed entry needs exactly `status` and `address`"))?;
            parse_pubkey(&obj["address"], path).map(AccountRef::Deployed)
        }
        other => err(
            path,
            format!("unknown status `{other}` (expected pending or deployed)"),
        ),
    }
}

fn parse_slot_ref(value: &Value, path: &str) -> Result<SlotRef, ManifestError> {
    let Some(obj) = value.as_object() else {
        return err(path, "expected {\"status\":\"pending\"} or {\"status\":\"set\",\"slot\":N}");
    };
    match status(obj, path)? {
        "pending" => {
            exact_object(value, path, &["status"])
                .or_else(|_| err(path, "a pending start slot must not carry a slot"))?;
            Ok(SlotRef::Pending)
        }
        "set" => {
            exact_object(value, path, &["status", "slot"])
                .or_else(|_| err(path, "a set start slot needs exactly `status` and `slot`"))?;
            match obj["slot"].as_u64() {
                Some(slot) => Ok(SlotRef::Set(slot)),
                None => err(path, "`slot` must be a non-negative integer"),
            }
        }
        other => err(
            path,
            format!("unknown status `{other}` (expected pending or set)"),
        ),
    }
}

fn parse_cluster(value: &Value) -> Result<Cluster, ManifestError> {
    match value.as_str() {
        Some("localnet") => Ok(Cluster::Localnet),
        Some("devnet") => Ok(Cluster::Devnet),
        Some("testnet") => Ok(Cluster::Testnet),
        Some("mainnet-beta") => Ok(Cluster::MainnetBeta),
        _ => err(
            "cluster",
            "expected one of localnet, devnet, testnet, mainnet-beta",
        ),
    }
}

impl Manifest {
    /// Parse and fully validate a manifest document.
    pub fn parse(json: &str) -> Result<Manifest, ManifestError> {
        let root: Value = match serde_json::from_str(json) {
            Ok(v) => v,
            Err(e) => return err("", format!("not valid JSON: {e}")),
        };
        let obj = exact_object(
            &root,
            "",
            &[
                "schema_version",
                "name",
                "cluster",
                "programs",
                "accounts",
                "start_slot",
            ],
        )?;

        if obj["schema_version"].as_u64() != Some(SCHEMA_VERSION) {
            return err(
                "schema_version",
                format!("unsupported, expected {SCHEMA_VERSION}"),
            );
        }
        let name = match obj["name"].as_str() {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => return err("name", "expected a non-empty string"),
        };
        let cluster = parse_cluster(&obj["cluster"])?;

        let prog = exact_object(
            &obj["programs"],
            "programs",
            &["perps_core", "perps_matcher", "oracle"],
        )?;
        let programs = Programs {
            perps_core: parse_pubkey(&prog["perps_core"], "programs.perps_core")?,
            perps_matcher: parse_pubkey(&prog["perps_matcher"], "programs.perps_matcher")?,
            oracle: parse_pubkey(&prog["oracle"], "programs.oracle")?,
        };

        let acc = exact_object(
            &obj["accounts"],
            "accounts",
            &["registry", "instrument", "oracle", "insurance", "maker"],
        )?;
        let accounts = Accounts {
            registry: parse_account_ref(&acc["registry"], "accounts.registry")?,
            instrument: parse_account_ref(&acc["instrument"], "accounts.instrument")?,
            oracle: parse_account_ref(&acc["oracle"], "accounts.oracle")?,
            insurance: parse_account_ref(&acc["insurance"], "accounts.insurance")?,
            maker: parse_account_ref(&acc["maker"], "accounts.maker")?,
        };

        let start_slot = parse_slot_ref(&obj["start_slot"], "start_slot")?;

        let manifest = Manifest {
            name,
            cluster,
            programs,
            accounts,
            start_slot,
        };
        manifest.check_unique_addresses()?;
        Ok(manifest)
    }

    /// Every known address (programs and deployed accounts) must be distinct.
    fn check_unique_addresses(&self) -> Result<(), ManifestError> {
        let mut seen: Vec<(Address, &str)> = vec![
            (self.programs.perps_core, "programs.perps_core"),
            (self.programs.perps_matcher, "programs.perps_matcher"),
            (self.programs.oracle, "programs.oracle"),
        ];
        let accounts = [
            (&self.accounts.registry, "accounts.registry"),
            (&self.accounts.instrument, "accounts.instrument"),
            (&self.accounts.oracle, "accounts.oracle"),
            (&self.accounts.insurance, "accounts.insurance"),
            (&self.accounts.maker, "accounts.maker"),
        ];
        for (acc, path) in accounts {
            if let AccountRef::Deployed(addr) = acc {
                seen.push((*addr, path));
            }
        }
        for (i, (addr, path)) in seen.iter().enumerate() {
            if let Some((_, first)) = seen[..i].iter().find(|(a, _)| a == addr) {
                return err(path, format!("duplicate of address already used by `{first}`"));
            }
        }
        Ok(())
    }
}
