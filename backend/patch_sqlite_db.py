import sqlite3

def run_patches():
    conn = sqlite3.connect("ems.db")
    cursor = conn.cursor()
    
    patches = [
        # audit_logs
        "ALTER TABLE audit_logs ADD COLUMN before_state JSON;",
        "ALTER TABLE audit_logs ADD COLUMN after_state JSON;",
        "ALTER TABLE audit_logs ADD COLUMN notes TEXT;",
        
        # digital_prfs
        "ALTER TABLE digital_prfs ADD COLUMN correction_of_id UUID REFERENCES digital_prfs(id);",
        "ALTER TABLE digital_prfs ADD COLUMN geo_locations JSON;",
        "ALTER TABLE digital_prfs ADD COLUMN review_flags JSON NOT NULL DEFAULT '[]';",
        "ALTER TABLE digital_prfs ADD COLUMN billing_schema_code VARCHAR(50);",
        "ALTER TABLE digital_prfs ADD COLUMN processing_error TEXT;",
        "ALTER TABLE digital_prfs ADD COLUMN processing_attempts INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE digital_prfs ADD COLUMN last_processing_at DATETIME;",
        
        # claims
        "ALTER TABLE claims ADD COLUMN voided BOOLEAN NOT NULL DEFAULT 0;",
        "ALTER TABLE claims ADD COLUMN voided_at DATETIME;",
        "ALTER TABLE claims ADD COLUMN voided_by UUID REFERENCES users(id);",
        "ALTER TABLE claims ADD COLUMN voided_reason TEXT;",
        "ALTER TABLE claims ADD COLUMN amended_by_id UUID REFERENCES claims(id);"
    ]
    
    for sql in patches:
        try:
            cursor.execute(sql)
            print(f"✓ Executed: {sql}")
        except sqlite3.OperationalError as e:
            # Column already exists, safe to ignore
            print(f"⚠ Ignored: {e}")
            
    conn.commit()
    conn.close()
    print("Database patched successfully.")

if __name__ == "__main__":
    run_patches()
