ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS summary_short TEXT,
    ADD COLUMN IF NOT EXISTS summary_medium TEXT,
    ADD COLUMN IF NOT EXISTS summary_long TEXT;

UPDATE documents
SET summary_medium = COALESCE(summary_medium, summary)
WHERE summary IS NOT NULL;

WITH doc_chunk_summaries AS (
    SELECT
        d.id AS document_id,
        MAX(NULLIF(c.tier3_meta->>'summary_short', '')) AS summary_short,
        MAX(NULLIF(c.tier3_meta->>'summary_medium', '')) AS summary_medium,
        MAX(NULLIF(c.tier3_meta->>'summary_long', '')) AS summary_long
    FROM documents d
    JOIN chunks c ON c.document_id = d.id
    GROUP BY d.id
)
UPDATE documents d
SET
    summary_short = COALESCE(d.summary_short, s.summary_short),
    summary_medium = COALESCE(d.summary_medium, s.summary_medium),
    summary_long = COALESCE(d.summary_long, s.summary_long),
    summary = COALESCE(d.summary, d.summary_medium, s.summary_medium, d.summary_short, s.summary_short)
FROM doc_chunk_summaries s
WHERE d.id = s.document_id;