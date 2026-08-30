use sha2::{Digest, Sha256};

pub fn hash_password(password: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.update(salt.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result)
}

pub fn verify_password(password: &str, salt: &str, expected_hash: &str) -> bool {
    hash_password(password, salt) == expected_hash
}
