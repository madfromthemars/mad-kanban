import assert from 'node:assert/strict';

import * as v from '../src/team/vault/crypto';

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log('ok -', name);
};

const ann = v.newPersonKeys();
const bob = v.newPersonKeys();
const eve = v.newPersonKeys();

t('seal / open a secret; tampering is detected', () => {
  const key = v.newItemKey();
  const box = v.seal({ title: 'Prod DB', kind: 'login', fields: [{ label: 'password', value: 'hunter2', hidden: true }] }, key);
  assert.ok(!box.c.includes('hunter2') && !JSON.stringify(box).includes('Prod DB'));
  assert.equal(v.open(box, key).fields[0].value, 'hunter2');
  const bad = { ...box, c: v.b64.enc(v.b64.dec(box.c).map((b, i) => (i === 3 ? b ^ 1 : b))) };
  assert.throws(() => v.open(bad, key));
  assert.throws(() => v.open(box, v.newItemKey()));
});

t('share: only the recipient can unwrap', () => {
  const key = v.newItemKey();
  const w = v.wrapFor(key, v.publicOf(bob).boxPub, ann);
  assert.deepEqual(v.unwrap(w, bob), key);
  assert.throws(() => v.unwrap(w, eve));
  assert.throws(() => v.unwrap(w, ann)); // not even the sharer, with their own key
});

t('signatures: server can not forge or swap', () => {
  const key = v.newItemKey();
  const box = v.seal({ title: 'x', kind: 'note', fields: [] }, key);
  const sig = v.signText(v.itemSigMessage('i1', 'p1', 1, box), ann);
  assert.ok(v.verifyText(v.itemSigMessage('i1', 'p1', 1, box), sig, v.publicOf(ann).signPub));
  assert.ok(!v.verifyText(v.itemSigMessage('i1', 'p2', 1, box), sig, v.publicOf(ann).signPub), 'other project');
  assert.ok(!v.verifyText(v.itemSigMessage('i1', 'p1', 2, box), sig, v.publicOf(ann).signPub), 'other version');
  assert.ok(!v.verifyText(v.itemSigMessage('i1', 'p1', 1, box), sig, v.publicOf(eve).signPub), 'other signer');
  const w = v.wrapFor(key, v.publicOf(bob).boxPub, ann);
  const as = v.signText(v.accessSigMessage('i1', 'bob', w), ann);
  assert.ok(v.verifyText(v.accessSigMessage('i1', 'bob', w), as, v.publicOf(ann).signPub));
  assert.ok(!v.verifyText(v.accessSigMessage('i1', 'eve', w), as, v.publicOf(ann).signPub));
});

t('keys export / import; safety codes', () => {
  const back = v.importKeys(v.exportKeys(ann));
  assert.deepEqual(v.publicOf(back), v.publicOf(ann));
  const code = v.safetyCode(v.publicOf(ann));
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.notEqual(code, v.safetyCode(v.publicOf(bob)));
});

t('QR transfer: right link key opens, wrong does not', () => {
  const k = v.newTransferKey();
  const box = v.sealForTransfer(ann, k);
  assert.deepEqual(v.publicOf(v.openTransfer(box, k)), v.publicOf(ann));
  assert.throws(() => v.openTransfer(box, v.newTransferKey()));
});

t('allow-device: only the requesting device opens it; both see the same code', () => {
  const req = v.newRequestKeys();
  const pub = v.b64.enc(req.publicKey);
  assert.match(v.requestCode(pub), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const box = v.sealForRequest(ann, pub);
  assert.deepEqual(v.publicOf(v.openRequest(box, req.secretKey)), v.publicOf(ann));
  assert.throws(() => v.openRequest(box, v.newRequestKeys().secretKey));
});

t('recovery code: works with any spacing/case, wrong code fails', () => {
  const code = v.newRecoveryCode();
  assert.match(code, /^([A-Z2-9]{4}-){7}[A-Z2-9]{4}$/);
  const box = v.sealForRecovery(ann, code);
  assert.deepEqual(v.publicOf(v.openRecovery(box, code.toLowerCase().replace(/-/g, ' '))), v.publicOf(ann));
  assert.throws(() => v.openRecovery(box, v.newRecoveryCode()));
});

console.log(`${n} vault crypto tests passed`);
