const {test} = require('node:test');
const assert = require('node:assert/strict');
const {route} = require('../static/js/link-routing.js');

function crosses(a, b, box) {
  if (a.x === b.x) return a.x > box.x && a.x < box.x + box.w && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.h;
  return a.y > box.y && a.y < box.y + box.h && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.w;
}

test('rounded connectors route around intervening projects in either direction', () => {
  const from = {x: 60, y: 16, w: 160, h: 38}, to = {x: 300, y: 300, w: 120, h: 38};
  const blockers = [{x: 80, y: 105, w: 270, h: 38}, {x: 200, y: 210, w: 240, h: 38}];
  for (const [source, target] of [[from, to], [to, from]]) {
    const {path, points} = route(source, target, [from, to, ...blockers], 600, 400);
    assert.match(path, /^M /); assert.match(path, / Q /);
    assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i - 1].x === points[i].x || points[i - 1].y === points[i].y);
      for (const obstacle of blockers) assert.equal(crosses(points[i - 1], points[i], obstacle), false);
    }
    assert.equal(points[0].y, source.y + source.h);
    assert.equal(points.at(-1).y, target.y > source.y ? target.y : target.y + target.h);
  }
});

test('short adjacent cards and overlapping dates keep distinct, finite attachment points', () => {
  for (const to of [{x: 14, y: 16, w: 14, h: 38}, {x: 0, y: 84, w: 14, h: 38}]) {
    const from = {x: 0, y: 16, w: 14, h: 38}, boxes = [from, to];
    const forward = route(from, to, boxes, 300, 200), reverse = route(to, from, boxes, 300, 200);
    assert.ok(forward.points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    assert.notDeepEqual(forward.points[0], reverse.points.at(-1));
    assert.notEqual(forward.path, reverse.path);
  }
});

test('a card spanning the horizon can be bypassed through the right routing gutter', () => {
  const from = {x: 100, y: 16, w: 120, h: 38}, to = {x: 100, y: 210, w: 120, h: 38};
  const wall = {x: 0, y: 110, w: 600, h: 38};
  const {points} = route(from, to, [from, wall, to], 624, 310);
  assert.ok(points.some(p => p.x > 600));
  for (let i = 1; i < points.length; i++) assert.equal(crosses(points[i - 1], points[i], wall), false);
});
