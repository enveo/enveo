-- Bariera kursora sync (naprawa wyścigu MAX(seq) vs transakcje in-flight).
--
-- `changes.seq` (BIGSERIAL) jest przydzielany przy INSERT, ale widoczny
-- dopiero po COMMIT — kolejność commitów NIE pokrywa się z kolejnością seq.
-- Kursor liczony jako MAX(seq) mógł więc przeskoczyć seq transakcji jeszcze
-- niezacommitowanej (np. długiego importu): klient dostawał kursor > N zanim
-- N stał się widoczny i już NIGDY nie pobierał tej zmiany (trwały, cichy
-- rozjazd repliki).
--
-- Rozwiązanie: każdy pisarz logu bierze WSPÓŁDZIELONY advisory xact lock
-- ZANIM dostanie seq (tu, w triggerach — pokrywa REST, push, importy, seed
-- i kaskady FK); czytelnik kursora (snapshot/pull w routes/sync.ts) bierze
-- ten sam lock na WYŁĄCZNOŚĆ, więc czeka aż wszystkie rozpoczęte zapisy
-- się zakończą i wstrzymuje nowe na czas odczytu — MAX(seq) widzi wtedy
-- każdy przydzielony seq. Klucz locka: hashtext('enveo:changes') — musi
-- zgadzać się z routes/sync.ts.
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
