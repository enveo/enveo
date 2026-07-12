-- Rebranding klucza advisory locka bariery sync: hashtext('enveo:changes').
--
-- Funkcje z 0005 są już wdrożone na istniejących bazach ze STARYM kluczem —
-- ta migracja podmienia je (CREATE OR REPLACE) tak, by klucz zgadzał się
-- z routes/sync.ts po zmianie nazwy. Na świeżych bazach to no-op semantyczny
-- (0005 tworzy je już z nowym kluczem). Sama wartość klucza jest dowolna —
-- musi być tylko IDENTYCZNA po stronie pisarzy (triggery) i czytelnika kursora.
CREATE OR REPLACE FUNCTION log_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('enveo:changes')::bigint);
  IF TG_OP = 'DELETE' THEN
    INSERT INTO changes (table_name, row_id, op) VALUES (TG_TABLE_NAME, OLD.id, 'delete');
    RETURN OLD;
  END IF;
  INSERT INTO changes (table_name, row_id, op) VALUES (TG_TABLE_NAME, NEW.id, 'upsert');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION log_txn_item_change() RETURNS trigger AS $$
DECLARE tid uuid;
BEGIN
  tid := COALESCE(NEW.transaction_id, OLD.transaction_id);
  -- strażnik: przy kaskadzie DELETE rodzica rodzic już nie istnieje —
  -- nie loguj (wystarczy jego własny wpis 'delete')
  IF EXISTS (SELECT 1 FROM transactions WHERE id = tid) THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('enveo:changes')::bigint);
    INSERT INTO changes (table_name, row_id, op) VALUES ('transactions', tid, 'upsert');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
