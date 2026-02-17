ALTER TABLE documents
ADD COLUMN IF NOT EXISTS payload_checksum TEXT;
