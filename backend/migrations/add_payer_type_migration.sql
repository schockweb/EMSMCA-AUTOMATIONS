-- ═══════════════════════════════════════════════════════════
-- Migration: Add payer_type routing columns
-- EMS Claims Platform — Payer-type-aware invoice routing
-- ═══════════════════════════════════════════════════════════

-- 1. Add payer_type discriminator to scheme_configs
--    SCHEME = direct medical scheme billing (Discovery, GEMS, etc.)
--    AGGREGATOR = B2B aggregator billing (ER24, Netcare 911, etc.)
ALTER TABLE scheme_configs
    ADD COLUMN IF NOT EXISTS payer_type VARCHAR(20) NOT NULL DEFAULT 'SCHEME';

ALTER TABLE scheme_configs
    ADD CONSTRAINT ck_scheme_configs_payer_type
    CHECK (payer_type IN ('SCHEME', 'AGGREGATOR'));

-- 2. Add dispatch_reference_number to claims
--    Used when billing an AGGREGATOR — stores the CAD/dispatch reference
ALTER TABLE claims
    ADD COLUMN IF NOT EXISTS dispatch_reference_number VARCHAR(100) NULL;

COMMENT ON COLUMN scheme_configs.payer_type IS 'SCHEME (e.g. Discovery, GEMS) or AGGREGATOR (e.g. ER24, Netcare 911)';
COMMENT ON COLUMN claims.dispatch_reference_number IS 'CAD/Dispatch reference — used when billing an AGGREGATOR payer';
