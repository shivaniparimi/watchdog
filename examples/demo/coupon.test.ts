import { expect, it } from "vitest";

import { couponValue, isEligible } from "./coupon";

it("non-members aren't eligible", () => {
  expect(isEligible(10, false)).toBe(false);
});

it("big orders get the larger coupon", () => {
  expect(couponValue(150)).toBe(15);
  expect(couponValue(20)).toBe(5);
});
