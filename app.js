/* Client-side routing engine.
   Mirrors the real Desk orchestrator's rules (see .claude/agents/desk.md):
   - route to the smallest set of specialists that adds value
   - parallelize independent pulls (michael + stu)
   - never let Casey render numbers Stu/Sara haven't verified
   - model tiers: sara always opus; michael/stu/casey default sonnet,
     escalate to opus when the task becomes judgment, not just fetch/render
   This engine makes a real routing + model-tier decision from your text.
   It does not call live data sources — data visuals shown are illustrative
   samples of shape/source, not real figures. */

const RULES = {
  michael: {
    label: "Michael", role: "librarian",
    keywords: ["who ", "when ", "email", "slack", "jira", "policy", "communicat", "inform", "launch", "ticket", "context", "history", "said", "told", "announce", "confluence", "sharepoint"],
    escalateKeywords: ["ever ", "never ", "any ", "all ", "confirm no", "did anyone", "was it communicated"],
    escalateReason: "multi-source synthesis or an airtight negative claim",
    pull: "Searches Glean — Slack, email, Jira, Confluence, docs, people — for the relevant facts and returns a cited packet.",
    answerPart: "supporting context pulled from Slack/email/Jira/Confluence, with citations"
  },
  stu: {
    label: "Stu", role: "cube data",
    keywords: ["cost", "volume", "aht", "occupancy", "forecast", "plan", "budget", "variance", "number", "figure", "cube", "fte", "hours", "dollar", "$", "spend", "cycle"],
    escalateKeywords: ["driver", "breakdown", "decompose", "multiple drivers", "several factors", "mix of", "why is it different"],
    escalateReason: "multi-driver decomposition or an ambiguous mapping",
    pull: "Pulls cube-exact figures from the Finance Cube “Tables for Forecast Reviews” tab, plus rationale from the adjustment template.",
    answerPart: "cube-exact figures (Volume/AHT/Occupancy/cost) with rationale from the adjustment template"
  },
  sara: {
    label: "Sara", role: "WFM analyst",
    keywords: ["why", "driv", "stranded", "capacity", "accuracy", "bias", "mape", "shrinkage", "staff", "schedul", "adherence", "service level", " sl ", "asa", "concurrency", "vendor", "efficien", "occupancy"],
    pull: "Interprets the pulled data, verifies it ties out, and states findings with explicit method and caveats.",
    answerPart: "a verified, tie-out-checked interpretation with explicit method and caveats"
  },
  casey: {
    label: "Casey", role: "exec comms",
    keywords: ["deck", "slide", "presentation", "render", "ppt", "powerpoint", "chart", "build the", "one-pager", "brief", "readout"],
    escalateKeywords: ["leadership", "exec", "board", "sensitive", "framing"],
    escalateReason: "exec-sensitive narrative framing, not routine rendering",
    pull: "Renders the verified findings into a deck/brief/chart in house style, and runs the completeness gate against the prior version.",
    answerPart: "a rendered deck/brief in house style that passed the completeness gate against the prior version"
  }
};

const DIRECT_PATTERNS = [/^what is /i, /^what does /i, /^define /i, /^who is /i];

function routeQuestion(rawQ){
  const q = " " + rawQ.toLowerCase() + " ";

  if(DIRECT_PATTERNS.some(re => re.test(rawQ.trim()))){
    return { specialists: [], forcedFullPipeline: false };
  }

  let active = {};
  for(const key in RULES){
    if(RULES[key].keywords.some(k => q.includes(k))) active[key] = true;
  }

  const forcedFullPipeline = /monthly (forecast|review)/i.test(rawQ);
  if(forcedFullPipeline){
    active = { stu: true, michael: true, sara: true, casey: true };
  }

  if(active.casey){
    active.sara = true;
    if(!active.michael) active.stu = true;
  }

  if(active.sara && !active.stu && !active.michael){
    active.michael = true;
  }

  return { specialists: Object.keys(active), forcedFullPipeline };
}

function modelFor(key, rawQ){
  const q = " " + rawQ.toLowerCase() + " ";
  if(key === "sara"){
    return { model: "opus", reason: "always opus — low-volume, high-judgment; accuracy is the whole value" };
  }
  const rule = RULES[key];
  const escalate = rule.escalateKeywords && rule.escalateKeywords.some(k => q.includes(k));
  if(escalate){
    return { model: "opus", reason: "escalated — " + rule.escalateReason };
  }
  const why = key === "casey" ? "routine rendering from verified numbers"
            : key === "stu" ? "a straight cube pull, not multi-driver work"
            : "a checkable, citable retrieval";
  return { model: "sonnet", reason: "default tier — " + why };
}

function directAnswerText(){
  return "This reads as a definition or a judgment call, not a task that needs a specialist's specific capability — no data pull, no cited retrieval, no artifact to produce. Answering directly rather than spending tokens on a specialist for nothing.";
}

function planLine(decisions, forcedFullPipeline){
  const parts = decisions.map(d => RULES[d.key].label + " (" + d.model + ")").join(", ");
  const prefix = forcedFullPipeline
    ? "Recognized as a monthly forecast review — the standing standard applies, full pipeline: "
    : "Routing to the smallest set that adds value: ";
  return prefix + parts + ".";
}

function parallelExplain(specialists){
  const base = specialists.filter(k => k === "michael" || k === "stu");
  if(base.length === 2) return "Michael and Stu have no dependency on each other, so they're dispatched in parallel — not one after the other.";
  return "Only one base specialist is needed here, so there's nothing to parallelize.";
}

function dispatchAsk(key){
  if(key === "michael") return "Pull whatever's relevant from Glean for this — docs, Slack, email, Jira, people — and cite it.";
  if(key === "stu") return "Pull the cube-exact figures this needs, plus rationale from the adjustment template.";
  return "";
}

function clarifyingQA(saraToKey){
  if(saraToKey === "stu"){
    return {
      ask: "Before I reconcile — confirm the header dates/columns didn't shift from last cycle. Want to rule out a stale or byte-copied column.",
      answer: "Confirmed clean — header dates verified against the workbook, no column drift this cycle."
    };
  }
  return {
    ask: "Is this broad-based or specific to one queue/language/group? Changes what story I tell.",
    answer: "Scoped to the general flow in the ticket, not language- or queue-specific — should read as broad-based."
  };
}

function caseyFramingQA(){
  return {
    ask: "For the headline number here — savings-green or cost-red? House rule is Plan = 10.1 baseline; I don't want to frame a cost risk as a win.",
    answer: "Depends on the finding — if hours haven't actually been reduced to match, it's exposure (cost-red), not a realized saving."
  };
}

// Illustrative-only sample visuals — shape and source, never real figures.
function visualFor(key){
  if(key === "stu") return {
    type: "table",
    caption: "Sample structure of what Stu extracts",
    columns: ["Group", "Volume Δ", "AHT Δ", "Occupancy Δ", "Cost Δ"],
    rows: [
      ["HP English", "+0.4%", "-0.2%", "-4.1pp", "+$XXXk"],
      ["VR Host Eng", "-0.1%", "+0.3%", "-1.8pp", "+$XXXk"],
      ["HP Chat", "+0.2%", "-0.1%", "-2.6pp", "+$XXXk"]
    ],
    source: "CurrentFinanceCubeFCST2026.xlsx · Tables for Forecast Reviews"
  };
  if(key === "michael") return {
    type: "thread",
    caption: "Sample structure of what Michael retrieves",
    items: [
      { source: "Slack #example-channel", date: "recent", snippet: "Thread confirming a launch/rollout date and ownership relevant to the question." },
      { source: "Jira EXAMPLE-1234", date: "recent", snippet: "Ticket status, owner, and scope — whether WFM was looped in." }
    ]
  };
  if(key === "sara") return {
    type: "checklist",
    caption: "Sample structure of Sara's reconciliation pass",
    items: [
      { ok: true, text: "Ties to the cube group total" },
      { ok: true, text: "No stale or byte-copied column vs. prior cycle" },
      { ok: false, text: "Caveat noted where the finding isn't fully realized yet" }
    ]
  };
  if(key === "casey") return {
    type: "slide",
    caption: "Sample structure of what Casey renders",
    title: "Example slide — headline metric + driver",
    bullets: ["Metric Δ vs. prior cycle", "Trend, 6 months", "Driver callout + owner"]
  };
  return null;
}

function synthesizeAnswer(rawQ, specialists){
  if(specialists.length === 0){
    return "Answered directly — this didn't need a specialist's pull, retrieval, or produced artifact, just a definition or judgment call from context already on hand.";
  }
  const parts = specialists.map(k => RULES[k].answerPart);
  let joined;
  if(parts.length === 1) joined = parts[0];
  else joined = parts.slice(0, -1).join("; ") + "; and " + parts[parts.length - 1];
  return "The answer to “" + rawQ + "” would be assembled from: " + joined + ". Every figure carries its source, so the final answer is audit-ready end to end — nothing here is invented or assumed.";
}

function generateSteps(rawQ){
  const { specialists, forcedFullPipeline } = routeQuestion(rawQ);
  const steps = [{ p: "tim", text: rawQ }];

  if(specialists.length === 0){
    steps.push({ p: "desk", text: directAnswerText() });
    return { steps, decisions: [], answer: synthesizeAnswer(rawQ, specialists) };
  }

  const decisions = specialists.map(k => ({ key: k, ...modelFor(k, rawQ) }));
  steps.push({
    p: "desk",
    text: planLine(decisions, forcedFullPipeline),
    explain: parallelExplain(specialists)
  });

  const base = specialists.filter(k => k === "michael" || k === "stu");
  base.forEach(k => steps.push({
    p: "desk", to: k, text: dispatchAsk(k), tag: "ask",
    explain: "Dispatched because the question matched " + RULES[k].label + "'s specific capability — not by default."
  }));
  base.forEach(k => {
    const d = decisions.find(x => x.key === k);
    steps.push({
      p: k, text: RULES[k].pull, tag: "data",
      explain: "Model: " + d.model + " — " + d.reason,
      visual: visualFor(k)
    });
  });

  if(specialists.includes("sara")){
    if(base.length){
      const other = base[0];
      const qa = clarifyingQA(other);
      steps.push({ p: "sara", to: other, text: qa.ask, tag: "ask", explain: "Sara never takes another specialist's pull at face value — she checks it before building on it." });
      steps.push({ p: other, text: qa.answer });
    }
    const d = decisions.find(x => x.key === "sara");
    steps.push({ p: "sara", text: RULES.sara.pull, tag: "data", explain: "Model: " + d.model + " — " + d.reason, visual: visualFor("sara") });
  }

  if(specialists.includes("casey")){
    const qa = caseyFramingQA();
    steps.push({ p: "casey", to: "sara", text: qa.ask, tag: "ask", explain: "Casey checks narrative framing with Sara before rendering — numbers and words have to agree." });
    steps.push({ p: "sara", text: qa.answer });
    const d = decisions.find(x => x.key === "casey");
    steps.push({ p: "casey", text: RULES.casey.pull, tag: "gate", explain: "Model: " + d.model + " — " + d.reason, visual: visualFor("casey") });
  }

  steps.push({
    p: "desk",
    text: "Assembling the answer for you — every step above is logged with its model tier and reasoning.",
    explain: "This run is a decision-logic simulation, not a live data pull. A real run would carry sourced figures and citations through every step above."
  });

  return { steps, decisions, answer: synthesizeAnswer(rawQ, specialists) };
}

// ---- Voices (Web Speech API — client-side only, no keys, no backend) ----

const VOICE_PREFS = {
  desk: { names: ["Google UK English Male", "Microsoft David", "Daniel", "Fred", "Aaron"], pitch: 0.85, rate: 0.95 },
  michael: { names: ["Google UK English Male", "Microsoft George", "Daniel", "Arthur"], pitch: 0.95, rate: 1.0 },
  stu: { names: ["Google US English", "Microsoft Mark", "Alex", "Fred"], pitch: 1.0, rate: 1.05 },
  sara: { names: ["Google UK English Female", "Microsoft Zira", "Samantha", "Victoria", "Kate"], pitch: 1.15, rate: 1.0 },
  casey: { names: ["Microsoft Hazel", "Moira", "Tessa", "Karen", "Google US English"], pitch: 1.05, rate: 1.1 },
  tim: { names: ["Google US English", "Microsoft David", "Alex"], pitch: 1.0, rate: 1.0 }
};

let voicesEnabled = true;
let resolvedVoices = {};

function resolveVoices(){
  if(!("speechSynthesis" in window)) return;
  const all = window.speechSynthesis.getVoices();
  if(!all.length) return;
  const english = all.filter(v => /^en/i.test(v.lang));
  const pool = english.length ? english : all;
  for(const key in VOICE_PREFS){
    const prefs = VOICE_PREFS[key].names;
    let found = null;
    for(const name of prefs){
      found = pool.find(v => v.name.toLowerCase().includes(name.toLowerCase()));
      if(found) break;
    }
    if(!found) found = pool[0];
    resolvedVoices[key] = found;
  }
}

if("speechSynthesis" in window){
  resolveVoices();
  window.speechSynthesis.onvoiceschanged = resolveVoices;
}

function speakStep(step){
  const card = document.querySelector(".p-" + step.p);
  if(!voicesEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(step.text);
  const prefs = VOICE_PREFS[step.p] || VOICE_PREFS.tim;
  const voice = resolvedVoices[step.p];
  if(voice) u.voice = voice;
  u.pitch = prefs.pitch;
  u.rate = prefs.rate;
  if(card) card.classList.add("speaking");
  const clear = () => { if(card) card.classList.remove("speaking"); };
  u.onend = clear;
  u.onerror = clear;
  window.speechSynthesis.speak(u);
}

function stopSpeaking(){
  if("speechSynthesis" in window) window.speechSynthesis.cancel();
  document.querySelectorAll(".rcard.speaking").forEach(r => r.classList.remove("speaking"));
}

// ---- UI wiring ----

const PLABEL = { desk: "The Desk", michael: "Michael", stu: "Stu", sara: "Sara", casey: "Casey", tim: "You" };
const AV = { desk: "D", michael: "M", stu: "S", sara: "S", casey: "C", tim: "Y" };

const transcript = document.getElementById("transcript");
const pfill = document.getElementById("pfill");
const stepLabel = document.getElementById("stepLabel");
const err = document.getElementById("err");
const decisionsPanel = document.getElementById("decisions");
const decisionsBody = document.getElementById("decisionsBody");
const qbox = document.getElementById("qbox");
const answerCard = document.getElementById("answerCard");
const answerText = document.getElementById("answerText");
const nextBtn = document.getElementById("nextBtn");
const playBtn = document.getElementById("playBtn");

let currentSteps = [];
let currentAnswer = "";
let idx = 0;
let playing = false;
let timer = null;

function setActive(p){
  document.querySelectorAll(".rcard").forEach(r => r.classList.remove("active"));
  if(p && p !== "tim"){
    const el = document.querySelector(".p-" + p);
    if(el) el.classList.add("active");
  }
}

function renderVisual(visual){
  if(!visual) return "";
  let inner = "";
  if(visual.type === "table"){
    inner = '<table class="vtable"><thead><tr>' + visual.columns.map(c => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" +
      visual.rows.map(r => "<tr>" + r.map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") +
      "</tbody></table>" +
      '<div class="vsource">Source: ' + visual.source + "</div>";
  } else if(visual.type === "thread"){
    inner = visual.items.map(it =>
      '<div class="vthread-item"><div class="vthread-src">' + it.source + ' <span class="vdate">' + it.date + "</span></div>" +
      '<div class="vthread-snip">' + it.snippet + "</div></div>"
    ).join("");
  } else if(visual.type === "checklist"){
    inner = '<ul class="vchecklist">' + visual.items.map(it =>
      '<li class="' + (it.ok ? "ok" : "warn") + '">' + (it.ok ? "✓" : "⚠") + " " + it.text + "</li>"
    ).join("") + "</ul>";
  } else if(visual.type === "slide"){
    inner = '<div class="vslide"><div class="vslide-title">' + visual.title + '</div><ul class="vslide-bullets">' +
      visual.bullets.map(b => "<li>" + b + "</li>").join("") + "</ul></div>";
  }
  return '<div class="visual"><div class="visual-caption">' + visual.caption + ' <span class="illustrative">illustrative, not real figures</span></div>' + inner + "</div>";
}

function renderStep(step){
  const div = document.createElement("div");
  div.className = "msg " + step.p;
  let toHtml = step.to ? ' <span class="to">→ ' + PLABEL[step.to] + "</span>" : "";
  let tagHtml = "";
  if(step.tag === "ask") tagHtml = '<span class="tag ask">question</span>';
  if(step.tag === "data") tagHtml = '<span class="tag data">data pulled</span>';
  if(step.tag === "gate") tagHtml = '<span class="tag gate">completeness gate</span>';
  const explainHtml = step.explain ? '<div class="explain"><i>' + step.explain + "</i></div>" : "";
  div.innerHTML =
    '<div class="av">' + AV[step.p] + "</div>" +
    '<div class="body">' +
      '<div class="who">' + PLABEL[step.p] + toHtml + tagHtml + "</div>" +
      '<div class="bubble">' + step.text + "</div>" +
      explainHtml +
      renderVisual(step.visual) +
    "</div>";
  transcript.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
  setActive(step.p);
  speakStep(step);
}

function renderDecisions(decisions){
  if(!decisions.length){
    decisionsPanel.style.display = "none";
    return;
  }
  decisionsPanel.style.display = "block";
  decisionsBody.innerHTML = decisions.map(d =>
    "<tr><td>" + RULES[d.key].label + ' <span class="muted">(' + RULES[d.key].role + ")</span></td>" +
    '<td><span class="modeltag ' + d.model + '">' + d.model + "</span></td>" +
    "<td>" + d.reason + "</td></tr>"
  ).join("");
}

function updateMeta(){
  const total = currentSteps.length;
  stepLabel.textContent = "Step " + Math.min(idx, total) + " / " + total;
  pfill.style.width = total ? (Math.min(idx, total) / total * 100) + "%" : "0%";
}

function stopAutoplay(){
  clearTimeout(timer);
  playing = false;
  playBtn.textContent = "▶ Auto-advance";
}

function paceDelay(step){
  const multiplier = parseFloat(document.getElementById("speed").value);
  const len = (step && step.text ? step.text.length : 40);
  return Math.min(9000, Math.max(1400, 500 + len * 38 * multiplier));
}

function revealAnswer(){
  answerCard.style.display = "block";
  answerText.textContent = currentAnswer;
  answerCard.scrollIntoView({ behavior: "smooth", block: "end" });
}

function stepForward(){
  if(idx >= currentSteps.length){
    if(answerCard.style.display !== "block") revealAnswer();
    stopAutoplay();
    nextBtn.disabled = true;
    return;
  }
  renderStep(currentSteps[idx]);
  idx++;
  updateMeta();
  if(idx >= currentSteps.length) nextBtn.textContent = "Show answer ▶";
}

function stepBack(){
  stopAutoplay();
  stopSpeaking();
  if(answerCard.style.display === "block"){
    answerCard.style.display = "none";
    nextBtn.disabled = false;
    nextBtn.textContent = "Next ▶";
    return;
  }
  if(idx <= 0) return;
  idx--;
  if(transcript.lastChild) transcript.removeChild(transcript.lastChild);
  setActive(idx > 0 ? currentSteps[idx - 1].p : null);
  updateMeta();
  nextBtn.textContent = "Next ▶";
}

function autoTick(){
  stepForward();
  if(playing && idx < currentSteps.length){
    timer = setTimeout(autoTick, paceDelay(currentSteps[idx - 1]));
  }
}

function startAutoplay(){
  if(!currentSteps.length) return;
  clearTimeout(timer);
  playing = true;
  playBtn.textContent = "⏸ Pause";
  autoTick();
}

function run(question){
  clearTimeout(timer);
  stopSpeaking();
  playing = false;
  playBtn.textContent = "▶ Auto-advance";
  const { steps, decisions, answer } = generateSteps(question);
  currentSteps = steps;
  currentAnswer = answer;
  idx = 0;
  transcript.innerHTML = "";
  answerCard.style.display = "none";
  nextBtn.disabled = false;
  nextBtn.textContent = "Next ▶";
  renderDecisions(decisions);
  updateMeta();
  stepForward();
}

document.querySelectorAll(".preset").forEach(btn => {
  btn.addEventListener("click", () => {
    err.style.display = "none";
    qbox.value = btn.textContent;
    run(btn.textContent);
  });
});

document.getElementById("runBtn").addEventListener("click", () => {
  const val = qbox.value.trim();
  if(!val){
    err.style.display = "block";
    return;
  }
  err.style.display = "none";
  run(val);
});
qbox.addEventListener("input", () => { if(qbox.value.trim()) err.style.display = "none"; });
qbox.addEventListener("keydown", e => { if(e.key === "Enter") document.getElementById("runBtn").click(); });

playBtn.addEventListener("click", () => {
  if(!currentSteps.length){ err.style.display = "block"; return; }
  if(playing) stopAutoplay();
  else startAutoplay();
});
nextBtn.addEventListener("click", () => { stopAutoplay(); if(currentSteps.length) stepForward(); });
document.getElementById("prevBtn").addEventListener("click", stepBack);
document.getElementById("restartBtn").addEventListener("click", () => {
  const val = qbox.value.trim();
  if(val) run(val);
});

const voiceToggle = document.getElementById("voiceToggle");
if(voiceToggle){
  voicesEnabled = voiceToggle.checked;
  voiceToggle.addEventListener("change", () => {
    voicesEnabled = voiceToggle.checked;
    if(!voicesEnabled) stopSpeaking();
  });
}

run("Build the monthly forecast deck");
