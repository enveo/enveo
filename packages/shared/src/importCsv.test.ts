import { describe, expect, test } from "bun:test";
import { applyCsvHistory, csvRowsToRecognition, findCsvTable, parseCsv, parseCsvAmount, parseCsvDate, readCsvRows, suggestCsvMapping } from "./importCsv";
import { importJobResultSchema } from "./importJobs";
import { reconcileImportProposals } from "./importRecognition";
import type { Account, ClientLedger } from "./types";

const anAccount: Account = {
  id: "00000000-0000-4000-8000-000000000003",
  name: "Checking",
  color: "#000000",
  icon: "wallet",
  type: "checking",
  onBudget: true,
  initialBalance: 0,
  archived: false,
  sort: 0,
  automaticEnvelopeId: null,
};

const table = (text: string) => findCsvTable(parseCsv(text))!;

describe("CSV parsing", () => {
  test("given quoted cells with delimiters and doubled quotes when parsed then the cells stay whole", () => {
    expect(parseCsv('date;name;amount\n2026-09-01;"Oak; ""Rentals""";-10,50\n')).toEqual([
      ["date", "name", "amount"],
      ["2026-09-01", 'Oak; "Rentals"', "-10,50"],
    ]);
  });

  test("given a byte order mark and tabs when parsed then the delimiter and first header are clean", () => {
    expect(parseCsv("﻿date\tamount\r\n2026-09-01\t-1.00\r\n")[0]).toEqual(["date", "amount"]);
  });

  test("given account details above the table when located then the header is the row above the first dated row", () => {
    const found = table("Account;Everyday Checking\n\nDate;Title;Amount\n01.09.2026;Linden Market;-42,50\n02.09.2026;Example Corp;3000,00\n");
    expect(found.headers).toEqual(["Date", "Title", "Amount"]);
    expect(found.rows).toHaveLength(2);
  });

  test("given no header row when located then columns get numbers", () => {
    expect(table("2026-09-01,Linden Market,-4.25\n2026-09-02,Oak Rentals,-9.00\n").headers).toEqual(["#1", "#2", "#3"]);
  });
});

describe("CSV amounts", () => {
  test.each([
    ["1 234,56", 123456],
    ["1.234,56", 123456],
    ["1,234.56", 123456],
    ["-42,50 USD", -4250],
    ["$12.00", 1200],
    ["(12.00)", -1200],
    ["12.00-", -1200],
    ["1,234", 123400],
    ["7", 700],
    ["1'234.5", 123450],
  ])("given %s when read then it is %d minor units", (cell, expected) => {
    expect(parseCsvAmount(cell)).toBe(expected);
  });

  test("given text when read then it is not an amount", () => {
    expect(parseCsvAmount("Linden Market 12")).toBeNull();
    expect(parseCsvAmount("")).toBeNull();
  });
});

describe("CSV dates", () => {
  test("given each order when read then the date is calendar correct", () => {
    expect(parseCsvDate("2026-09-01", "dmy")).toBe("2026-09-01");
    expect(parseCsvDate("01.09.2026", "dmy")).toBe("2026-09-01");
    expect(parseCsvDate("09/01/2026", "mdy")).toBe("2026-09-01");
    expect(parseCsvDate("31/02/2026", "dmy")).toBeNull();
  });

  test("given a day above twelve in the second position when suggested then the file is read month first", () => {
    const found = table("date,memo,amount\n09/28/2026,Linden Market,-4.25\n");
    expect(suggestCsvMapping(found).dateOrder).toBe("mdy");
  });
});

describe("CSV mapping", () => {
  test("given Polish headers when suggested then columns are found", () => {
    const found = table("Data operacji;Kontrahent;Tytuł;Kwota\n01.09.2026;Linden Market;zakupy;-42,50\n");
    expect(suggestCsvMapping(found)).toMatchObject({ date: 0, payee: 1, description: 2, amount: 3 });
  });

  test("given separate debit and credit columns when read then the sign comes from the column", () => {
    const found = table("Date,Description,Debit,Credit\n2026-09-01,Linden Market,42.50,\n2026-09-02,Example Corp,,3000.00\n");
    const mapping = suggestCsvMapping(found);
    expect(mapping).toMatchObject({ moneyOut: 2, moneyIn: 3, amount: null });
    expect(readCsvRows(found, mapping).rows.map((row) => row.amount)).toEqual([-4250, 300000]);
  });

  test("given only a debit column when read then every row stays money out", () => {
    const found = table("Date,Payee,Debit\n2026-09-01,Linden Market,42.50\n2026-09-02,Oak Rentals,9.00\n");
    const mapping = suggestCsvMapping(found);
    expect(mapping).toMatchObject({ moneyOut: 2, moneyIn: null, amount: null });
    expect(readCsvRows(found, mapping).rows.map((row) => row.amount)).toEqual([-4250, -900]);
  });

  test("given a debit or credit marker beside a signed amount when suggested then the amount column is used", () => {
    const found = table("Date,Payee,Debit/credit,Amount\n2026-09-01,Linden Market,Debit,-42.50\n2026-09-02,Example Corp,Credit,3000.00\n");
    const mapping = suggestCsvMapping(found);
    expect(mapping).toMatchObject({ amount: 3, moneyOut: null, moneyIn: null });
    expect(readCsvRows(found, mapping).rows.map((row) => row.amount)).toEqual([-4250, 300000]);
  });

  test("given a row without an amount when read then it is counted and not guessed", () => {
    const found = table("date,memo,amount\n2026-09-01,Linden Market,-4.25\n2026-09-02,Balance,\n");
    const reading = readCsvRows(found, suggestCsvMapping(found));
    expect(reading.rows).toHaveLength(1);
    expect(reading.unreadable).toBe(1);
  });

  test("given identical rows when read then each stays a separate transaction with its own reference", () => {
    const found = table("date,memo,amount\n2026-09-01,City Bus,-2.50\n2026-09-01,City Bus,-2.50\n");
    expect(readCsvRows(found, suggestCsvMapping(found)).rows.map((row) => row.text)).toEqual(["City Bus", "City Bus #2"]);
  });
});

describe("CSV recognition", () => {
  test("given read rows when converted then the result passes the import job schema", () => {
    const found = table("date,payee,memo,amount\n2026-09-01,Linden Market,weekly,-4.25\n2026-09-02,Example Corp,pay,30.00\n");
    const result = csvRowsToRecognition(readCsvRows(found, suggestCsvMapping(found)).rows, "USD");
    expect(importJobResultSchema.safeParse(result).success).toBe(true);
    expect(result.proposals.map((proposal) => [proposal.type, proposal.amount, proposal.placeName])).toEqual([
      ["expense", 425, "Linden Market"],
      ["income", 3000, "Example Corp"],
    ]);
  });
});

describe("CSV history", () => {
  const groupId = "00000000-0000-4000-8000-000000000001";
  const envelopeId = "00000000-0000-4000-8000-000000000002";
  const accountId = "00000000-0000-4000-8000-000000000003";
  const ledger = (transactions: ClientLedger["transactions"]): ClientLedger => ({
    budgets: [],
    accounts: [
      {
        id: accountId,
        name: "Checking",
        color: "#000000",
        icon: "wallet",
        type: "checking",
        onBudget: true,
        initialBalance: 0,
        archived: false,
        sort: 0,
        automaticEnvelopeId: null,
      },
    ],
    groups: [{ id: groupId, name: "Living", sort: 0 }],
    envelopes: [
      {
        id: envelopeId,
        groupId,
        name: "Groceries",
        color: "#000000",
        icon: "tag",
        note: null,
        monthlyTarget: null,
        isSavings: false,
        sort: 0,
        archived: false,
      },
    ],
    categories: [],
    places: [],
    allocations: [],
    transactions,
  });
  const earlier: ClientLedger["transactions"][number] = {
    id: "00000000-0000-4000-8000-000000000004",
    type: "expense",
    accountId,
    toAccountId: null,
    amount: 1000,
    date: "2026-08-01",
    isRefund: false,
    envelopeId,
    placeId: null,
    categoryId: null,
    name: "Linden Market",
    note: null,
    tag: "LINDEN MARKET",
    sourceRef: "Linden Market",
    allocationFromEnvelopeId: null,
    allocationToEnvelopeId: null,
    items: [],
    createdAt: "2026-08-01T12:00:00.000Z",
  };
  const recognition = (text: string) => {
    const found = table(`date,payee,amount\n2026-09-01,${text},-4.25\n`);
    return csvRowsToRecognition(readCsvRows(found, suggestCsvMapping(found)).rows, "USD");
  };

  test("given a merchant used before when enriched then the envelope follows the past choice", () => {
    expect(applyCsvHistory(recognition("Linden Market"), ledger([earlier]), accountId, "USD").proposals[0]!.envelopeId).toBe(envelopeId);
  });

  test("given an unknown merchant when enriched then the envelope stays blank", () => {
    expect(applyCsvHistory(recognition("Oak Rentals"), ledger([earlier]), accountId, "USD").proposals[0]!.envelopeId).toBeNull();
  });

  test("given the same merchant once left without an envelope when enriched then history abstains", () => {
    const unassigned = { ...earlier, id: "00000000-0000-4000-8000-000000000006", envelopeId: null };
    expect(applyCsvHistory(recognition("Linden Market"), ledger([earlier, unassigned]), accountId, "USD").proposals[0]!.envelopeId).toBeNull();
  });

  test("given two rows of one payee with different descriptions when enriched then each is matched on its own text", () => {
    const sourced = { ...earlier, name: "Fresh Mart", tag: "FRESH MART", sourceRef: "Linden Market Weekly shop" };
    const found = table("date,payee,memo,amount\n2026-09-01,Linden Market,Weekly shop,-4.25\n2026-09-02,Linden Market,Dinner,-9.00\n");
    const result = applyCsvHistory(csvRowsToRecognition(readCsvRows(found, suggestCsvMapping(found)).rows, "USD"), ledger([sourced]), accountId, "USD");
    expect(result.proposals.map((proposal) => proposal.envelopeId)).toEqual([envelopeId, null]);
  });
});

describe("CSV review findings", () => {
  test.each(["12.3456", "0.125", "1,23,45.67", "1.234.5", "12,3456"])("given %s when read then it has no single reading and is refused", (cell) => {
    expect(parseCsvAmount(cell)).toBeNull();
  });

  test.each([
    ["1,234,567.89", 123456789],
    ["1.234.567,89", 123456789],
    ["1,234,567", 123456700],
    ["0.50", 50],
    ["€12,50", 1250],
    ["12,50 zł", 1250],
    ["+3 000,00", 300000],
  ])("given %s when read then the one reading is %d", (cell, expected) => {
    expect(parseCsvAmount(cell)).toBe(expected);
  });

  test("given a payment and its refund on one day when reconciled then both stay in either order", () => {
    for (const lines of [
      ["2026-09-01,Maple Store,-25.00", "2026-09-01,Maple Store,25.00"],
      ["2026-09-01,Maple Store,25.00", "2026-09-01,Maple Store,-25.00"],
    ]) {
      const found = table(`date,memo,amount\n${lines.join("\n")}\n`);
      const { proposals } = csvRowsToRecognition(readCsvRows(found, suggestCsvMapping(found)).rows, "USD");
      const reconciled = reconcileImportProposals({
        proposals,
        transactions: [],
        accounts: [anAccount],
        envelopes: [],
        categories: [],
        selectedAccountId: anAccount.id,
      });
      expect(reconciled.map((proposal) => proposal.disposition)).toEqual(["candidate", "candidate"]);
    }
  });

  test("given commas inside semicolon cells when parsed then the semicolon wins", () => {
    const records = parseCsv("date;memo;amount\n2026-09-01;Oak, Rentals, deposit;-1,50\n2026-09-02;Linden, Market;-2,50\n");
    expect(records[1]).toEqual(["2026-09-01", "Oak, Rentals, deposit", "-1,50"]);
  });

  test("given one comma row whose memo holds a semicolon when parsed then the comma still wins", () => {
    const found = table("date,amount,memo\n2026-09-01,-4.25,Shop;12\n");
    expect(found.headers).toEqual(["date", "amount", "memo"]);
    expect(readCsvRows(found, suggestCsvMapping(found)).rows.map((row) => row.amount)).toEqual([-425]);
  });

  test("given semicolons inside comma cells when parsed then the comma wins", () => {
    const found = table("date,memo,amount\n2026-09-01,Maple; Oak,-4.25\n2026-09-02,Pine; Cedar,-9.00\n");
    expect(found.headers).toEqual(["date", "memo", "amount"]);
    expect(readCsvRows(found, suggestCsvMapping(found)).rows).toHaveLength(2);
  });

  test("given a wider preamble above the table when located then the transaction table is found", () => {
    const found = table(
      "Owner;Account;Branch;Currency;Opened\nA;B;C;USD;2020-01-01\n\ndate;memo;amount\n2026-09-01;Linden Market;-4,25\n2026-09-02;Oak Rentals;-9,00\n",
    );
    expect(found.headers).toEqual(["date", "memo", "amount"]);
    expect(found.rows).toHaveLength(2);
  });

  test("given two envelopes with one name when enriched then history abstains instead of guessing", () => {
    const groupId = "00000000-0000-4000-8000-000000000001";
    const accountId = anAccount.id;
    const first = "00000000-0000-4000-8000-000000000002";
    const second = "00000000-0000-4000-8000-000000000005";
    const envelope = (id: string) => ({
      id,
      groupId,
      name: "Groceries",
      color: "#000000",
      icon: "tag",
      note: null,
      monthlyTarget: null,
      isSavings: false,
      sort: 0,
      archived: false,
    });
    const ledger: ClientLedger = {
      budgets: [],
      accounts: [anAccount],
      groups: [{ id: groupId, name: "Living", sort: 0 }],
      envelopes: [envelope(first), envelope(second)],
      categories: [],
      places: [],
      allocations: [],
      transactions: [
        {
          id: "00000000-0000-4000-8000-000000000004",
          type: "expense",
          accountId,
          toAccountId: null,
          amount: 1000,
          date: "2026-08-01",
          isRefund: false,
          envelopeId: first,
          placeId: null,
          categoryId: null,
          name: "Linden Market",
          note: null,
          tag: "LINDEN MARKET",
          sourceRef: "Linden Market",
          allocationFromEnvelopeId: null,
          allocationToEnvelopeId: null,
          items: [],
          createdAt: "2026-08-01T12:00:00.000Z",
        },
      ],
    };
    const found = table("date,payee,amount\n2026-09-01,Linden Market,-4.25\n");
    const result = applyCsvHistory(csvRowsToRecognition(readCsvRows(found, suggestCsvMapping(found)).rows, "USD"), ledger, accountId, "USD");
    expect(result.proposals[0]!.envelopeId).toBeNull();
  });
});
