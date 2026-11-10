// @ts-check
export async function ledger() {
  const { items } = await this.read();
  return items
    .filter(
      (x) => x.kind === "transaction" && !x.deleted && !x.validationErrors,
    )
    .flatMap((t) => {
      const n = t.amountMinor;
      let debit, credit;
      switch (t.transactionType) {
        case "expense":
          debit = "expense:" + (t.category || "unclassified");
          credit = t.accountId;
          break;
        case "income":
          debit = t.accountId;
          credit = "income:general";
          break;
        case "refund":
          debit = t.accountId;
          credit = "expense:" + (t.category || "unclassified");
          break;
        case "opening":
          debit = t.accountId;
          credit = "equity:opening";
          break;
        case "opening_debt":
          debit = "equity:opening";
          credit = t.accountId;
          break;
        default:
          debit = t.otherAccountId;
          credit = t.accountId;
      }
      return [
        { transactionId: t.id, account: debit, debit: n, credit: 0 },
        { transactionId: t.id, account: credit, debit: 0, credit: n },
      ];
    });
}
