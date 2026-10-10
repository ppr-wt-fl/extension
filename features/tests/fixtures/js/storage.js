// reads and writes storage and cookies; "https://in.a.comment/" should not count after cleaning
var a = localStorage.getItem("key");
localStorage.setItem('k', "v");
sessionStorage["foo"] = 1;
var b = sessionStorage["bar"];
localStorage.token = "x";
var c = localStorage.length;
var s = window.localStorage;
var d = document.cookie;
document.cookie = "a=b; path=/";
var cookies = document.cookies;
var e = cookie.get("x");
var f = cookies["name"];
var g = 3.14 + 2.71 * a.b.c(d)[e];
/* block comment with Storage.setItem( and . . . */
fetch("https://tracker.example.com/collect?x=" + a);
var u = 'http://ads.example.com/' + b;
var t = `https://template.example.com/${c}`;
