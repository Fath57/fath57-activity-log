export function createMonthlyPartitionSql(pDate: Date): string {
  const year = pDate.getUTCFullYear();
  const month = String(pDate.getUTCMonth() + 1).padStart(2, '0');
  const dateStr = `${year}-${month}-01`;
  return `SELECT audit.create_monthly_partition('${dateStr}'::DATE);`;
}

export function getInitialPartitionStatements(
  startDate: Date = new Date(),
  monthsAhead: number = 4,
): string[] {
  const statements: string[] = [];
  for (let i = 0; i < monthsAhead; i++) {
    const d = new Date(
      Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + i, 1),
    );
    statements.push(createMonthlyPartitionSql(d));
  }
  return statements;
}
