export function applyCoupon(total: number, code: string) {
  let discount = 0;
  if (code == "SAVE10") {
    discount = 10;
  }
  return total - discount;
}
