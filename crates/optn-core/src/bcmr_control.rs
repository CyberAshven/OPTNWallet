//! Local custody of BCMR identity outputs. Publication is optional; custody is not.
//! Hosts persist an approved successor BEFORE exposing/broadcasting it, and retain
//! old records on failure or reorg. Records are intent, never proof of confirmation.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    bcmr,
    bcmr_author::to_hex,
    error::{CliError, Result},
    tx,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    pub transaction_hex: String,
    pub categories: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transition {
    pub network: String,
    pub transaction_hex: String,
    pub owned_script_hex: String,
    pub genesis_categories: Vec<String>,
    pub previous: Vec<Control>,
    pub registry_json: Option<String>,
    pub allow_shared_control: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlView {
    pub txid: String,
    pub categories: Vec<String>,
    pub script_hex: String,
    pub spent_outpoints: Vec<String>,
}

fn invalid(message: &str) -> CliError {
    CliError::Protocol(message.into())
}

fn hex(text: &str) -> Result<Vec<u8>> {
    if text.len() > 2_000_000 || !text.len().is_multiple_of(2) {
        return Err(invalid("Invalid metadata-control hex length"));
    }
    text.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digit = |c: u8| (c as char).to_digit(16).map(|v| v as u8);
            Ok((digit(pair[0]).ok_or_else(|| invalid("Invalid hex"))? << 4)
                | digit(pair[1]).ok_or_else(|| invalid("Invalid hex"))?)
        })
        .collect()
}

fn display_hash(hash: &[u8; 32]) -> String {
    to_hex(&hash.iter().rev().copied().collect::<Vec<_>>())
}

fn txid(bytes: &[u8]) -> String {
    display_hash(&Sha256::digest(Sha256::digest(bytes)).into())
}

fn inputs(decoded: &tx::Decoded) -> Vec<String> {
    decoded
        .inputs
        .iter()
        .map(|(hash, n, _)| format!("{}:{n}", display_hash(hash)))
        .collect()
}

pub fn view(control: &Control) -> Result<ControlView> {
    let bytes = hex(&control.transaction_hex)?;
    let decoded = tx::decode(&bytes)?;
    let first = decoded
        .outputs
        .first()
        .ok_or_else(|| invalid("Missing identity output"))?;
    // The current mint UI supports ordinary wallet P2PKH custody only.
    if first.token.is_some()
        || first.value < 546
        || first.script_pubkey.len() != 25
        || !first.script_pubkey.starts_with(&[0x76, 0xa9, 0x14])
        || !first.script_pubkey.ends_with(&[0x88, 0xac])
    {
        return Err(invalid(
            "Identity output must be a spendable wallet P2PKH output",
        ));
    }
    let mut categories = BTreeSet::new();
    for category in &control.categories {
        if hex(category)?.len() != 32 || !categories.insert(category.to_ascii_lowercase()) {
            return Err(invalid("Invalid or duplicate metadata category"));
        }
    }
    if categories.is_empty() || categories.len() > 256 {
        return Err(invalid("Invalid metadata category count"));
    }
    Ok(ControlView {
        txid: txid(&bytes),
        categories: categories.into_iter().collect(),
        script_hex: to_hex(&first.script_pubkey),
        spent_outpoints: inputs(&decoded),
    })
}

/// Verify the exact mint/publication successor, including every controlled category.
/// The host must independently establish ownership of `owned_script_hex`.
pub fn approve(request: Transition) -> Result<Control> {
    let network = request.network.parse().map_err(CliError::Usage)?;
    let raw = hex(&request.transaction_hex)?;
    let decoded = tx::decode(&raw)?;
    let spent = inputs(&decoded);
    let mut categories = BTreeSet::new();
    let mut control_count = 0;
    for old in &request.previous {
        let old = view(old)?;
        if spent.contains(&format!("{}:0", old.txid)) {
            control_count += 1;
            categories.extend(old.categories);
        }
    }
    let continues_existing = control_count > 0;
    for category in request.genesis_categories {
        let category = category.to_ascii_lowercase();
        if hex(&category)?.len() != 32
            || !spent.contains(&format!("{category}:0"))
            || !decoded.outputs.iter().any(|output| {
                output
                    .token
                    .as_ref()
                    .is_some_and(|token| to_hex(&token.category) == category)
            })
            || !categories.insert(category)
        {
            return Err(invalid("Genesis category is not bound to this mint"));
        }
        control_count += 1;
    }
    for token in decoded
        .outputs
        .iter()
        .filter_map(|output| output.token.as_ref())
    {
        let category = to_hex(&token.category);
        if spent.contains(&format!("{category}:0")) && !categories.contains(&category) {
            return Err(invalid(
                "Every genesis category must retain metadata control",
            ));
        }
    }
    if control_count > 1 && !request.allow_shared_control {
        return Err(invalid("Confirm shared metadata control for this batch; use separate transactions for independent control"));
    }
    let control = Control {
        transaction_hex: request.transaction_hex,
        categories: categories.into_iter().collect(),
    };
    let projection = view(&control)?;
    if hex(&projection.script_hex)? != hex(&request.owned_script_hex)? {
        return Err(invalid("Identity output must remain in this wallet"));
    }
    let publication =
        bcmr::publication_in(decoded.outputs.iter().map(|o| o.script_pubkey.as_slice()));
    match request.registry_json {
        Some(json) => {
            let publication = publication.ok_or_else(|| invalid("Missing BCMR publication"))?;
            if !publication.matches(json.as_bytes()) {
                return Err(invalid("BCMR publication does not match registry bytes"));
            }
            validate_registry(&json, &control.categories, network)?;
        }
        None if publication.is_some() => {
            return Err(invalid("Publication needs validated registry bytes"))
        }
        None if continues_existing => {
            return Err(invalid(
                "Updating metadata control requires a registry publication",
            ))
        }
        None => {}
    }
    Ok(control)
}

/// A combined registry must retain entries for ALL categories sharing the output.
pub fn validate_registry(
    json: &str,
    categories: &[String],
    network: crate::network::Network,
) -> Result<()> {
    if json.len() > 1_000_000 {
        return Err(invalid("Registry is too large"));
    }
    let registry: serde_json::Value =
        serde_json::from_str(json).map_err(|_| invalid("Invalid registry JSON"))?;
    let chain = registry
        .get("defaultChain")
        .and_then(|v| v.as_str())
        .unwrap_or(crate::bcmr_author::SPLIT_ID_MAINNET);
    if chain != crate::bcmr_author::split_id(network) {
        return Err(invalid("Registry network does not match this wallet"));
    }
    let identities = registry
        .get("identities")
        .and_then(|v| v.as_object())
        .ok_or_else(|| invalid("Registry has no identities"))?;
    for category in categories {
        let matching: Vec<_> = identities
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(category))
            .collect();
        if matching.len() != 1 {
            return Err(invalid(
                "Registry must contain each controlled category exactly once",
            ));
        }
        let snapshots = matching[0]
            .1
            .as_object()
            .ok_or_else(|| invalid("Invalid identity history"))?;
        // Authoring/import validation checks timestamp/schema semantics. No sibling
        // identity may substitute for this category's metadata.
        if snapshots.is_empty()
            || snapshots.values().any(|snapshot| {
                snapshot
                    .get("splitId")
                    .and_then(|v| v.as_str())
                    .unwrap_or(chain)
                    != chain
                    || snapshot
                        .get("token")
                        .and_then(|v| v.get("category"))
                        .and_then(|v| v.as_str())
                        .is_none_or(|value| !value.eq_ignore_ascii_case(category))
            })
        {
            return Err(invalid(
                "Every controlled identity snapshot must describe its own token category",
            ));
        }
    }
    Ok(())
}

/// All send paths, including externally prepared raw transactions, call this.
/// Only an exact, previously approved successor may spend a protected output.
pub fn check_spend(raw: &[u8], controls: &[Control]) -> Result<()> {
    let decoded = tx::decode(raw)?;
    let spent = inputs(&decoded);
    let views: Vec<_> = controls.iter().map(view).collect::<Result<_>>()?;
    if views
        .iter()
        .any(|record| spent.contains(&format!("{}:0", record.txid)))
        && !views.iter().any(|record| record.txid == txid(raw))
    {
        return Err(invalid("This coin controls token metadata. Use Add/update metadata instead of ordinary spending or CashFusion"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{network::Network, token::TokenData};

    fn script() -> Vec<u8> {
        [vec![0x76, 0xa9, 0x14], vec![11; 20], vec![0x88, 0xac]].concat()
    }

    fn transaction(inputs: &[(String, u32)], outputs: &[(Vec<u8>, Option<TokenData>)]) -> String {
        let mut raw = 2u32.to_le_bytes().to_vec();
        raw.extend(tx::varint(inputs.len() as u64));
        for (hash, index) in inputs {
            raw.extend(hex(hash).unwrap().into_iter().rev());
            raw.extend(index.to_le_bytes());
            raw.push(0);
            raw.extend(u32::MAX.to_le_bytes());
        }
        raw.extend(tx::varint(outputs.len() as u64));
        for (script, token) in outputs {
            raw.extend(1000u64.to_le_bytes());
            let mut field = token
                .as_ref()
                .map(|token| token.encode_prefix().unwrap())
                .unwrap_or_default();
            field.extend(script);
            raw.extend(tx::varint(field.len() as u64));
            raw.extend(field);
        }
        raw.extend(0u32.to_le_bytes());
        to_hex(&raw)
    }

    fn registry(categories: &[String]) -> String {
        let identities: serde_json::Map<String, serde_json::Value> = categories.iter().map(|category|
            (category.clone(), serde_json::json!({"2026-09-26T00:00:00.000Z": {"token": {"category": category, "symbol": "TEST"}}}))).collect();
        serde_json::json!({"defaultChain": crate::bcmr_author::SPLIT_ID_CHIPNET, "identities": identities}).to_string()
    }

    fn publication(json: &str) -> Vec<u8> {
        [
            bcmr::PUBLICATION_PREFIX.to_vec(),
            vec![32],
            Sha256::digest(json.as_bytes()).to_vec(),
        ]
        .concat()
    }

    fn mint(categories: &[String], shared: bool) -> Transition {
        let mut outputs = vec![(script(), None)];
        for category in categories {
            outputs.push((
                script(),
                Some(TokenData::fungible(
                    hex(category).unwrap().try_into().unwrap(),
                    100,
                )),
            ));
        }
        Transition {
            network: "chipnet".into(),
            transaction_hex: transaction(
                &categories
                    .iter()
                    .map(|c| (c.clone(), 0))
                    .collect::<Vec<_>>(),
                &outputs,
            ),
            owned_script_hex: to_hex(&script()),
            genesis_categories: categories.to_vec(),
            previous: vec![],
            registry_json: None,
            allow_shared_control: shared,
        }
    }

    #[test]
    fn deferred_publication_survives_serialization_and_protects_old_and_new_control() {
        let category = to_hex(&(0u8..32).collect::<Vec<_>>()); // asymmetric byte order
        let minted = approve(mint(std::slice::from_ref(&category), false)).unwrap();
        let saved = serde_json::to_string(&minted).unwrap();
        let reopened: Control = serde_json::from_str(&saved).unwrap();
        let old = view(&reopened).unwrap();
        let plain_send = transaction(&[(old.txid.clone(), 0)], &[(script(), None)]);
        assert!(check_spend(&hex(&plain_send).unwrap(), std::slice::from_ref(&reopened)).is_err());
        let json = registry(std::slice::from_ref(&category));
        let update = transaction(
            &[(old.txid, 0)],
            &[(script(), None), (publication(&json), None)],
        );
        let successor = approve(Transition {
            network: "chipnet".into(),
            transaction_hex: update.clone(),
            owned_script_hex: to_hex(&script()),
            genesis_categories: vec![],
            previous: vec![reopened.clone()],
            registry_json: Some(json),
            allow_shared_control: false,
        })
        .unwrap();
        let records = [reopened, successor.clone()];
        assert!(check_spend(&hex(&update).unwrap(), &records).is_ok());
        let spend_successor =
            transaction(&[(view(&successor).unwrap().txid, 0)], &[(script(), None)]);
        assert!(check_spend(&hex(&spend_successor).unwrap(), &records).is_err());
        assert!(check_spend(&hex(&plain_send).unwrap(), &records).is_err());
    }

    #[test]
    fn batch_requires_shared_control_consent_and_all_categories_in_later_registry() {
        let categories = vec!["ab".repeat(32), "cd".repeat(32)];
        assert!(approve(mint(&categories, false)).is_err());
        let mut incomplete = mint(&categories, true);
        incomplete.genesis_categories.pop();
        assert!(approve(incomplete).is_err());
        let control = approve(mint(&categories, true)).unwrap();
        assert_eq!(view(&control).unwrap().categories, categories);
        let missing = registry(&categories[..1]);
        assert!(validate_registry(&missing, &categories, Network::Chipnet).is_err());
        let combined = registry(&categories);
        assert!(validate_registry(&combined, &categories, Network::Chipnet).is_ok());
        assert!(validate_registry(&combined, &categories, Network::Mainnet).is_err());
        let raw = transaction(
            &[(view(&control).unwrap().txid, 0)],
            &[(script(), None), (publication(&combined), None)],
        );
        assert!(approve(Transition {
            network: "chipnet".into(),
            transaction_hex: raw,
            owned_script_hex: to_hex(&script()),
            genesis_categories: vec![],
            previous: vec![control],
            registry_json: Some(combined),
            allow_shared_control: false
        })
        .is_ok());
    }

    #[test]
    fn reject_transferred_control_wrong_binding_or_changed_registry() {
        let categories = vec!["12".repeat(32)];
        let mut request = mint(&categories, false);
        request.owned_script_hex =
            to_hex(&[vec![0x76, 0xa9, 0x14], vec![12; 20], vec![0x88, 0xac]].concat());
        assert!(approve(request).is_err());
        let mut request = mint(&categories, false);
        request.genesis_categories = vec!["13".repeat(32)];
        assert!(approve(request).is_err());
        let mut request = mint(&categories, false);
        request.registry_json = Some(registry(&categories));
        assert!(approve(request).is_err());
        let mut request = mint(&categories, false);
        request.transaction_hex = transaction(&[(categories[0].clone(), 0)], &[(vec![0x6a], None)]);
        assert!(approve(request).is_err());
    }
}
