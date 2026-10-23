import assert from "node:assert/strict";
import test from "node:test";
import {DEMO_EXAMPLES, createRateLimiter, findExample} from "./demo";

test("el limitador bloquea al superar el máximo y libera al vencer la ventana", () => {
  let now = 0;
  const allow = createRateLimiter(2, 1000, () => now);
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), true);
  assert.equal(allow("ip"), false);
  assert.equal(allow("otra-ip"), true);
  now = 1001;
  assert.equal(allow("ip"), true);
});

test("solo se aceptan ejemplos de la lista fija", () => {
  assert.equal(findExample("detected-risk").expectedOutcome, "TRUE_POSITIVE");
  assert.throws(() => findExample("TY4D33GnRACD8gnXyDhLnDpbeYaT8SY55D"), /no existe/);
  assert.throws(() => findExample(undefined), /no existe/);
});

test("los ejemplos tienen direcciones TRON válidas, fechas ISO e identificadores únicos", () => {
  const ids = new Set(DEMO_EXAMPLES.map((item) => item.id));
  assert.equal(ids.size, DEMO_EXAMPLES.length);
  for (const item of DEMO_EXAMPLES) {
    assert.match(item.address, /^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    assert.ok(Number.isFinite(Date.parse(item.asOf)));
  }
});
