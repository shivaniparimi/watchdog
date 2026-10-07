export function isEligible(total: number, member: boolean): boolean {
  return total > 50 && member;
}

export function couponValue(total: number): number {
  return total >= 100 ? 15 : 5;
}
