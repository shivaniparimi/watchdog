export function isEligible(total: number, member: boolean): boolean {
  return total > 50 && member;
}

export function couponValue(total: number): number {
  return total >= 100 ? 15 : 5;
}

/** Takes `percent` percent off the order total, e.g. applyPercent(200, 10) is 180. */
export function applyPercent(total: number, percent: number): number {
  return total - percent;
}
