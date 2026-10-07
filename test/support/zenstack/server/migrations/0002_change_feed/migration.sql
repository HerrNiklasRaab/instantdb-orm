-- The sync server learns of every committed write from the WAL (see
-- @upfor/sync ChangeFeed). An update must carry the whole old row, or the
-- feed cannot tell which buckets the row left; the server refuses to start
-- while a synced table lacks this.
DO $$
DECLARE
    t record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = current_schema() LOOP
        EXECUTE format('ALTER TABLE %I REPLICA IDENTITY FULL', t.tablename);
    END LOOP;
END $$;

CREATE PUBLICATION sync FOR ALL TABLES;
