/* Orthogonal activity connectors, independent of the DOM. */
(function (root) {
  "use strict";
  const PAD = 8;
  const point = (x, y) => ({x, y});
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  function simplify(points) {
    const result = [];
    for (const p of points) {
      if (result.length && distance(result.at(-1), p) < .01) continue;
      while (result.length > 1) {
        const a = result.at(-2), b = result.at(-1);
        if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) result.pop();
        else break;
      }
      result.push(p);
    }
    return result;
  }

  function roundedPath(points) {
    if (points.length < 2) return "";
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1], b = points[i], c = points[i + 1];
      const ab = distance(a, b), bc = distance(b, c), r = Math.min(6, ab / 2, bc / 2);
      const enter = point(b.x + (a.x - b.x) * r / ab, b.y + (a.y - b.y) * r / ab);
      const leave = point(b.x + (c.x - b.x) * r / bc, b.y + (c.y - b.y) * r / bc);
      path += ` L ${enter.x} ${enter.y} Q ${b.x} ${b.y} ${leave.x} ${leave.y}`;
    }
    const last = points.at(-1);
    return path + ` L ${last.x} ${last.y}`;
  }

  // A* on the sparse coordinate grid formed by card edges; turns have a cost.
  function findRoute(start, end, boxes, width, height) {
    const obstacles = boxes.map(b => ({left: b.x - PAD, right: b.x + b.w + PAD, top: b.y - PAD, bottom: b.y + b.h + PAD}));
    const coordinates = (values, max) => [...new Set(values.filter(v => v >= 0 && v <= max))].sort((a, b) => a - b);
    const xs = coordinates([1, width - 1, start.x, end.x, ...obstacles.flatMap(b => [b.left, b.right])], width);
    const ys = coordinates([1, height - 1, start.y, end.y, ...obstacles.flatMap(b => [b.top, b.bottom])], height);
    const nx = xs.length, startNode = ys.indexOf(start.y) * nx + xs.indexOf(start.x), endNode = ys.indexOf(end.y) * nx + xs.indexOf(end.x);
    if (!xs.includes(start.x) || !xs.includes(end.x) || !ys.includes(start.y) || !ys.includes(end.y)) return null;
    const horizontal = ys.map(y => obstacles.filter(b => y > b.top && y < b.bottom));
    const vertical = xs.map(x => obstacles.filter(b => x > b.left && x < b.right));
    const heap = [], costs = new Map(), previous = new Map();
    function push(item) {
      heap.push(item); let i = heap.length - 1;
      while (i > 0) {const p = (i - 1) >> 1; if (heap[p].score <= item.score) break; heap[i] = heap[p]; i = p;}
      heap[i] = item;
    }
    function pop() {
      const first = heap[0], last = heap.pop();
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          if (child + 1 < heap.length && heap[child + 1].score < heap[child].score) child++;
          if (heap[child].score >= last.score) break;
          heap[i] = heap[child]; i = child;
        }
        heap[i] = last;
      }
      return first;
    }
    const startKey = startNode * 2 + 1;
    costs.set(startKey, 0); push({key: startKey, cost: 0, score: distance(start, end)});
    while (heap.length) {
      const current = pop(); if (costs.get(current.key) !== current.cost) continue;
      const node = Math.floor(current.key / 2), x = node % nx, y = Math.floor(node / nx);
      if (node === endNode) {
        const route = []; let key = current.key;
        while (key !== undefined) {const n = Math.floor(key / 2); route.push(point(xs[n % nx], ys[Math.floor(n / nx)])); key = previous.get(key);}
        return route.reverse();
      }
      for (const [dx, dy, direction] of [[1, 0, 0], [-1, 0, 0], [0, 1, 1], [0, -1, 1]]) {
        const tx = x + dx, ty = y + dy;
        if (tx < 0 || tx >= nx || ty < 0 || ty >= ys.length) continue;
        const blocked = direction === 0
          ? horizontal[y].some(b => Math.max(xs[x], xs[tx]) > b.left && Math.min(xs[x], xs[tx]) < b.right)
          : vertical[x].some(b => Math.max(ys[y], ys[ty]) > b.top && Math.min(ys[y], ys[ty]) < b.bottom);
        if (blocked) continue;
        const next = point(xs[tx], ys[ty]), key = (ty * nx + tx) * 2 + direction;
        const cost = current.cost + Math.abs(xs[x] - xs[tx]) + Math.abs(ys[y] - ys[ty]) + (current.key % 2 === direction ? 0 : 18);
        if (cost >= (costs.get(key) ?? Infinity)) continue;
        costs.set(key, cost); previous.set(key, current.key);
        push({key, cost, score: cost + distance(next, end)});
      }
    }
    return null;
  }

  function route(from, to, boxes, width, height) {
    const down = to.y > from.y;
    const start = point(from.x + from.w / 2 + Math.min(4, from.w / 4), from.y + from.h);
    const end = point(to.x + to.w / 2 - Math.min(4, to.w / 4), down ? to.y : to.y + to.h);
    const exit = point(start.x, start.y + PAD + 2), entry = point(end.x, end.y + (down ? -1 : 1) * (PAD + 2));
    const middle = findRoute(exit, entry, boxes, width, height);
    // When a full-width card blocks every route, keep the connector visible.
    const fallback = [exit, point(exit.x, Math.max(exit.y, entry.y)), point(entry.x, Math.max(exit.y, entry.y)), entry];
    const points = simplify([start, ...(middle || fallback), end]);
    return {points, path: roundedPath(points)};
  }

  const api = {route, roundedPath};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RoadmapLinks = api;
})(globalThis);
