import { readFileSync } from "fs";
const src = readFileSync("/tmp/onaroll-work/onaroll-garage-doors/worker/src/index.js", "utf8");
const towns = src.slice(src.indexOf("const LOCAL_TOWNS"), src.indexOf("const PHOTO_ASK"));
const start = src.indexOf("function startCaps");
const end = src.indexOf("function templateCopy");
const { startCaps, sentenceCaseCopy, isOffTrade, isUnsafeDiy, isIncompleteLine, inventedLocation, validateCopy } = new Function(
  "LINE_MAX", "SUB_MAX", "CAPTION_MAX",
  towns + "\n" + src.slice(start, end) + "\n" + src.slice(src.indexOf("function validateCopy"), src.indexOf("function startCaps")) + "\nreturn { startCaps, sentenceCaseCopy, isOffTrade, isUnsafeDiy, isIncompleteLine, inventedLocation, validateCopy };"
)(42, 110, 2200);

const cases = [
  ["diy tug", isUnsafeDiy("Check your springs. Are they loose or broken? Give them a quick tug to see if they need tightening."), true],
  ["diy check springs", isUnsafeDiy("Check your springs before they snap."), true],
  ["safe warning", isUnsafeDiy("Don't touch the springs — if the door feels heavy, call us."), false],
  ["signs then call", isUnsafeDiy("If the door is heavy, noisy or uneven, give us a call."), false],
  ["rollers oil ok", isUnsafeDiy("Give the rollers a wipe and a spray of oil to keep them running smooth."), false],
  ["driveway", isOffTrade("Another driveway, sorted locally. Colour-matched aluminium roller, fitted in Poole and around Dorset."), true],
  ["garage ok", isOffTrade("Another garage, sorted locally. Colour-matched aluminium roller, fitted in Poole and around Dorset."), false],
  ["resin", isOffTrade("We also do resin driveways."), true],
  ["paving", isOffTrade("Block paving on the front."), true],
];
let fail = 0;
for (const [name, got, expect] of cases) {
  const ok = got === expect;
  if (!ok) fail++;
  console.log(ok ? "OK  " : "FAIL", name, { got, expect });
}
const cap = startCaps("choosing colours");
const capOk = cap === "Choosing colours";
if (!capOk) fail++;
console.log(capOk ? "OK  " : "FAIL", "startCaps", cap);

const joined = sentenceCaseCopy({ line1: "the garage is", line2: "the easy way in.", sub: "a proper roller locks as it closes." });
const joinOk = joined.line1 === "The garage is" && joined.line2 === "the easy way in." && joined.sub === "A proper roller locks as it closes.";
if (!joinOk) fail++;
console.log(joinOk ? "OK  " : "FAIL", "continuation line2", joined);

const newSent = sentenceCaseCopy({ line1: "Book a survey.", line2: "no hard sell.", sub: "family-run in Poole." });
const nsOk = newSent.line1 === "Book a survey." && newSent.line2 === "No hard sell." && newSent.sub === "Family-run in Poole.";
if (!nsOk) fail++;
console.log(nsOk ? "OK  " : "FAIL", "new sentence line2", newSent);

const templates = [
  { line1: "Just fitted.", line2: "Looks the part.", sub: "Made-to-measure roller, fitted tidy by our local team." },
  { line1: "Old door out.", line2: "New door in.", sub: "A clean swap, usually done in about half a day." },
  { line1: "Another garage,", line2: "sorted locally.", sub: "Colour-matched aluminium roller, fitted in Poole and around Dorset." },
  { line1: "Secure it.", line2: "Quiet it.", sub: "Modern rollers lock into the side guides and keep the garage warmer." },
  { line1: "The garage is", line2: "the easy way in.", sub: "A proper roller locks as it closes — and it’s quieter and better insulated." },
  { line1: "Warm. Quiet.", line2: "Harder to force.", sub: "A 5-year warranty on a door that shuts smoothly and stays shut." },
  { line1: "Free survey.", line2: "Straight talk.", sub: "We’ll measure up, talk you through the options and give you a clear quote." },
  { line1: "Book a survey.", line2: "No hard sell.", sub: "Family-run in Poole. We come to you across Bournemouth, Christchurch and Dorset." },
  { line1: "Ready for a", line2: "new garage door?", sub: "A free survey is the first step — local fitters, honest advice." },
];
for (const c of templates) {
  const r = validateCopy(c);
  const ok = !r;
  if (!ok) fail++;
  console.log(ok ? "OK  " : "FAIL", "template", c.line1, r || "ok");
}
const oldDrive = validateCopy({ line1: "Another driveway,", line2: "sorted locally.", sub: "Colour-matched aluminium roller, fitted in Poole and around Dorset." });
const odOk = oldDrive === "off_trade";
if (!odOk) fail++;
console.log(odOk ? "OK  " : "FAIL", "old driveway template", oldDrive);

const diyCopy = validateCopy({ line1: "Check your springs.", line2: "Are they loose?", sub: "Give them a quick tug to see if they need tightening." });
const diyOk = diyCopy === "unsafe_diy";
if (!diyOk) fail++;
console.log(diyOk ? "OK  " : "FAIL", "diy validate", diyCopy);

process.exit(fail ? 1 : 0);
