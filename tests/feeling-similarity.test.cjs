const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const similarity = require('../dist/feeling-similarity.js');

test('all and only 50 uploaded expressions can be compared as AI qualities', () => {
  const source = fs.readFileSync(path.join(__dirname, '../dance_descriptions.txt'), 'utf8');
  const labels = [...source.matchAll(/^- (.+?) \(/gm)].map(match => match[1]);
  assert.equal(labels.length, 50);
  assert.deepEqual([...similarity.vocabulary].sort(), labels.sort());
  for (const label of labels) assert.equal(similarity.compare(label, [label]).score, 100);
});

test('short synonyms and Korean normalization match the same expression', () => {
  assert.equal(similarity.compare('유연', ['유연한']).score, 100);
  assert.equal(similarity.compare('슬픈', ['애절한']).score, 100);
  assert.equal(similarity.compare('통통', ['통통 튀는']).score, 100);
  assert.equal(similarity.compare('유연한'.normalize('NFD'), ['유연한']).score, 100);
});

test('related expression features overlap across the uploaded broad categories', () => {
  const related = similarity.compare('유연한', ['유려한']);
  const unrelated = similarity.compare('유연한', ['날카로운']);
  assert.ok(related.score > unrelated.score);
  assert.ok(related.score > 0 && related.score < 100);
  assert.equal(related.matched, '유려한');
  assert.match(related.reason, /의미 특징의 겹침/);
});

test('comparison chooses the closest actual AI expression without averaging away an exact match', () => {
  const result = similarity.compare('경쾌한', ['묵직한', '유연한', '경쾌한']);
  assert.equal(result.score, 100);
  assert.equal(result.matched, '경쾌한');
  assert.equal(similarity.compare('빠른', ['역동적인']).score, 57);
});

test('unknown or absent intent and missing AI qualities never get a fabricated numeric score', () => {
  for (const [intent, qualities] of [
    ['', ['유연한']], ['바나나', ['유연한']], ['유연한', []],
    ['유연한', ['not-an-ai-vocabulary-word']], [null, null],
    ['__proto__', ['유연한']], ['constructor', ['유연한']]
  ]) {
    assert.equal(similarity.compare(intent, qualities).score, null);
    assert.equal(similarity.compare(intent, qualities).matched, null);
  }
});

test('all dictionary scores are finite and bounded; input arrays stay unchanged', () => {
  for (const label of similarity.vocabulary) {
    const input = Object.freeze([...similarity.vocabulary].reverse());
    const result = similarity.compare(label, input);
    assert.ok(Number.isFinite(result.score) && result.score >= 0 && result.score <= 100);
  }
});
