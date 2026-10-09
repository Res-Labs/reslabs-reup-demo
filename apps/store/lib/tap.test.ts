import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectSession, tapToken } from "./tap";

const ORIGIN = "https://verify.reslabs.ai";
const BATCH_ID = "6f1d2c3b-4a59-4e68-9d7c-8b0a1f2e3d4c";
const TAP_ID = "0b8e4f2a-7c31-4d9e-a5b6-c7d8e9f0a1b2";

const DECISION = {
  variant: "success",
  verified: true,
  tap: { id: TAP_ID, note: "synthetic field outside the projection" },
  batch: { id: BATCH_ID, batch_code: "DEMO-0001", product_name: "Demo Compound 10 mg" },
  provenance_summary: { brand_name: "Demo Vendor" },
  coa: { lab_coa_url: "https://verify.reslabs.ai/coa/demo.pdf" },
  extra: { note: "synthetic field outside the projection" },
};

function body(change: Record<string, unknown>): string {
  return JSON.stringify({ ...DECISION, ...change });
}

describe("tapToken", () => {
  it("returns t from a /v/p link on the Res Labs link origin", () => {
    assert.equal(tapToken("https://verify.reslabs.ai/v/p?t=abc123", ORIGIN), "abc123");
  });

  for (const link of [
    "https://api.reslabs.ai/v/p?t=abc123",
    "http://localhost:4010/v/p?t=abc123",
    "http://verify.reslabs.ai/v/p?t=abc123",
    "https://verify.reslabs.ai/v/verified?t=abc123",
    "https://verify.reslabs.ai/v/p",
    "https://verify.reslabs.ai/v/p?t=",
    "verify.reslabs.ai/v/p?t=abc123",
  ]) {
    it(`rejects ${link}`, () => {
      assert.equal(tapToken(link, ORIGIN), null);
    });
  }
});

describe("projectSession", () => {
  it("returns only the projection of a verified decision for the demo batch", () => {
    assert.deepEqual(projectSession(200, body({}), BATCH_ID), {
      kind: "verified",
      tap: {
        tapId: TAP_ID,
        batchId: BATCH_ID,
        batchCode: "DEMO-0001",
        productName: "Demo Compound 10 mg",
        vendorName: "Demo Vendor",
        coaUrl: "https://verify.reslabs.ai/coa/demo.pdf",
      },
    });
  });

  it("projects a COA without a lab URL as an empty coa_url", () => {
    assert.deepEqual(projectSession(200, body({ coa: { lab_coa_url: null } }), BATCH_ID), {
      kind: "verified",
      tap: {
        tapId: TAP_ID,
        batchId: BATCH_ID,
        batchCode: "DEMO-0001",
        productName: "Demo Compound 10 mg",
        vendorName: "Demo Vendor",
        coaUrl: "",
      },
    });
  });

  it("maps 401 to link_expired", () => {
    assert.deepEqual(projectSession(401, "", BATCH_ID), {
      kind: "rejected",
      error: "link_expired",
    });
  });

  for (const status of [404, 429, 500, 503]) {
    it(`maps ${status} to reslabs_unavailable`, () => {
      assert.deepEqual(projectSession(status, body({}), BATCH_ID), {
        kind: "rejected",
        error: "reslabs_unavailable",
      });
    });
  }

  for (const [name, text] of [
    ["a failed variant", body({ variant: "error" })],
    ["an unverified tap", body({ verified: false })],
    ["a tap id that is not a UUID", body({ tap: { id: "tap-1" } })],
    [
      "another vendor batch",
      body({ batch: { ...DECISION.batch, id: "7a2e3d4c-5b6a-4f79-8e0d-9c1b2a3f4e5d" } }),
    ],
    [
      "a decision without a product name",
      body({ batch: { id: BATCH_ID, batch_code: "DEMO-0001" } }),
    ],
    ["a body that is not JSON", "<html>verified</html>"],
  ] as const) {
    it(`maps a 200 with ${name} to not_eligible`, () => {
      assert.deepEqual(projectSession(200, text, BATCH_ID), {
        kind: "rejected",
        error: "not_eligible",
      });
    });
  }
});
