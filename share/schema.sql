CREATE TABLE IF NOT EXISTS image_shares (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK(length(token_hash)=64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size>0 AND byte_size<=1048576),
  image BLOB NOT NULL CHECK(length(image)=byte_size)
);
CREATE INDEX IF NOT EXISTS image_shares_expiry ON image_shares(expires_at);