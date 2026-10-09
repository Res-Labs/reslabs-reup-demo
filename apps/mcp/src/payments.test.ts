import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChallengeGuard, decideCharge, PaymentRefused } from "./payments";

const PATH_USD = "0x20c0000000000000000000000000000000000000";
const OTHER_TOKEN = "0x20c0000000000000000000000000000000000001";

const challenge = (amount: string, currency = PATH_USD) => ({ request: { amount, currency } });
const credential = { createCredential: async () => "Payment credential" };

describe("decideCharge", () => {
  it("allows pathUSD in any letter case", () => {
    assert.deepEqual(
      decideCharge({ amount: "1000", currency: "0x20C0000000000000000000000000000000000000" }, 0n),
      { kind: "allow", amount: 1000n, spentAfter: 1000n },
    );
  });

  it("refuses any other currency", () => {
    assert.deepEqual(decideCharge({ amount: "1000", currency: OTHER_TOKEN }, 0n), {
      kind: "refuse",
      reason: `currency ${OTHER_TOKEN} is not pathUSD`,
    });
  });

  it("refuses a missing currency", () => {
    assert.deepEqual(decideCharge({ amount: "1000" }, 0n), {
      kind: "refuse",
      reason: "currency undefined is not pathUSD",
    });
  });

  it("refuses an amount that is not a base-unit integer", () => {
    assert.deepEqual(decideCharge({ amount: "1.00", currency: PATH_USD }, 0n), {
      kind: "refuse",
      reason: "amount 1.00 is not a base-unit integer",
    });
  });

  it("allows exactly 1.10 pathUSD and refuses one base unit more", () => {
    assert.deepEqual(decideCharge({ amount: "1100000", currency: PATH_USD }, 0n), {
      kind: "allow",
      amount: 1_100_000n,
      spentAfter: 1_100_000n,
    });
    assert.deepEqual(decideCharge({ amount: "1100001", currency: PATH_USD }, 0n), {
      kind: "refuse",
      reason: "amount 1100001 exceeds the per-charge limit of 1100000",
    });
  });

  it("allows reaching exactly 10.00 pathUSD and refuses going past it", () => {
    assert.deepEqual(decideCharge({ amount: "1100000", currency: PATH_USD }, 8_900_000n), {
      kind: "allow",
      amount: 1_100_000n,
      spentAfter: 10_000_000n,
    });
    assert.deepEqual(decideCharge({ amount: "1100000", currency: PATH_USD }, 8_900_001n), {
      kind: "refuse",
      reason:
        "amount 1100000 would bring this session's spend to 10000001, over the cap of 10000000",
    });
  });
});

describe("createChallengeGuard", () => {
  it("returns the credential for an allowed charge", async () => {
    const guard = createChallengeGuard();
    assert.equal(await guard(challenge("1000"), credential), "Payment credential");
  });

  it("throws instead of signing when it refuses", async () => {
    const guard = createChallengeGuard();
    let signed = false;
    const signer = {
      createCredential: async () => {
        signed = true;
        return "Payment credential";
      },
    };
    await assert.rejects(guard(challenge("1000", OTHER_TOKEN), signer), PaymentRefused);
    assert.equal(signed, false);
  });

  it("accumulates spend across charges up to exactly the cap", async () => {
    const guard = createChallengeGuard();
    for (let i = 0; i < 9; i++) await guard(challenge("1100000"), credential);
    assert.equal(await guard(challenge("100000"), credential), "Payment credential");
    await assert.rejects(guard(challenge("1"), credential), {
      name: "PaymentRefused",
      message: "amount 1 would bring this session's spend to 10000001, over the cap of 10000000",
    });
  });

  it("never gives spend back, even when signing fails after the check", async () => {
    const guard = createChallengeGuard();
    const failingSigner = {
      createCredential: async () => {
        throw new Error("signing failed");
      },
    };
    for (let i = 0; i < 9; i++) {
      await assert.rejects(guard(challenge("1100000"), failingSigner), {
        message: "signing failed",
      });
    }
    await assert.rejects(guard(challenge("1000000"), credential), PaymentRefused);
    await assert.rejects(guard(challenge("1000000"), credential), PaymentRefused);
    assert.equal(await guard(challenge("100000"), credential), "Payment credential");
  });
});
