"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var file = path.join(__dirname, "..", "panel", "csrf.js");
var code = fs.readFileSync(file, "utf8");
var sandbox = {
  window: {},
  URL: URL,
  decodeURIComponent: decodeURIComponent
};
var context = vm.createContext(sandbox);
vm.runInContext(code, context, { filename: "csrf.js" });

var forCapture = sandbox.window.PhantomCsrf.forCapture;
var failures = [];
var checks = 0;

function assert(name, cond) {
  checks += 1;
  if (!cond) {
    failures.push(name);
    console.error(name);
  }
}

function reasonOf(plan, name) {
  var dropped = plan.dropped || [];
  for (var i = 0; i < dropped.length; i++) {
    if (dropped[i].name === name) return dropped[i].reason;
  }
  return null;
}

function actionOf(html) {
  var match = /action="([^"]*)"/.exec(html || "");
  return match ? match[1] : "";
}

function assertBlocked(name, plan, reason, summary) {
  assert(name + " kind", plan.kind === "blocked");
  assert(name + " reason", plan.reason === reason);
  assert(name + " html", plan.html === null);
  assert(name + " enctype", plan.enctype === null);
  assert(name + " summary", plan.summary === summary);
}

assert(
  "export is forCapture only",
  JSON.stringify(Object.keys(sandbox.window.PhantomCsrf)) === "[\"forCapture\"]"
);

var posted = {
  method: "POST",
  url: "https://app.example/transfer",
  requestHeaders: {
    "Content-Type": "application/x-www-form-urlencoded",
    "Cookie": "session=secret-cookie",
    "Authorization": "Bearer secret",
    "X-CSRF-Token": "header-secret",
    "Host": "secret-host.example"
  },
  requestBody: "amount=1&csrf_token=abc"
};
var headerSnapshot = JSON.stringify(posted.requestHeaders);
var bodySnapshot = posted.requestBody;
var plan = forCapture(posted);

assert("urlencoded kind", plan.kind === "form");
assert("urlencoded reason", plan.reason === null);
assert("urlencoded enctype", plan.enctype === "application/x-www-form-urlencoded");
assert("urlencoded summary", plan.summary === "Form proof. Headers are not in the page.");
assert("urlencoded html has amount", plan.html.indexOf("amount") >= 0);
assert("urlencoded html has csrf_token", plan.html.indexOf("csrf_token") >= 0);
assert("urlencoded html has abc", plan.html.indexOf('value="abc"') >= 0);
assert("urlencoded html omits secret-cookie", plan.html.indexOf("secret-cookie") < 0);
assert("urlencoded html omits Bearer secret", plan.html.indexOf("Bearer secret") < 0);
assert("urlencoded html omits header-secret", plan.html.indexOf("header-secret") < 0);
assert("urlencoded html omits secret-host", plan.html.indexOf("secret-host.example") < 0);
assert("urlencoded tokenFields", JSON.stringify(plan.tokenFields) === "[\"csrf_token\"]");
assert("urlencoded dropped Cookie", reasonOf(plan, "Cookie") === "browser-jar");
assert("urlencoded dropped Authorization", reasonOf(plan, "Authorization") === "forbidden-header");
assert("urlencoded dropped X-CSRF-Token", reasonOf(plan, "X-CSRF-Token") === "not-form-settable");
assert("urlencoded dropped Host", reasonOf(plan, "Host") === "browser-controlled");
assert("urlencoded omits Content-Type drop", reasonOf(plan, "Content-Type") === null);
assert("urlencoded comment Cookie", plan.html.indexOf("Cookie: browser-jar") >= 0);
assert("urlencoded comment Authorization", plan.html.indexOf("Authorization: forbidden-header") >= 0);
assert("urlencoded samesite", plan.html.indexOf("SameSite=Lax and Strict cookies are not sent on a cross-site POST.") >= 0);
assert("urlencoded submits", plan.html.indexOf("document.forms[0].submit()") >= 0);
assert("urlencoded no hash note", plan.html.indexOf("Dropped hash.") < 0);
assert("urlencoded input order", plan.html.indexOf('name="amount"') < plan.html.indexOf('name="csrf_token"'));
assert("urlencoded input not mutated headers", JSON.stringify(posted.requestHeaders) === headerSnapshot);
assert("urlencoded input not mutated body", posted.requestBody === bodySnapshot);
assert("urlencoded stable html", forCapture(posted).html === plan.html);

assertBlocked(
  "json",
  forCapture({
    method: "POST",
    url: "https://app.example/transfer",
    requestHeaders: { "Content-Type": "application/json" },
    requestBody: "{\"amount\":1}"
  }),
  "content-type",
  "Blocked. A form cannot send this content type."
);

assertBlocked(
  "json charset",
  forCapture({
    method: "POST",
    url: "https://app.example/transfer",
    requestHeaders: { "Content-Type": "application/json; charset=utf-8" },
    requestBody: "amount=1"
  }),
  "content-type",
  "Blocked. A form cannot send this content type."
);

assertBlocked(
  "put",
  forCapture({
    method: "PUT",
    url: "https://app.example/transfer",
    requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
    requestBody: "amount=1"
  }),
  "method",
  "Blocked. A form can only send GET or POST."
);

assertBlocked(
  "get body",
  forCapture({
    method: "GET",
    url: "https://app.example/out?x=1",
    requestHeaders: {},
    requestBody: "nope"
  }),
  "get-with-body",
  "Blocked. GET has a body a form cannot send."
);

assertBlocked(
  "bad url",
  forCapture({
    method: "POST",
    url: "javascript:alert(1)",
    requestHeaders: {},
    requestBody: "a=1"
  }),
  "bad-url",
  "Blocked. URL must be http or https."
);

var getDup = forCapture({
  method: "GET",
  url: "https://app.example/out?x=1&x=2",
  requestHeaders: {},
  requestBody: ""
});
assert("get dup kind", getDup.kind === "form");
assert("get dup enctype", getDup.enctype === null);
assert("get dup summary", getDup.summary === "Form proof. Headers are not in the page.");
assert("get dup action", actionOf(getDup.html) === "https://app.example/out");
assert("get dup omits query", getDup.html.indexOf("x=1") < 0 && getDup.html.indexOf("x=2") < 0);
assert("get dup value 1", getDup.html.indexOf('name="x" value="1"') >= 0);
assert("get dup value 2", getDup.html.indexOf('name="x" value="2"') >= 0);
assert("get dup two names", getDup.html.split('name="x"').length - 1 === 2);
assert("get dup order", getDup.html.indexOf('value="1"') < getDup.html.indexOf('value="2"'));

var getNull = forCapture({
  method: "GET",
  url: "https://app.example/out?x=1&x=2",
  requestHeaders: {},
  requestBody: null
});
assert("null body matches empty", getNull.html === getDup.html);

var localhost = forCapture({
  method: "GET",
  url: "http://127.0.0.1/poc",
  requestHeaders: {},
  requestBody: null
});
assert("localhost kind", localhost.kind === "form");
assert("localhost action", actionOf(localhost.html) === "http://127.0.0.1/poc");

var boundary = "----Bound";
var fileBody = [
  "--" + boundary,
  "Content-Disposition: form-data; name=\"file\"; filename=\"a.txt\"",
  "Content-Type: text/plain",
  "",
  "file-bytes-secret",
  "--" + boundary + "--"
].join("\r\n");
var filePlan = forCapture({
  method: "POST",
  url: "https://app.example/upload",
  requestHeaders: { "Content-Type": "multipart/form-data; boundary=" + boundary },
  requestBody: fileBody
});
assertBlocked("file", filePlan, "file-field", "Blocked. A form cannot resend a file part.");
assert("file bytes absent", JSON.stringify(filePlan).indexOf("file-bytes-secret") < 0);

var textBody = [
  "--" + boundary,
  "Content-Disposition: form-data; name=\"amount\"",
  "",
  "9",
  "--" + boundary,
  "Content-Disposition: form-data; name=\"csrf_token\"",
  "",
  "tok",
  "--" + boundary + "--"
].join("\r\n");
var textPart = forCapture({
  method: "POST",
  url: "https://app.example/upload",
  requestHeaders: { "Content-Type": "multipart/form-data; boundary=" + boundary },
  requestBody: textBody
});
assert("multipart kind", textPart.kind === "form");
assert("multipart enctype", textPart.enctype === "multipart/form-data");
assert("multipart amount", textPart.html.indexOf('name="amount" value="9"') >= 0);
assert("multipart token", JSON.stringify(textPart.tokenFields) === "[\"csrf_token\"]");
assert("multipart token value", textPart.html.indexOf('name="csrf_token" value="tok"') >= 0);

assertBlocked(
  "unparsed multipart",
  forCapture({
    method: "POST",
    url: "https://app.example/transfer",
    requestHeaders: { "Content-Type": "multipart/form-data" },
    requestBody: "not a multipart body"
  }),
  "unparsed-body",
  "Blocked. The body did not parse as form fields."
);

var hashed = forCapture({
  method: "POST",
  url: "https://app.example/transfer?from=ui#section",
  requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
  requestBody: "amount=1"
});
assert("hash kind", hashed.kind === "form");
assert("hash action", actionOf(hashed.html) === "https://app.example/transfer?from=ui");
assert("hash keeps query", hashed.html.indexOf("?from=ui") >= 0);
assert("hash drops fragment", hashed.html.indexOf("#section") < 0 && hashed.html.indexOf("#") < 0);
assert("hash note", hashed.html.indexOf("Dropped hash.") >= 0);
assert("hash no from input", hashed.html.indexOf('name="from"') < 0);
assert("hash amount input", hashed.html.indexOf('name="amount" value="1"') >= 0);

var amped = forCapture({
  method: "POST",
  url: "https://app.example/transfer?a=1&b=2",
  requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
  requestBody: "q=a%3Cb%26c%22d%27e"
});
assert("amp action", actionOf(amped.html) === "https://app.example/transfer?a=1&amp;b=2");
assert("amp raw query absent", amped.html.indexOf("a=1&b=2") < 0);
assert("escaped value", amped.html.indexOf('value="a&lt;b&amp;c&quot;d&#39;e"') >= 0);
assert("raw angle absent", amped.html.indexOf("a<b") < 0);

var plain = forCapture({
  method: "POST",
  url: "https://app.example/transfer",
  requestHeaders: { "Content-Type": "text/plain; charset=UTF-8" },
  requestBody: "amount=1\r\ncsrf_token=a+b\r\n"
});
assert("plain kind", plain.kind === "form");
assert("plain enctype", plain.enctype === "text/plain");
assert("plain plus stays", plain.html.indexOf('name="csrf_token" value="a+b"') >= 0);
assert("plain token", JSON.stringify(plain.tokenFields) === "[\"csrf_token\"]");

var urlPlus = forCapture({
  method: "POST",
  url: "https://app.example/transfer",
  requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
  requestBody: "q=a+b"
});
assert("urlencoded plus", urlPlus.html.indexOf('value="a b"') >= 0);

var missingPairs = forCapture({
  method: "POST",
  url: "https://app.example/transfer",
  requestHeaders: {},
  requestBody: "amount=1&csrf_token=abc"
});
assert("missing type pairs", missingPairs.kind === "form" && missingPairs.enctype === "application/x-www-form-urlencoded");

var missingEmpty = forCapture({
  method: "POST",
  url: "https://app.example/transfer",
  requestHeaders: {},
  requestBody: ""
});
assert("missing type empty", missingEmpty.kind === "form" && missingEmpty.enctype === "application/x-www-form-urlencoded");

assertBlocked(
  "missing type json",
  forCapture({
    method: "POST",
    url: "https://app.example/transfer",
    requestHeaders: {},
    requestBody: "{\"a\":1}"
  }),
  "unparsed-body",
  "Blocked. The body did not parse as form fields."
);

var cased = forCapture({
  method: "post",
  url: "https://app.example/transfer",
  requestHeaders: { "content-type": "application/x-www-form-urlencoded" },
  requestBody: "Csrf_Token=abc"
});
assert("method case", cased.kind === "form");
assert("token case", JSON.stringify(cased.tokenFields) === "[\"Csrf_Token\"]");
assert("content-type case honored", reasonOf(cased, "content-type") === null);

if (failures.length) process.exit(1);
console.log("csrf-check ok " + checks);
