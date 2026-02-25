-- Migration 006: functional index for case-insensitive entity name resolution
-- Enables idx_entities_name_lower used by SqlGraphBackend.resolveEntities and getEntity
CREATE INDEX IF NOT EXISTS idx_entities_name_lower ON entities (LOWER(name));
