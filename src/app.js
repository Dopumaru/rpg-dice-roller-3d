(function () {
'use strict';

// ─── DOM ───────────────────────────────────────────────────────────────────
var diceResultsGrid = document.getElementById('dice-results-grid');
var resultTotalVal  = document.getElementById('result-total-val');
var resultTotalRow  = document.getElementById('result-total-row');
var diceButtons  = document.querySelectorAll('.dice-button');
var rollBtn      = document.getElementById('roll-selected');
var poolChips    = document.getElementById('pool-chips');
var poolEmpty    = document.getElementById('pool-empty');
var poolClear    = document.getElementById('pool-clear');
var engineStatus = document.getElementById('engine-status');
var canvas       = document.getElementById('dice-canvas');
var shell        = document.querySelector('.canvas-shell');

if (typeof THREE === 'undefined' || typeof CANNON === 'undefined') {
  if (engineStatus) engineStatus.textContent = 'Erro: Three.js / Cannon.js não carregou (precisa de internet)';
  return;
}

// ─── Constantes ────────────────────────────────────────────────────────────
var SIDES_MAP  = { d4:4, d6:6, d8:8, d10:10, d12:12, d20:20 };
var DICE_COLOR = { 4:0xc9a3ed, 6:0xb583e0, 8:0xa873d6, 10:0x9b63cf, 12:0x8f54c4, 20:0xc28ee8 };
var UP            = new THREE.Vector3(0,1,0);
var CAM_HOME      = new THREE.Vector3(0,7,10);
var CAM_LOOK_HOME = new THREE.Vector3(0,-0.5,0);
var FLOOR_Y    = -1.1;
var MIN_ROLL_MS = 5000;
var MAX_ROLL_MS = 14000;

// ─── Estado ────────────────────────────────────────────────────────────────
var S = {
  pool: {},
  renderer: null, scene: null, camera: null,
  world: null, dice: [],
  rolling: false, rollStartTime: 0,
  camLook: new THREE.Vector3(),
  camPhase: 'idle', camPhaseStart: 0,
  camFromPos: new THREE.Vector3(), camToPos: new THREE.Vector3(),
  camFromLook: new THREE.Vector3(), camToLook: new THREE.Vector3(),
  revealQueue: [], suspenseTimer: null, lastStepTime: null,
  particles: null, partOrigPos: null,
  pendingTotal: 0, pendingParts: '', pendingByType: {},
};

// ══════════════════════════════════════════════════════════════════════════
// SISTEMA DE SOM — Web Audio API procedural
// AudioContext criado DENTRO do clique (obrigatório Chrome/Safari)
// ══════════════════════════════════════════════════════════════════════════
var AC = null;

function initAC() {
  if (!AC) {
    try { AC = new (window.AudioContext || window.webkitAudioContext)(); }
    catch(e) { AC = null; return; }
  }
  if (AC.state === 'suspended') AC.resume();
}
function getAC() { return AC; }

// ── Utilitário: cria um buffer de ruído branco ────────────────────────────
function makeNoiseBuffer(ac, dur) {
  var len = Math.floor(ac.sampleRate * dur);
  var buf = ac.createBuffer(1, len, ac.sampleRate);
  var d = buf.getChannelData(0);
  for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// ── ARREMESSO — whoosh grave + fricção de mão ────────────────────────────
// Inspirado em foley de RPG: som de punho sacudindo dados antes de jogar
function sndThrow() {
  var ac = getAC(); if (!ac) return;
  var now = ac.currentTime;

  // Camada 1: whoosh grave — oscilador com pitch glide rápido
  var osc = ac.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(55, now + 0.28);
  var gOsc = ac.createGain();
  gOsc.gain.setValueAtTime(0, now);
  gOsc.gain.linearRampToValueAtTime(0.18, now + 0.04);
  gOsc.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
  // lowpass para suavizar o sawtooth
  var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
  osc.connect(lp); lp.connect(gOsc); gOsc.connect(ac.destination);
  osc.start(now); osc.stop(now + 0.35);

  // Camada 2: ruído médio-agudo (fricção dos dados na mão)
  var src = ac.createBufferSource();
  src.buffer = makeNoiseBuffer(ac, 0.38);
  var bp = ac.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2200, now);
  bp.frequency.exponentialRampToValueAtTime(600, now + 0.38);
  bp.Q.value = 1.4;
  var gN = ac.createGain();
  gN.gain.setValueAtTime(0, now);
  gN.gain.linearRampToValueAtTime(0.22, now + 0.05);
  gN.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
  src.connect(bp); bp.connect(gN); gN.connect(ac.destination);
  src.start(now);

  // Camada 3: "clatter" — 3 cliques rápidos imitando dados batendo entre si
  [0.06, 0.13, 0.21].forEach(function(dt) {
    var c = ac.createOscillator(); c.type = 'square';
    c.frequency.setValueAtTime(900 + Math.random()*400, now + dt);
    c.frequency.exponentialRampToValueAtTime(120, now + dt + 0.06);
    var gc = ac.createGain();
    gc.gain.setValueAtTime(0.10, now + dt);
    gc.gain.exponentialRampToValueAtTime(0.001, now + dt + 0.07);
    var lpc = ac.createBiquadFilter(); lpc.type = 'lowpass'; lpc.frequency.value = 1800;
    c.connect(lpc); lpc.connect(gc); gc.connect(ac.destination);
    c.start(now + dt); c.stop(now + dt + 0.09);
  });
}

// ── ROLAGEM EM LOOP — 3 camadas sobrepostas ───────────────────────────────
// Imita dados de resina rolando em feltro: grave (massa), médio (superfície),
// agudo (arestas)
var _rollNodes = [];
function sndRollStart() {
  var ac = getAC(); if (!ac) return;
  sndRollStop();
  var sr = ac.sampleRate;
  // Buffer de 1s com 3 camadas misturadas para loop suave
  var dur = 1.0;
  var len = Math.floor(sr * dur);
  var buf = ac.createBuffer(1, len, sr);
  var d = buf.getChannelData(0);
  for (var i = 0; i < len; i++) {
    var t = i / sr;
    // Grave: pancadas periódicas simulando faces batendo no feltro
    var hits = 0;
    for (var h = 0; h < 9; h++) {
      var ht = h * (dur / 9);
      var dt = t - ht;
      if (dt >= 0 && dt < 0.055)
        hits += Math.exp(-dt * 38) * Math.sin(2 * Math.PI * 140 * dt) * 0.55;
    }
    // Médio: ruído filtrado (chocalhar contínuo)
    var rnd = Math.random() * 2 - 1;
    // Agudo: pequenos cliques de arestas
    var edge = 0;
    for (var e = 0; e < 18; e++) {
      var et = e * (dur / 18) + 0.027;
      var de = t - et;
      if (de >= 0 && de < 0.018)
        edge += (Math.random()*2-1) * Math.exp(-de * 120) * 0.3;
    }
    // Envelope de fade-in/out para loop sem clique
    var env = Math.sin(Math.PI * (i / len));
    d[i] = (hits + rnd * 0.25 + edge) * env * 0.72;
  }

  var src = ac.createBufferSource(); src.buffer = buf; src.loop = true;

  // EQ: corta sub-grave e extremo agudo para parecer feltro (não metal)
  var hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
  var lp = ac.createBiquadFilter(); lp.type = 'lowpass';  lp.frequency.value = 5500;
  // Leve compressão dinâmica para nivelar as pancadas
  var comp = ac.createDynamicsCompressor();
  comp.threshold.value = -22; comp.knee.value = 8;
  comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.12;

  var gain = ac.createGain(); gain.gain.setValueAtTime(0, ac.currentTime);
  gain.gain.linearRampToValueAtTime(0.55, ac.currentTime + 0.18);

  src.connect(hp); hp.connect(lp); lp.connect(comp); comp.connect(gain); gain.connect(ac.destination);
  src.start();
  _rollNodes = [src, gain];
}
function sndRollStop() {
  if (!_rollNodes.length) return;
  var ac = getAC();
  var gain = _rollNodes[1];
  var src  = _rollNodes[0];
  if (ac && gain) {
    gain.gain.setValueAtTime(gain.gain.value, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.30);
  }
  setTimeout(function(){ try { src.stop(); } catch(e){} }, 340);
  _rollNodes = [];
}

// ── QUIQUE / IMPACTO — 4 camadas proporcional à força ────────────────────
// Força ~1–3: quique leve (apenas clique)  |  força >5: impacto pesado completo
var _lastBounceTime = 0;
function sndBounce(force) {
  var ac = getAC(); if (!ac) return;
  var now = ac.currentTime;
  if (now - _lastBounceTime < 0.07) return; // debounce 70ms
  _lastBounceTime = now;

  var f = Math.min(force || 1, 12);
  var vol = 0.15 + (f / 12) * 0.72; // volume escala com a força

  // Camada 1: Sub-punch (dá peso ao impacto)
  if (f > 2) {
    var sub = ac.createOscillator(); sub.type = 'sine';
    sub.frequency.setValueAtTime(95, now);
    sub.frequency.exponentialRampToValueAtTime(30, now + 0.09);
    var gSub = ac.createGain();
    gSub.gain.setValueAtTime(vol * 0.55, now);
    gSub.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    sub.connect(gSub); gSub.connect(ac.destination);
    sub.start(now); sub.stop(now + 0.14);
  }

  // Camada 2: Corpo do impacto (oscilador médio com pitch drop)
  var body = ac.createOscillator(); body.type = 'triangle';
  body.frequency.setValueAtTime(260 + f * 8, now);
  body.frequency.exponentialRampToValueAtTime(48, now + 0.14);
  var gBody = ac.createGain();
  gBody.gain.setValueAtTime(vol * 0.65, now);
  gBody.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
  body.connect(gBody); gBody.connect(ac.destination);
  body.start(now); body.stop(now + 0.20);

  // Camada 3: Clique de arestas (ruído curto highpass — "tac")
  var noiseLen = Math.floor(ac.sampleRate * 0.06);
  var nBuf = ac.createBuffer(1, noiseLen, ac.sampleRate);
  var nd = nBuf.getChannelData(0);
  for (var i = 0; i < noiseLen; i++) nd[i] = (Math.random()*2-1) * Math.pow(1 - i/noiseLen, 2.2);
  var ns = ac.createBufferSource(); ns.buffer = nBuf;
  var hp2 = ac.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 2800;
  var bp2 = ac.createBiquadFilter(); bp2.type = 'peaking'; bp2.frequency.value = 4500; bp2.gain.value = 9; bp2.Q.value = 1.2;
  var gNs = ac.createGain();
  gNs.gain.setValueAtTime(vol * 0.48, now);
  gNs.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
  ns.connect(hp2); hp2.connect(bp2); bp2.connect(gNs); gNs.connect(ac.destination);
  ns.start(now);

  // Camada 4: Reverb curto (pre-delay + decay) dá sensação de espaço na mesa
  if (f > 3) {
    var rvBuf = makeNoiseBuffer(ac, 0.18);
    var rvSrc = ac.createBufferSource(); rvSrc.buffer = rvBuf;
    var rvBp = ac.createBiquadFilter(); rvBp.type = 'bandpass'; rvBp.frequency.value = 900; rvBp.Q.value = 0.7;
    var rvG = ac.createGain();
    rvG.gain.setValueAtTime(0, now + 0.012);
    rvG.gain.linearRampToValueAtTime(vol * 0.12, now + 0.025);
    rvG.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    rvSrc.connect(rvBp); rvBp.connect(rvG); rvG.connect(ac.destination);
    rvSrc.start(now + 0.012);
  }
}

// ── RESULTADO — acorde mágico (preservado) ────────────────────────────────
function sndResult() {
  var ac = getAC(); if (!ac) return;
  var freqs = [293.66, 329.63, 392.00, 493.88];
  freqs.forEach(function(freq, i) {
    var t = ac.currentTime + i * 0.13;
    var osc  = ac.createOscillator(); osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    var lfo  = ac.createOscillator(); lfo.frequency.value = 5.5;
    var lfoG = ac.createGain(); lfoG.gain.value = 4;
    lfo.connect(lfoG); lfoG.connect(osc.frequency);
    var gain = ac.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.20, t + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    var dly  = ac.createDelay(0.5); dly.delayTime.value = 0.22;
    var dlyG = ac.createGain(); dlyG.gain.value = 0.3;
    osc.connect(gain); gain.connect(ac.destination);
    gain.connect(dly); dly.connect(dlyG); dlyG.connect(ac.destination);
    lfo.start(t); osc.start(t); osc.stop(t + 1.5); lfo.stop(t + 1.5);
  });
}

// ─── Pool de dados ──────────────────────────────────────────────────────────
function updatePoolUI() {
  poolChips.innerHTML = '';
  var keys = Object.keys(S.pool).filter(function(k){ return S.pool[k] > 0; });
  if (!keys.length) { poolChips.appendChild(poolEmpty); poolEmpty.style.display=''; return; }
  poolEmpty.style.display = 'none';
  keys.sort(function(a,b){return a-b;}).forEach(function(sides) {
    var chip = document.createElement('div'); chip.className = 'pool-chip';
    chip.innerHTML =
      '<img class="chip-icon" src="src/dice/d'+sides+'.png" alt=""/>'+
      '<span class="chip-label">'+S.pool[sides]+'×d'+sides+'</span>'+
      '<button class="chip-inc" data-sides="'+sides+'">+</button>'+
      '<button class="chip-dec" data-sides="'+sides+'">−</button>'+
      '<button class="chip-rm"  data-sides="'+sides+'">✕</button>';
    poolChips.appendChild(chip);
  });
  poolChips.querySelectorAll('.chip-inc').forEach(function(b){ b.addEventListener('click', function(){ addToPool(+b.dataset.sides); }); });
  poolChips.querySelectorAll('.chip-dec').forEach(function(b){ b.addEventListener('click', function(){ var s=+b.dataset.sides; if(S.pool[s]>1)S.pool[s]--; else delete S.pool[s]; updatePoolUI(); }); });
  poolChips.querySelectorAll('.chip-rm').forEach(function(b){  b.addEventListener('click', function(){ delete S.pool[+b.dataset.sides]; updatePoolUI(); }); });
}
function addToPool(sides) { S.pool[sides]=(S.pool[sides]||0)+1; updatePoolUI(); }
diceButtons.forEach(function(btn){ btn.addEventListener('click', function(){ addToPool(SIDES_MAP[btn.dataset.dice]); }); });
poolClear.addEventListener('click', function(){ S.pool={}; updatePoolUI(); });

// ─── d10: bipirâmide ─────────────────────────────────────────────────────────
function makeD10Geometry() {
  var radius=0.78, height=1.05, ring=5, top=[0,height,0], bottom=[0,-height,0], pts=[];
  for(var i=0;i<ring;i++){var a=(i/ring)*Math.PI*2; pts.push([Math.cos(a)*radius,i%2===0?0.14:-0.14,Math.sin(a)*radius]);}
  var pos=[];
  for(var j=0;j<ring;j++){var a2=pts[j],b2=pts[(j+1)%ring]; pos.push(top[0],top[1],top[2],a2[0],a2[1],a2[2],b2[0],b2[1],b2[2]); pos.push(bottom[0],bottom[1],bottom[2],b2[0],b2[1],b2[2],a2[0],a2[1],a2[2]);}
  var geo=new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); geo.computeVertexNormals(); return geo;
}

// ─── UV plano por face ─────────────────────────────────────────────────────
function planarizeFaceUVs(geometry) {
  var pos=geometry.attributes.position, idx=geometry.index;
  var uvArr=new Float32Array(pos.count*2);
  geometry.groups.forEach(function(group) {
    var verts=[];
    for(var i=0;i<group.count;i++) verts.push(idx?idx.getX(group.start+i):group.start+i);
    var A=new THREE.Vector3().fromBufferAttribute(pos,verts[0]);
    var B=new THREE.Vector3().fromBufferAttribute(pos,verts[1]);
    var C=new THREE.Vector3().fromBufferAttribute(pos,verts[2]);
    var tan=new THREE.Vector3().subVectors(B,A).normalize();
    var normal=new THREE.Vector3().subVectors(B,A).cross(new THREE.Vector3().subVectors(C,A)).normalize();
    var bitan=new THREE.Vector3().crossVectors(normal,tan).normalize();
    var unique=verts.filter(function(v,i){return verts.indexOf(v)===i;});
    var cen=new THREE.Vector3(); unique.forEach(function(vi){cen.add(new THREE.Vector3().fromBufferAttribute(pos,vi));});
    cen.divideScalar(unique.length);
    var local={}, maxR=0.0001;
    unique.forEach(function(vi){var v=new THREE.Vector3().fromBufferAttribute(pos,vi).sub(cen); var u=v.dot(tan),w=v.dot(bitan); local[vi]=[u,w]; var r=Math.sqrt(u*u+w*w); if(r>maxR)maxR=r;});
    var sc=0.42/maxR;
    verts.forEach(function(vi){uvArr[vi*2]=0.5+local[vi][0]*sc; uvArr[vi*2+1]=0.5+local[vi][1]*sc;});
  });
  geometry.setAttribute('uv',new THREE.BufferAttribute(uvArr,2));
}

var TRIS={4:1,6:null,8:1,10:1,12:3,20:1};
function geomFor(sides) {
  var geo;
  if(sides===4)      geo=new THREE.TetrahedronGeometry(0.95,0);
  else if(sides===6) geo=new THREE.BoxGeometry(1.2,1.2,1.2);
  else if(sides===8) geo=new THREE.OctahedronGeometry(0.95,0);
  else if(sides===10){geo=makeD10Geometry();}
  else if(sides===12)geo=new THREE.DodecahedronGeometry(0.88,0);
  else               geo=new THREE.IcosahedronGeometry(0.95,0);
  var tpf=TRIS[sides];
  if(tpf){var ni=(geo.index)?geo.toNonIndexed():geo; ni.clearGroups(); for(var f=0;f<sides;f++) ni.addGroup(f*tpf*3,tpf*3,f); planarizeFaceUVs(ni); ni.computeVertexNormals(); return ni;}
  return geo;
}

// ─── Normal local de face ─────────────────────────────────────────────────
function faceNormalLocal(geo,group){
  var pos=geo.attributes.position,idx=geo.index,i0,i1,i2;
  if(idx){i0=idx.getX(group.start);i1=idx.getX(group.start+1);i2=idx.getX(group.start+2);}
  else{i0=group.start;i1=group.start+1;i2=group.start+2;}
  var A=new THREE.Vector3().fromBufferAttribute(pos,i0);
  var B=new THREE.Vector3().fromBufferAttribute(pos,i1);
  var C=new THREE.Vector3().fromBufferAttribute(pos,i2);
  return new THREE.Vector3().subVectors(B,A).cross(new THREE.Vector3().subVectors(C,A)).normalize();
}
function getTopFace(mesh){
  var geo=mesh.geometry;
  if(!geo.groups||geo.groups.length===0) return 1;
  var best=-Infinity,top=1;
  geo.groups.forEach(function(group,i){
    var worldN=faceNormalLocal(geo,group).applyQuaternion(mesh.quaternion);
    if(worldN.dot(UP)>best){best=worldN.dot(UP);top=i+1;}
  });
  return top;
}

// ─── Textura de rachaduras ─────────────────────────────────────────────────
var crackTex=(function(){
  var sz=512,c=document.createElement('canvas'); c.width=sz;c.height=sz;
  var ctx=c.getContext('2d'); ctx.fillStyle='#808080'; ctx.fillRect(0,0,sz,sz);
  ctx.strokeStyle='rgba(20,20,20,0.4)'; ctx.lineWidth=1.2;
  for(var i=0;i<22;i++){
    var x=Math.random()*sz,y=Math.random()*sz; ctx.beginPath(); ctx.moveTo(x,y);
    for(var s=0;s<4;s++){x+=(Math.random()-.5)*80;y+=(Math.random()-.5)*80;ctx.lineTo(x,y);}
    ctx.stroke();
  }
  var t=new THREE.CanvasTexture(c); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(2,2); return t;
})();
var envTex=new THREE.TextureLoader().load('src/dice/d20.png');
envTex.mapping=THREE.SphericalReflectionMapping;

// ─── Textura de face ───────────────────────────────────────────────────────
var faceTexCache={};
function shade(hex,amt){
  var r=(hex>>16)&255,g=(hex>>8)&255,b=hex&255;
  function mix(c){return amt>=0?Math.round(c+(255-c)*amt):Math.round(c*(1+amt));}
  return 'rgb('+mix(r)+','+mix(g)+','+mix(b)+')';
}
function faceTex(n,sides){
  var key=sides+'_'+n; if(faceTexCache[key]) return faceTexCache[key];
  var sz=256,c=document.createElement('canvas'); c.width=sz;c.height=sz;
  var ctx=c.getContext('2d'),base=DICE_COLOR[sides]||0xb583e0;
  var grad=ctx.createRadialGradient(sz*.38,sz*.32,sz*.04,sz*.5,sz*.5,sz*.74);
  grad.addColorStop(0,shade(base,0.2)); grad.addColorStop(1,shade(base,-0.65));
  ctx.fillStyle=grad; ctx.fillRect(0,0,sz,sz);
  ctx.shadowColor='rgba(255,255,255,0.95)'; ctx.shadowBlur=28; ctx.fillStyle='#ffffff';
  var fs=sides<=6?114:sides<=8?100:84;
  ctx.font='bold '+fs+'px Cinzel,serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(String(n),sz/2,sz/2+4);
  ctx.shadowColor='rgba(180,140,255,0.7)'; ctx.shadowBlur=18; ctx.fillStyle='rgba(255,255,255,0.35)';
  ctx.fillText(String(n),sz/2,sz/2+4);
  var t=new THREE.CanvasTexture(c); faceTexCache[key]=t; return t;
}
function materialsFor(sides){
  var mats=[];
  for(var i=1;i<=sides;i++) mats.push(new THREE.MeshPhongMaterial({
    map:faceTex(i,sides),color:0xffffff,
    emissive:new THREE.Color(0x2a1540),emissiveIntensity:0.22,
    flatShading:true,shininess:18,specular:new THREE.Color(0x150a22),
    envMap:envTex,combine:THREE.MixOperation,reflectivity:0.06,
    bumpMap:crackTex,bumpScale:0.022,transparent:true,opacity:0.97,
  }));
  return mats;
}

// ─── Easing ─────────────────────────────────────────────────────────────
function easeInOutCubic(t){return t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;}

// ─── Texturas madeira / feltro ──────────────────────────────────────────────
function makeWoodTexture(repeatU,repeatV){
  var sz=1024,c=document.createElement('canvas'); c.width=sz;c.height=sz;
  var ctx=c.getContext('2d');
  var bg=ctx.createLinearGradient(0,0,sz,sz);
  bg.addColorStop(0,'#2c1a0e');bg.addColorStop(0.3,'#3d2310');bg.addColorStop(0.6,'#2a1608');bg.addColorStop(1,'#1e1006');
  ctx.fillStyle=bg; ctx.fillRect(0,0,sz,sz);
  for(var i=0;i<60;i++){
    var y0=Math.random()*sz,alpha=0.03+Math.random()*0.09,lighter=Math.random()<0.5;
    ctx.strokeStyle=lighter?'rgba(180,110,50,'+alpha+')':'rgba(10,4,0,'+alpha+')';
    ctx.lineWidth=0.5+Math.random()*2.5; ctx.beginPath(); ctx.moveTo(0,y0);
    for(var x=0;x<sz;x+=18){y0+=(Math.random()-0.5)*8;ctx.lineTo(x,y0);} ctx.stroke();
  }
  var knots=2+Math.floor(Math.random()*3);
  for(var k=0;k<knots;k++){
    var kx=sz*0.15+Math.random()*sz*0.7,ky=sz*0.15+Math.random()*sz*0.7;
    for(var r=28;r>0;r-=2){
      var a2=0.015+Math.random()*0.04;
      ctx.strokeStyle='rgba(15,6,0,'+a2+')';ctx.lineWidth=1.2;
      ctx.beginPath();ctx.ellipse(kx,ky,r,r*0.6,Math.random()*Math.PI,0,Math.PI*2);ctx.stroke();
    }
  }
  var gloss=ctx.createLinearGradient(0,0,sz,sz*0.6);
  gloss.addColorStop(0,'rgba(255,200,130,0.07)');gloss.addColorStop(0.4,'rgba(255,200,130,0.02)');gloss.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=gloss;ctx.fillRect(0,0,sz,sz);
  var vig=ctx.createRadialGradient(sz/2,sz/2,sz*0.25,sz/2,sz/2,sz*0.85);
  vig.addColorStop(0,'rgba(0,0,0,0)');vig.addColorStop(1,'rgba(0,0,0,0.55)');
  ctx.fillStyle=vig;ctx.fillRect(0,0,sz,sz);
  var t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(repeatU||2,repeatV||2);return t;
}
function makeFeltTexture(){
  var sz=512,c=document.createElement('canvas');c.width=sz;c.height=sz;
  var ctx=c.getContext('2d');
  ctx.fillStyle='#1a3320';ctx.fillRect(0,0,sz,sz);
  for(var i=0;i<12000;i++){
    var x=Math.random()*sz,y=Math.random()*sz,angle=Math.random()*Math.PI,len=1+Math.random()*2;
    var alpha=0.02+Math.random()*0.06;
    ctx.strokeStyle='rgba(80,160,80,'+alpha+')';ctx.lineWidth=0.5;
    ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.cos(angle)*len,y+Math.sin(angle)*len);ctx.stroke();
  }
  var glow=ctx.createRadialGradient(sz/2,sz/2,0,sz/2,sz/2,sz*.5);
  glow.addColorStop(0,'rgba(100,200,100,0.05)');glow.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=glow;ctx.fillRect(0,0,sz,sz);
  var t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(3,3);return t;
}

// ─── Mesa 3D ──────────────────────────────────────────────────────────────────
function buildTable(scene){
  var woodTex=makeWoodTexture(2,2),woodTexLeg=makeWoodTexture(1,4),feltTex=makeFeltTexture();
  var woodMat   =new THREE.MeshPhongMaterial({map:woodTex,   color:0xffffff,shininess:55,specular:new THREE.Color(0x3a1e08)});
  var woodMatLeg=new THREE.MeshPhongMaterial({map:woodTexLeg,color:0xffffff,shininess:45,specular:new THREE.Color(0x2a1206)});
  var feltMat   =new THREE.MeshPhongMaterial({map:feltTex,   color:0xffffff,shininess:4, specular:new THREE.Color(0x0a1a0a)});
  var TABLE_Y=FLOOR_Y,SLAB_H=0.22,RADIUS=5.6,LEG_H=2.8,LEG_R=0.18,LEG_DIST=3.8;
  var slab=new THREE.Mesh(new THREE.CylinderGeometry(RADIUS,RADIUS,SLAB_H,80),woodMat);
  slab.position.set(0,TABLE_Y-SLAB_H/2,0);scene.add(slab);
  var felt=new THREE.Mesh(new THREE.CylinderGeometry(RADIUS-0.12,RADIUS-0.12,0.012,80),feltMat);
  felt.position.set(0,TABLE_Y+0.006,0);scene.add(felt);
  var rim=new THREE.Mesh(new THREE.CylinderGeometry(RADIUS+0.05,RADIUS+0.14,SLAB_H+0.18,80,1,true),woodMat);
  rim.position.set(0,TABLE_Y-SLAB_H/2+0.04,0);scene.add(rim);
  var chamfer=new THREE.Mesh(new THREE.TorusGeometry(RADIUS+0.05,0.07,8,80),woodMat);
  chamfer.rotation.x=-Math.PI/2;chamfer.position.set(0,TABLE_Y-SLAB_H,0);scene.add(chamfer);
  var legPositions=[[LEG_DIST,LEG_DIST],[-LEG_DIST,LEG_DIST],[LEG_DIST,-LEG_DIST],[-LEG_DIST,-LEG_DIST]];
  function buildLeg(px,pz){
    var group=new THREE.Group();
    [{r:LEG_R*1.5,h:0.18,y:0},{r:LEG_R*1.1,h:0.35,y:0.18},{r:LEG_R*0.8,h:LEG_H*0.5,y:0.53},{r:LEG_R*1.05,h:0.2,y:0.53+LEG_H*0.5},{r:LEG_R*0.85,h:LEG_H*0.35,y:0.73+LEG_H*0.5},{r:LEG_R*1.3,h:0.22,y:0.73+LEG_H*0.85}].forEach(function(s){
      var m=new THREE.Mesh(new THREE.CylinderGeometry(s.r,s.r,s.h,16),woodMatLeg);
      m.position.y=s.y+s.h/2;group.add(m);
    });
    group.position.set(px,TABLE_Y-SLAB_H-LEG_H,pz);scene.add(group);
  }
  legPositions.forEach(function(lp){buildLeg(lp[0],lp[1]);});
  function buildStretcher(x1,z1,x2,z2){
    var dx=x2-x1,dz=z2-z1,len=Math.sqrt(dx*dx+dz*dz),angle=Math.atan2(dz,dx);
    var m=new THREE.Mesh(new THREE.CylinderGeometry(LEG_R*0.55,LEG_R*0.55,len,10),woodMatLeg);
    m.rotation.z=Math.PI/2;m.rotation.y=-angle;
    m.position.set((x1+x2)/2,TABLE_Y-SLAB_H-LEG_H*0.38,(z1+z2)/2);scene.add(m);
  }
  buildStretcher(LEG_DIST,LEG_DIST,-LEG_DIST,LEG_DIST);
  buildStretcher(-LEG_DIST,-LEG_DIST,LEG_DIST,-LEG_DIST);
  buildStretcher(LEG_DIST,LEG_DIST,LEG_DIST,-LEG_DIST);
  buildStretcher(-LEG_DIST,LEG_DIST,-LEG_DIST,-LEG_DIST);
  var ring=new THREE.Mesh(new THREE.RingGeometry(2.6,2.7,72),new THREE.MeshBasicMaterial({color:0x4fd6c4,side:THREE.DoubleSide,transparent:true,opacity:0.35}));
  ring.rotation.x=-Math.PI/2;ring.position.y=TABLE_Y+0.02;scene.add(ring);
  var ring2=new THREE.Mesh(new THREE.RingGeometry(4.2,4.28,72),new THREE.MeshBasicMaterial({color:0x9b63cf,side:THREE.DoubleSide,transparent:true,opacity:0.18}));
  ring2.rotation.x=-Math.PI/2;ring2.position.y=TABLE_Y+0.02;scene.add(ring2);
}

// ─── Física ───────────────────────────────────────────────────────────────
function initPhysics(){
  var world=new CANNON.World();
  world.gravity.set(0,-28,0);
  world.broadphase=new CANNON.NaiveBroadphase();
  world.solver.iterations=20;
  world.allowSleep=true;
  var diceMat=new CANNON.Material('dice'),floorMat=new CANNON.Material('floor');
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat,floorMat,{friction:0.55,restitution:0.60}));
  world.addContactMaterial(new CANNON.ContactMaterial(diceMat,diceMat,{friction:0.4, restitution:0.45}));
  S.diceMat=diceMat; S.floorMat=floorMat;
  var floor=new CANNON.Body({mass:0,material:floorMat});
  floor.addShape(new CANNON.Plane());
  floor.quaternion.setFromAxisAngle(new CANNON.Vec3(1,0,0),-Math.PI/2);
  floor.position.set(0,FLOOR_Y,0); world.addBody(floor);
  function addWall(x,z,ry){
    var b=new CANNON.Body({mass:0}); b.addShape(new CANNON.Box(new CANNON.Vec3(6,4,0.18)));
    b.position.set(x,0,z); b.quaternion.setFromEuler(0,ry,0); world.addBody(b);
  }
  addWall(0,-3.5,0); addWall(0,3.5,0); addWall(-3.5,0,Math.PI/2); addWall(3.5,0,Math.PI/2);
  S.world=world;
}

// ─── Limpar dados ─────────────────────────────────────────────────────────
function clearDice(){
  S.dice.forEach(function(d){
    S.scene.remove(d.mesh);
    d.mesh.geometry.dispose();
    d.mesh.material.forEach(function(m){m.dispose();});
    if(S.world) S.world.remove(d.body);
  });
  S.dice=[];
}

// ─── Câmera zoom ─────────────────────────────────────────────────────────────
function startRevealSequence(){
  S.revealQueue=S.dice.slice();
  engineStatus.textContent='Revelando resultado…';
  nextReveal();
}
function nextReveal(){
  if(!S.revealQueue.length){
    S.camPhase='zoomOut'; S.camPhaseStart=performance.now();
    S.camFromPos=S.camera.position.clone(); S.camFromLook=S.camLook.clone(); return;
  }
  var d=S.revealQueue.shift();
  var focus=new THREE.Vector3(d.mesh.position.x,-0.1,d.mesh.position.z);
  var dir=new THREE.Vector3().subVectors(CAM_HOME,focus).normalize();
  S.camPhase='zoomIn'; S.camPhaseStart=performance.now();
  S.camFromPos=S.camera.position.clone(); S.camFromLook=S.camLook.clone();
  S.camToPos=focus.clone().add(dir.multiplyScalar(3.2)).add(new THREE.Vector3(0,1.2,0));
  S.camToLook=focus.clone().add(new THREE.Vector3(0,0.2,0));
}

// ─── Resultado final ─────────────────────────────────────────────────────────
function showFinalResult(){
  diceResultsGrid.innerHTML='';
  Object.keys(S.pendingByType).sort(function(a,b){return a-b;}).forEach(function(s){
    S.pendingByType[s].forEach(function(val){
      var item=document.createElement('div'); item.className='result-die-item';
      item.innerHTML='<img class="result-die-icon" src="src/dice/d'+s+'.png" alt=""/>'+
        '<span class="result-die-label">d'+s+'</span>'+
        '<span class="result-die-value">'+val+'</span>';
      diceResultsGrid.appendChild(item);
    });
  });
  resultTotalVal.textContent=S.pendingTotal;
  resultTotalRow.style.display='flex';
  showMagicReveal(S.pendingTotal, S.pendingParts);
  sndResult();
  engineStatus.textContent='Dado parou — veja o resultado';
}
function calcResults(){
  var byType={},total=0;
  S.dice.forEach(function(d){
    var face=getTopFace(d.mesh);
    if(!byType[d.sides]) byType[d.sides]=[];
    byType[d.sides].push(face); total+=face;
  });
  var parts=[];
  Object.keys(byType).sort(function(a,b){return a-b;}).forEach(function(s){
    parts.push(byType[s].length+'×d'+s+': '+byType[s].join(', '));
  });
  S.pendingTotal=total; S.pendingParts=parts.join(' | '); S.pendingByType=byType;
}
function revealResults(){
  if(S.suspenseTimer){clearInterval(S.suspenseTimer);S.suspenseTimer=null;}
  sndRollStop();
  calcResults();
  startRevealSequence();
}

// ─── Overlay mágico ──────────────────────────────────────────────────────
function showMagicReveal(total,subtitle){
  var overlay=document.getElementById('reveal-overlay');
  var numEl=document.getElementById('reveal-number');
  var subEl=document.getElementById('reveal-subtitle');
  var sparklesEl=document.getElementById('reveal-sparkles');
  numEl.textContent=total; subEl.textContent=subtitle; sparklesEl.innerHTML='';
  for(var i=0;i<20;i++){
    var dot=document.createElement('div'); dot.className='sparkle-dot';
    var angle=(i/20)*Math.PI*2,dist=70+Math.random()*90;
    dot.style.setProperty('--tx',Math.cos(angle)*dist+'px');
    dot.style.setProperty('--ty',Math.sin(angle)*dist+'px');
    dot.style.setProperty('--tr',(Math.random()*360)+'deg');
    dot.style.animationDelay=(Math.random()*.35)+'s';
    dot.style.background=Math.random()<.5?'var(--color-accent)':'#4fd6c4';
    sparklesEl.appendChild(dot);
  }
  overlay.classList.remove('fadeout'); overlay.classList.add('active');
  setTimeout(function(){
    overlay.classList.add('fadeout');
    setTimeout(function(){overlay.classList.remove('active','fadeout');},500);
  },3200);
}

// ─── Verificar se dado parou ─────────────────────────────────────────────
function isDiceStopped(body){
  if(body.sleepState===2) return true;
  var av=body.angularVelocity,lv=body.velocity;
  return Math.sqrt(av.x*av.x+av.y*av.y+av.z*av.z)<0.4 && Math.sqrt(lv.x*lv.x+lv.y*lv.y+lv.z*lv.z)<0.3;
}

// ─── Lançar dados ─────────────────────────────────────────────────────────
function rollPool(){
  if(!S.scene||!S.world) return;
  var keys=Object.keys(S.pool).filter(function(k){return S.pool[k]>0;});
  if(!keys.length){engineStatus.textContent='Adicione dados ao pool primeiro!';return;}

  initAC(); // AudioContext dentro do clique

  if(S.suspenseTimer){clearInterval(S.suspenseTimer);S.suspenseTimer=null;}
  sndRollStop();
  clearDice();

  S.camPhase='idle'; S.camera.position.copy(CAM_HOME); S.camLook.copy(CAM_LOOK_HOME);

  var diceList=[];
  keys.forEach(function(s){for(var i=0;i<S.pool[s];i++) diceList.push(+s);});
  diceList.sort(function(){return Math.random()-.5;});

  S.rolling=true;
  S.rollStartTime=performance.now();
  engineStatus.textContent='Lançando os dados…';
  diceResultsGrid.innerHTML='<p class="no-result">Rolando…</p>';
  resultTotalRow.style.display='none';

  sndThrow();
  setTimeout(sndRollStart, 220);

  diceList.forEach(function(sides,idx){
    var geo=geomFor(sides);
    var mesh=new THREE.Mesh(geo,materialsFor(sides));

    var startX=(Math.random()-.5)*2.4;
    var startY=4.5+idx*0.65;
    var startZ=(Math.random()-.5)*2.4;
    mesh.position.set(startX,startY,startZ);

    var body=new CANNON.Body({
      mass:0.4, material:S.diceMat,
      linearDamping:0.25,
      angularDamping:0.50,
      allowSleep:true, sleepSpeedLimit:0.2, sleepTimeLimit:0.7,
    });
    body.addShape(sides===6?new CANNON.Box(new CANNON.Vec3(0.6,0.6,0.6)):new CANNON.Sphere(0.62));
    body.position.set(startX,startY,startZ);
    var eq=new CANNON.Quaternion();
    eq.setFromEuler(Math.random()*Math.PI*2,Math.random()*Math.PI*2,Math.random()*Math.PI*2);
    body.quaternion.copy(eq);

    body.velocity.set(
      (Math.random()-.5)*6.0,
      -4.5,
      (Math.random()-.5)*6.0
    );
    body.angularVelocity.set(
      (Math.random()-.5)*48,
      (Math.random()-.5)*48,
      (Math.random()-.5)*48
    );

    body.addEventListener('collide', function(e){
      if(!S.rolling) return;
      var force = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if(force > 0.8) sndBounce(force);
    });

    S.world.addBody(body);
    S.scene.add(mesh);
    S.dice.push({mesh:mesh,body:body,sides:sides});
  });

  var msgs=['Os dados voam pela mesa…','Quicando e girando…','Batendo uns nos outros…','Desacelerando…','Quase parando…'];
  var mi=0;
  S.suspenseTimer=setInterval(function(){
    if(!S.rolling){clearInterval(S.suspenseTimer);return;}
    engineStatus.textContent=msgs[mi%msgs.length];mi++;
  },2000);
}
rollBtn.addEventListener('click',rollPool);

// ─── Cena Three.js ────────────────────────────────────────────────────────
function getSize(){return{w:(shell&&shell.clientWidth)||800,h:(shell&&shell.clientHeight)||540};}
function initScene(){
  var sz=getSize();
  var renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  renderer.setSize(sz.w,sz.h); renderer.shadowMap.enabled=false;
  var scene=new THREE.Scene();
  scene.background=new THREE.Color(0x08050f);
  scene.fog=new THREE.FogExp2(0x08050f,0.038);
  var camera=new THREE.PerspectiveCamera(40,sz.w/sz.h,0.1,80);
  camera.position.copy(CAM_HOME); S.camLook.copy(CAM_LOOK_HOME); camera.lookAt(S.camLook);
  scene.add(new THREE.AmbientLight(0x1a1030,1.1));
  var candle1=new THREE.PointLight(0xffaa44,2.0,28); candle1.position.set(3.5,3.5,1.5); scene.add(candle1);
  var candle2=new THREE.PointLight(0xff8833,1.2,20); candle2.position.set(-3.2,3.0,2.0); scene.add(candle2);
  var rim=new THREE.DirectionalLight(0x6040c0,0.5); rim.position.set(-2,6,-5); scene.add(rim);
  var top=new THREE.DirectionalLight(0xc08060,0.4); top.position.set(0,10,0); scene.add(top);
  var under=new THREE.PointLight(0x2a1506,0.6,12); under.position.set(0,-1.5,0); scene.add(under);
  buildTable(scene);
  var pg=new THREE.BufferGeometry(),pp=[],pCount=100;
  for(var i=0;i<pCount;i++) pp.push((Math.random()-.5)*13,(Math.random()-.5)*5+1.5,(Math.random()-.5)*11);
  pg.setAttribute('position',new THREE.Float32BufferAttribute(pp,3));
  S.particles=new THREE.Points(pg,new THREE.PointsMaterial({color:0xc8aaff,size:0.05,transparent:true,opacity:0.5,depthWrite:false}));
  scene.add(S.particles); S.partOrigPos=pp.slice();
  S.renderer=renderer; S.scene=scene; S.camera=camera;
  engineStatus.textContent='Pronto — monte seu pool de dados';
  initPhysics(); animate();
}

// ─── Loop de animação ─────────────────────────────────────────────────────
var clock=0;
function animate(){
  requestAnimationFrame(animate);
  var nowMs=performance.now();
  clock+=0.011;
  if(S.particles){
    var pp=S.particles.geometry.attributes.position;
    for(var i=0;i<pp.count;i++){
      pp.setY(i,S.partOrigPos[i*3+1]+Math.sin(clock+i*0.65)*0.1);
      pp.setX(i,S.partOrigPos[i*3]+Math.cos(clock*0.5+i*0.5)*0.05);
    }
    pp.needsUpdate=true;
  }
  if(S.world){
    var nowSec=nowMs/1000;
    if(S.lastStepTime!==null){
      var dt=Math.min(nowSec-S.lastStepTime,0.05);
      S.world.step(1/120,dt,6);
    }
    S.lastStepTime=nowSec;
    S.dice.forEach(function(d){d.mesh.position.copy(d.body.position); d.mesh.quaternion.copy(d.body.quaternion);});
    if(S.rolling){
      var elapsed=nowMs-S.rollStartTime;
      var pastMin=elapsed>MIN_ROLL_MS,pastMax=elapsed>MAX_ROLL_MS;
      if(pastMin||pastMax){
        var allStopped=S.dice.length>0&&S.dice.every(function(d){return isDiceStopped(d.body);});
        if(allStopped||pastMax){
          if(pastMax){S.dice.forEach(function(d){d.body.velocity.set(0,0,0);d.body.angularVelocity.set(0,0,0);d.body.sleep();});}
          S.rolling=false;
          revealResults();
        }
      }
    }
  }
  var cp=S.camPhase,ct,ot;
  if(cp==='zoomIn'){
    ct=Math.min(1,(nowMs-S.camPhaseStart)/900);
    S.camera.position.lerpVectors(S.camFromPos,S.camToPos,easeInOutCubic(ct));
    S.camLook.lerpVectors(S.camFromLook,S.camToLook,easeInOutCubic(ct));
    if(ct>=1){S.camPhase='hold';S.camPhaseStart=nowMs;}
  } else if(cp==='hold'){
    if(nowMs-S.camPhaseStart>=(S.revealQueue&&S.revealQueue.length?1400:1800)) nextReveal();
  } else if(cp==='zoomOut'){
    ot=Math.min(1,(nowMs-S.camPhaseStart)/1100);
    S.camera.position.lerpVectors(S.camFromPos,CAM_HOME,easeInOutCubic(ot));
    S.camLook.lerpVectors(S.camFromLook,CAM_LOOK_HOME,easeInOutCubic(ot));
    if(ot>=1){S.camPhase='idle'; showFinalResult();}
  }
  S.camera.lookAt(S.camLook);
  S.renderer.render(S.scene,S.camera);
}

window.addEventListener('resize',function(){
  if(!S.renderer||!S.camera) return;
  var sz=getSize(); S.renderer.setSize(sz.w,sz.h); S.camera.aspect=sz.w/sz.h; S.camera.updateProjectionMatrix();
});

// ─── Init ─────────────────────────────────────────────────────────────────
updatePoolUI();
initScene();

})();
