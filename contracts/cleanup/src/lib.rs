//! Retiring a factory. NEAR locks NEAR for every byte an account stores, and
//! the factory stores its own code plus the clause code (about 420 KB, about
//! 4.2 NEAR). To get that back, the account owner deploys this small contract
//! over the factory and calls `clean` with the storage keys to remove (read
//! them with the RPC `view_state` call). Only the account itself may call it,
//! which means only its own full-access key. After that the NEAR is spendable,
//! and the account is small enough to delete if the owner wants.
//!
//! It has no state, no other methods and no way to move funds. It avoids a
//! JSON parser to stay tiny, so it locks almost nothing itself.
//!
//! Input (raw bytes, not JSON): repeated `[u16 little-endian length][key bytes]`.

use near_sdk::{env, require};

/// Splits `[u16 LE len][bytes]...` into keys. Panics on a truncated input.
pub fn parse_keys(input: &[u8]) -> Vec<&[u8]> {
    let mut keys = Vec::new();
    let mut i = 0;
    while i < input.len() {
        require!(i + 2 <= input.len(), "BAD_INPUT");
        let len = u16::from_le_bytes([input[i], input[i + 1]]) as usize;
        i += 2;
        require!(i + len <= input.len(), "BAD_INPUT");
        keys.push(&input[i..i + len]);
        i += len;
    }
    keys
}

#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn clean() {
    require!(env::predecessor_account_id() == env::current_account_id(), "ONLY_SELF");
    let input = env::input().unwrap_or_default();
    for key in parse_keys(&input) {
        env::storage_remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::parse_keys;

    #[test]
    fn splits_length_prefixed_keys() {
        let input = [4, 0, b'C', b'O', b'D', b'E', 1, 0, 7, 0, 0];
        let keys = parse_keys(&input);
        assert_eq!(keys, vec![&b"CODE"[..], &[7u8][..], &[][..]]);
    }

    #[test]
    #[should_panic(expected = "BAD_INPUT")]
    fn refuses_a_truncated_key() {
        parse_keys(&[5, 0, b'a']);
    }
}
