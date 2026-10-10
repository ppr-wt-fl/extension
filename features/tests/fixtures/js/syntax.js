"use strict";
outer: for (var i = 0; i < 10; i++) {
  inner: for (const k in obj) { if (k === "x") continue outer; else break inner; }
}
for (;;) { break; }
for (let x of [1, 2, ...rest]) { x += 1; }
do { i--; } while (i > 0);
while (i < 3) i++;
switch (i) { case 1: f(); break; case 2: default: g(); }
try { throw new Error("x"); } catch ({ message }) { h(message); } finally { done(); }
try { a(); } catch { b(); }
const tpl = `a${b}c${d + e}f`;
const tagged = tag`hello ${world}`;
class A extends B {
  constructor(...args) { super(...args); this.x = new.target; }
  get y() { return this.x?.z ?? 0; }
  static s() { return super.s(); }
}
const C = class {};
function* gen() { yield 1; yield* other(); }
async function run() { await fetch(url); }
const arrow = async (p = 1, { q, r: [s, t] }) => p + q;
const obj2 = { a, b: 2, [c]: 3, m() {}, get g() { return 1; } };
const seq = (a, b, c);
const cond = a ? b : c;
const re = /ab+c/gi;
const un = typeof x === "undefined" || !y && -z;
delete obj.prop;
label2: { break label2; }
if (a) b(); else if (c) d();
var fe = function named() { return arguments.length; };
with (obj) { prop = 1; }
debugger;
;
