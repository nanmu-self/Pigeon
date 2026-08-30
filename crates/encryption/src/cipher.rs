use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use rand::Rng;

pub fn encrypt(plaintext: &str, key: &[u8; 32]) -> Result<String, String> {
    let cipher = Aes256Gcm::new(key.into());
    let mut rng = rand::thread_rng();
    let mut nonce_bytes = [0u8; 12];
    rng.fill(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map(|ciphertext| {
            let mut combined = nonce_bytes.to_vec();
            combined.extend_from_slice(&ciphertext);
            general_purpose::STANDARD.encode(combined)
        })
        .map_err(|e| e.to_string())
}

pub fn decrypt(ciphertext_b64: &str, key: &[u8; 32]) -> Result<String, String> {
    let combined = general_purpose::STANDARD
        .decode(ciphertext_b64)
        .map_err(|e| e.to_string())?;

    if combined.len() < 12 {
        return Err("invalid ciphertext".to_string());
    }

    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new(key.into());

    cipher
        .decrypt(nonce, ciphertext)
        .map(|pt| String::from_utf8(pt).unwrap_or_default())
        .map_err(|e| e.to_string())
}
