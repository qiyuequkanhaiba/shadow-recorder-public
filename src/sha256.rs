//! Streaming SHA-256 over the `sha2` crate. Files are hashed in fixed-size reads.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

#[cfg_attr(not(test), allow(dead_code))]
pub fn sha256_hex(data: &[u8]) -> String {
    to_hex(&Sha256::digest(data))
}

pub fn sha256_file_hex(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 65536];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sha256_file_matches_bytes_across_read_buffer() {
        let dir = std::env::temp_dir().join(format!("s3-sha-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blob.bin");
        let mut payload = vec![0x61u8; 70_000];
        payload.extend_from_slice(b"abc");
        {
            let mut file = File::create(&path).unwrap();
            file.write_all(&payload).unwrap();
        }
        let from_file = sha256_file_hex(&path).unwrap();
        let from_bytes = sha256_hex(&payload);
        assert_eq!(from_file, from_bytes);
        assert_ne!(from_file, sha256_hex(b""));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
