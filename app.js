/* Client-side routing engine.
   Mirrors the real Desk orchestrator's rules (see .claude/agents/desk.md):
   - route to the smallest set of specialists that adds value
   - parallelize independent pulls (michael + stu)
   - never let Casey render numbers Stu/Sara haven't verified
   - model tiers: sara always opus; michael/stu/casey default sonnet,
     escalate to opus when the task becomes judgment, not just fetch/render
   This engine makes a real routing + model-tier decision from your text.
   It does not call live data sources — see the caveat in the UI. */

const RULES = {
  michael: {
    label: "Michael", role: "librarian", cls: "michael",
    keywords: ["who ", "when ", "email", "slack", "jira", "policy", "communicat", "inform", "launch", "ticket", "context", "history", "said", "told", "announce", "confluence", "sharepoint"],
    escalateKeywords: ["ever ", "never ", "any ", "all ", "confirm no", "did anyone", "was it communicated"],
    escalateReason: "multi-source synthesis or an airtight negative claim",
    pull: "Searches Glean (Slack, email, Jira, Confluence, docs, people) for the relevant facts and returns a cited packet."
  },
  stu: {
    label: "Stu", role: "cube data", cls: "stu",
    keywords: ["cost", "volume", "aht", "occupancy", "forecast", "plan", "budget", "variance", "number", "figure", "cube", "fte", "hours", "dollar", "$", "spend", "cycle"],
    escalateKeywords: ["driver", "breakdown", "decompose", "multiple drivers", "several factors", "mix of", "why is it different"],
    escalateReason: "multi-driver decomposition or an ambiguous mapping",
    pull: "Pulls cube-exact figures from the Finance Cube “Tables for Forecast Reviews” tab, plus rationale from the adjustment template."
  },
  sara: {
    label: "Sara", role: "WFM analyst", cls: "sara",
    keywords: ["why", "driv", "stranded", "capacity", "accuracy", "bias", "mape", "shrinkage", "staff", "schedul", "adherence", "service level", " sl ", "asa", "concurrency", "vendor", "efficien", "occupancy"],
    pull: "Interprets the pulled data, verifies it ties out, and states findings with explicit method and caveats."
  },
  casey: {
    label: "Casey", role: "exec comms", cls: "casey",
    keywords: ["deck", "slide", "presentation", "render", "ppt", "powerpoint", "chart", "build the", "one-pager", "brief", "readout"],
    escalateKeywords: ["leadership", "exec", "board", "sensitive", "framing"],
    escalateReason: "exec-sensitive narrative framing, not routine rendering",
    pull: "Renders the verified findings into a deck/brief/chart in house style, and runs the completeness gate against the prior version."
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

  // Standing standard: a monthly forecast review always runs the full pipeline.
  const forcedFullPipeline = /monthly (forecast|review)/i.test(rawQ);
  if(forcedFullPipeline){
    active = { stu: true, michael: true, sara: true, casey: true };
  }

  // House rule: Casey never renders numbers Stu/Sara haven't verified.
  if(active.casey){
    active.sara = true;
    if(!active.michael) active.stu = true;
  }

  // A bare causal "why" with no data keyword defaults to context, not numbers.
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

function directAnswerText(rawQ){
  return "This reads as a definition or a judgment call, not a task that needs a specialist's specific capability — no data pull, no cited retrieval, no artifact to produce. Answering directly rather than spending tokens on a specialist for nothing.";
}

function planLine(decisions, forcedFullPipeline){
  const parts = decisions.map(d => RULES[d.key].label + " (" + d.model + ")").join(", ");
  const prefix = forcedFullPipeline
    ? "Recognized as a monthly forecast review — the standing standard applies, full pipeline: "
    : "Routing to the smallest set that adds value: ";
  return prefix + parts + ".";
}

function parallelNote(specialists){
  const base = specialists.filter(k => k === "michael" || k === "stu");
  if(base.length === 2){
    return "Michael and Stu have no dependency on each other, so dispatching both in parallel.";
  }
  return "";
}

function dispatchAsk(key, rawQ){
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

function generateSteps(rawQ){
  const { specialists, forcedFullPipeline } = routeQuestion(rawQ);
  const steps = [{ p: "tim", text: rawQ }];

  if(specialists.length === 0){
    steps.push({ p: "desk", text: directAnswerText(rawQ) });
    return { steps, decisions: [], directAnswer: true };
  }

  const decisions = specialists.map(k => ({ key: k, ...modelFor(k, rawQ) }));
  steps.push({ p: "desk", text: planLine(decisions, forcedFullPipeline) + " " + parallelNote(specialists) });

  const base = specialists.filter(k => k === "michael" || k === "stu");
  base.forEach(k => steps.push({ p: "desk", to: k, text: dispatchAsk(k, rawQ), tag: "ask" }));
  base.forEach(k => steps.push({ p: k, text: RULES[k].pull, tag: "data" }));

  if(specialists.includes("sara")){
    if(base.length){
      const other = base[0];
      const qa = clarifyingQA(other);
      steps.push({ p: "sara", to: other, text: qa.ask, tag: "ask" });
      steps.push({ p: other, text: qa.answer });
    }
    steps.push({ p: "sara", text: RULES.sara.pull });
  }

  if(specialists.includes("casey")){
    const qa = caseyFramingQA();
    steps.push({ p: "casey", to: "sara", text: qa.ask, tag: "ask" });
    steps.push({ p: "sara", text: qa.answer });
    steps.push({ p: "casey", text: RULES.casey.pull, tag: "gate" });
  }

  steps.push({ p: "desk", text: "Assembling the answer for you — routing and model tiers are logged below. This run is a decision-logic simulation, not a live data pull; a real run would carry sourced figures and citations through every step." });

  return { steps, decisions, directAnswer: false };
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

let currentSteps = [];
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

function renderStep(step){
  const div = document.createElement("div");
  div.className = "msg " + step.p;
  let toHtml = step.to ? ' <span class="to">→ ' + PLABEL[step.to] + "</span>" : "";
  let tagHtml = "";
  if(step.tag === "ask") tagHtml = '<span class="tag ask">question</span>';
  if(step.tag === "data") tagHtml = '<span class="tag data">data pulled</span>';
  if(step.tag === "gate") tagHtml = '<span class="tag gate">completeness gate</span>';
  div.innerHTML =
    '<div class="av">' + AV[step.p] + "</div>" +
    '<div class="body">' +
      '<div class="who">' + PLABEL[step.p] + toHtml + tagHtml + "</div>" +
      '<div class="bubble">' + step.text + "</div>" +
    "</div>";
  transcript.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
  setActive(step.p);
}

function renderDecisions(decisions){
  if(!decisions.length){
    decisionsPanel.style.display = "none";
    return;
  }
  decisionsPanel.style.display = "block";
  decisionsBody.innerHTML = decisions.map(d =>
    '<tr><td>' + RULES[d.key].label + ' <span class="muted">(' + RULES[d.key].role + ')</span></td>' +
    '<td><span class="modeltag ' + d.model + '">' + d.model + "</span></td>" +
    "<td>" + d.reason + "</td></tr>"
  ).join("");
}

function updateMeta(){
  const total = currentSteps.length;
  stepLabel.textContent = "Step " + Math.min(idx, total) + " / " + total;
  pfill.style.width = total ? (Math.min(idx, total) / total * 100) + "%" : "0%";
}

function stepForward(){
  if(idx >= currentSteps.length){
    clearInterval(timer);
    playing = false;
    document.getElementById("playBtn").textContent = "▶ Play";
    return;
  }
  renderStep(currentSteps[idx]);
  idx++;
  updateMeta();
}

function stepBack(){
  clearInterval(timer);
  playing = false;
  document.getElementById("playBtn").textContent = "▶ Play";
  if(idx <= 0) return;
  idx--;
  if(transcript.lastChild) transcript.removeChild(transcript.lastChild);
  setActive(idx > 0 ? currentSteps[idx - 1].p : null);
  updateMeta();
}

function startPlaying(){
  if(!currentSteps.length) return;
  clearInterval(timer);
  playing = true;
  document.getElementById("playBtn").textContent = "⏸ Pause";
  const speed = parseInt(document.getElementById("speed").value, 10);
  stepForward();
  timer = setInterval(stepForward, speed);
}

function run(question){
  clearInterval(timer);
  playing = false;
  document.getElementById("playBtn").textContent = "▶ Play";
  const { steps, decisions } = generateSteps(question);
  currentSteps = steps;
  idx = 0;
  transcript.innerHTML = "";
  renderDecisions(decisions);
  updateMeta();
  startPlaying();
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

document.getElementById("playBtn").addEventListener("click", () => {
  if(!currentSteps.length){ err.style.display = "block"; return; }
  if(playing){
    playing = false;
    document.getElementById("playBtn").textContent = "▶ Play";
    clearInterval(timer);
  } else {
    startPlaying();
  }
});
document.getElementById("nextBtn").addEventListener("click", () => {
  clearInterval(timer); playing = false; document.getElementById("playBtn").textContent = "▶ Play";
  if(currentSteps.length) stepForward();
});
document.getElementById("prevBtn").addEventListener("click", stepBack);
document.getElementById("restartBtn").addEventListener("click", () => {
  const val = qbox.value.trim();
  if(val) run(val);
});

run("Build the monthly forecast deck");
