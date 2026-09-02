/**
 * AeroTennis Engine: Zero-Latency Audio Synthesis, Sensor Stroke Recognition,
 * Tennis Rules FSM, and WebRTC Direct P2P DataChannels.
 */

// --- 1. GAME CONSTANTS & STATE ---
const BALL_FLIGHT_TIME = 1.8;      // Ball travel duration (seconds)
const HIT_WINDOW = 0.400;           // 400ms hit detection window
const ACCEL_THRESHOLD = 18.0;       // m/s^2 acceleration spike threshold (~1.84g)
const COOL_DOWN_MS = 600;           // Prevent accidental double-swings

const GameState = {
  UNINITIALIZED: 'UNINITIALIZED',
  LOBBY: 'LOBBY',
  WAITING_FOR_SERVE: 'WAITING_FOR_SERVE',
  BALL_IN_FLIGHT: 'BALL_IN_FLIGHT',
  POINT_ENDED: 'POINT_ENDED',
  MATCH_OVER: 'MATCH_OVER'
};

let state = GameState.UNINITIALIZED;
let isHost = true;
let isMyTurnToServe = true;
let serveCount = 0; // Tracks alternating sides (Deuce court vs Ad court)
let practiceMode = false;

// Tennis Scoring FSM
const TENNIS_POINTS = ['Love', '15', '30', '40'];
let scoreP1 = 0; // Local
let scoreP2 = 0; // Remote / Wall
let gamesP1 = 0;
let gamesP2 = 0;

// Active Ball Trajectory
let incomingSide = null; // 'LEFT' or 'RIGHT'
let ballStartTime = 0;
let sweetSpotTime = 0;
let lastSwingTime = 0;
let pendingBallTimeout = null;

// --- 2. HARDWARE AUDIO ENGINE (Web Audio API) ---
let audioCtx = null;
let masterGain = null;

function initAudio() {
  if (audioCtx) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext();
  masterGain = audioCtx.createGain();
  masterGain.connect(audioCtx.destination);
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

// Umpire Voice Synthesizer
function announceScore(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  window.speechSynthesis.speak(utterance);
}

// 3D Spatial Ball Trajectory Sound
function playApproachingBall(side, duration) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const pan = audioCtx.createStereoPanner();
  const filter = audioCtx.createBiquadFilter();

  const now = audioCtx.currentTime;

  // Spatial Panning: Left = -1.0, Right = 1.0
  pan.pan.setValueAtTime(side === 'LEFT' ? -1.0 : 1.0, now);

  // Frequency Ramps up as the ball approaches
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(140, now);
  osc.frequency.exponentialRampToValueAtTime(420, now + duration);

  // Low-pass filter opens up to simulate proximity
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(300, now);
  filter.frequency.exponentialRampToValueAtTime(4000, now + duration);

  // Volume: Exponential envelope peaking at sweet-spot
  gain.gain.setValueAtTime(0.01, now);
  gain.gain.exponentialRampToValueAtTime(0.9, now + duration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(pan);
  pan.connect(masterGain);

  osc.start(now);
  osc.stop(now + duration);
}

// Sweet-spot racket hit sound (Punchy dynamic transient)
function playRacketHit(quality = 'PERFECT') {
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = 'triangle';
  const freq = quality === 'PERFECT' ? 240 : 160;
  osc.frequency.setValueAtTime(freq, now);
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.12);

  gain.gain.setValueAtTime(1.0, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + 0.12);

  if (navigator.vibrate) {
    navigator.vibrate(quality === 'PERFECT' ? 60 : [30, 30, 30]);
  }
}

// Missed Ball Sound (Whiff and court bounce)
function playMissSound() {
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(80, now + 0.35);

  gain.gain.setValueAtTime(0.6, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

  osc.connect(gain);
  gain.connect(masterGain);
  osc.start(now);
  osc.stop(now + 0.35);
}

// --- 3. HARDWARE SENSOR & STROKE ENGINE ---
let currentOrientation = { beta: 0, gamma: 0 };

window.addEventListener('deviceorientation', (e) => {
  currentOrientation.beta = e.beta || 0;   // Front/Back tilt
  currentOrientation.gamma = e.gamma || 0; // Left/Right roll
});

function initSensors() {
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
      .then((permissionState) => {
        if (permissionState === 'granted') {
          window.addEventListener('devicemotion', handleMotion);
        }
      })
      .catch(console.error);
  } else {
    window.addEventListener('devicemotion', handleMotion);
  }
}

function handleMotion(e) {
  const acc = e.accelerationIncludingGravity || e.acceleration;
  if (!acc) return;

  const totalAccel = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
  
  // Verify horizontal racket grip face
  // Screen facing away (Forehand/Right): beta is typically positive/neutral
  // Screen facing user (Backhand/Left): phone inverted 180 degrees
  const detectedSide = Math.abs(currentOrientation.gamma) > 90 || currentOrientation.beta < 0 
    ? 'LEFT' 
    : 'RIGHT';

  document.getElementById('sensor-debug').innerText = 
    `Accel: ${(totalAccel / 9.8).toFixed(1)}g | Face: ${detectedSide}`;

  // Process stroke execution
  const now = performance.now();
  if (totalAccel > ACCEL_THRESHOLD && (now - lastSwingTime) > COOL_DOWN_MS) {
    lastSwingTime = now;
    processSwing(detectedSide, now);
  }
}

function processSwing(strokeSide, timestamp) {
  // 1. Serving from rest state
  if (state === GameState.WAITING_FOR_SERVE && isMyTurnToServe) {
    triggerServe(strokeSide);
    return;
  }

  // 2. Returning incoming rally ball
  if (state === GameState.BALL_IN_FLIGHT && incomingSide !== null) {
    clearTimeout(pendingBallTimeout);

    const timeDiff = (timestamp - sweetSpotTime) / 1000; // in seconds
    const withinWindow = Math.abs(timeDiff) <= (HIT_WINDOW / 2);
    const correctFace = (strokeSide === incomingSide);

    if (withinWindow && correctFace) {
      // Successful Return
      const hitType = Math.abs(timeDiff) < 0.08 ? 'PERFECT' : 'GOOD';
      playRacketHit(hitType);
      document.getElementById('game-status').innerText = `Returned! (${hitType})`;

      state = GameState.WAITING_FOR_SERVE;
      incomingSide = null;

      // Pick random return path for the opponent (Option C)
      const nextSide = Math.random() > 0.5 ? 'RIGHT' : 'LEFT';
      sendP2PMessage({ type: 'BALL_RETURNED', targetSide: nextSide });

      if (practiceMode) {
        setTimeout(() => simulateWallReturn(nextSide), 1000);
      }
    } else {
      // Fault: Wrong face orientation or bad timing
      playMissSound();
      handlePointOver(false, correctFace ? 'Timing Fault!' : 'Wrong Racket Face!');
    }
  }
}

function triggerServe(strokeSide) {
  playRacketHit('PERFECT');
  state = GameState.BALL_IN_FLIGHT;
  document.getElementById('game-status').innerText = 'Ball in Play';

  // Law of tennis: Serve side alternates each point
  const nextTarget = Math.random() > 0.5 ? 'RIGHT' : 'LEFT';
  sendP2PMessage({ type: 'BALL_RETURNED', targetSide: nextTarget });

  if (practiceMode) {
    setTimeout(() => simulateWallReturn(nextTarget), 1000);
  }
}

// --- 4. TENNIS RULES ENGINE & SCORING ---
function handlePointOver(p1Won, reason) {
  state = GameState.POINT_ENDED;
  document.getElementById('game-status').innerText = reason;

  if (p1Won) {
    scoreP1++;
  } else {
    scoreP2++;
  }

  updateScoreboard();
  resolveTennisScoring();
}

function resolveTennisScoring() {
  let scoreText = '';
  // Check Game Wins
  if (scoreP1 >= 4 && scoreP1 - scoreP2 >= 2) {
    gamesP1++;
    scoreP1 = 0;
    scoreP2 = 0;
    announceScore('Game, Player 1');
  } else if (scoreP2 >= 4 && scoreP2 - scoreP1 >= 2) {
    gamesP2++;
    scoreP1 = 0;
    scoreP2 = 0;
    announceScore('Game, Player 2');
  } else if (scoreP1 >= 3 && scoreP2 >= 3) {
    // Deuce / Advantage Logic
    if (scoreP1 === scoreP2) {
      scoreText = 'Deuce';
    } else if (scoreP1 > scoreP2) {
      scoreText = 'Advantage, Player 1';
    } else {
      scoreText = 'Advantage, Player 2';
    }
  } else {
    // Standard notation
    scoreText = `${TENNIS_POINTS[scoreP1]} - ${TENNIS_POINTS[scoreP2]}`;
  }

  serveCount++;
  // Server alternates every game in official tennis; alternates court side every point
  const serverStr = isMyTurnToServe ? 'You to serve' : 'Opponent to serve';
  const announcement = `${scoreText}. ${serverStr}`;

  setTimeout(() => {
    announceScore(announcement);
    document.getElementById('game-status').innerText = announcement;
    state = GameState.WAITING_FOR_SERVE;
  }, 1200);
}

function updateScoreboard() {
  document.getElementById('p1-score').innerText = scoreP1 >= 3 && scoreP2 >= 3 
    ? (scoreP1 > scoreP2 ? 'AD' : (scoreP1 === scoreP2 ? '40' : '-')) 
    : TENNIS_POINTS[scoreP1];
    
  document.getElementById('p2-score').innerText = scoreP1 >= 3 && scoreP2 >= 3 
    ? (scoreP2 > scoreP1 ? 'AD' : (scoreP2 === scoreP1 ? '40' : '-')) 
    : TENNIS_POINTS[scoreP2];
}

// Receive incoming ball from opponent
function receiveIncomingBall(side) {
  incomingSide = side;
  state = GameState.BALL_IN_FLIGHT;
  ballStartTime = performance.now();
  sweetSpotTime = ballStartTime + (BALL_FLIGHT_TIME * 1000);

  document.getElementById('game-status').innerText = `Incoming Ball (${side})!`;
  playApproachingBall(side, BALL_FLIGHT_TIME);

  // If player does not swing within the hit window, trigger automatic miss
  pendingBallTimeout = setTimeout(() => {
    playMissSound();
    handlePointOver(false, 'Missed Ball!');
    sendP2PMessage({ type: 'POINT_CONCEDED' });
  }, (BALL_FLIGHT_TIME + (HIT_WINDOW / 2)) * 1000);
}

function simulateWallReturn(side) {
  receiveIncomingBall(side);
}

// --- 5. P2P WEBRTC DATACHANNEL NETWORKING (ZERO SERVER LAG) ---
let peerConnection = null;
let dataChannel = null;

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function setupWebRTC() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) {
      // ICE Gathering complete: write SDP to box
      document.getElementById('sdp-box').value = btoa(JSON.stringify(peerConnection.localDescription));
    }
  };

  if (isHost) {
    dataChannel = peerConnection.createDataChannel('aero-tennis', { ordered: false, maxRetransmits: 0 });
    bindDataChannel();
    peerConnection.createOffer().then((offer) => peerConnection.setLocalDescription(offer));
  } else {
    peerConnection.ondatachannel = (event) => {
      dataChannel = event.channel;
      bindDataChannel();
    };
  }
}

function bindDataChannel() {
  dataChannel.onopen = () => {
    document.getElementById('game-status').innerText = 'Connected! Ready to Play.';
    document.getElementById('p2p-setup').style.display = 'none';
    state = GameState.WAITING_FOR_SERVE;
    announceScore('Match Connected. Play begins.');
  };

  dataChannel.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'BALL_RETURNED') {
      receiveIncomingBall(msg.targetSide);
    } else if (msg.type === 'POINT_CONCEDED') {
      handlePointOver(true, 'Opponent Missed!');
    }
  };
}

function sendP2PMessage(payload) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(payload));
  }
}

// --- 6. USER INTERACTION & LIFECYCLE ---
document.getElementById('start-btn').addEventListener('click', () => {
  initAudio();
  initSensors();
  document.getElementById('start-btn').style.display = 'none';
  document.getElementById('p2p-setup').style.display = 'flex';
  document.getElementById('practice-btn').style.display = 'block';
  document.getElementById('game-status').innerText = 'Select Match Type';
});

document.getElementById('host-btn').addEventListener('click', () => {
  isHost = true;
  isMyTurnToServe = true;
  setupWebRTC();
  document.getElementById('connect-btn').style.display = 'block';
  document.getElementById('connect-btn').innerText = 'Paste Opponent Key & Connect';
});

document.getElementById('join-btn').addEventListener('click', () => {
  isHost = false;
  isMyTurnToServe = false;
  setupWebRTC();
  document.getElementById('connect-btn').style.display = 'block';
  document.getElementById('connect-btn').innerText = 'Paste Host Key & Connect';
});

document.getElementById('connect-btn').addEventListener('click', () => {
  const remoteSDP = JSON.parse(atob(document.getElementById('sdp-box').value.trim()));
  peerConnection.setRemoteDescription(new RTCSessionDescription(remoteSDP)).then(() => {
    if (!isHost) {
      peerConnection.createAnswer().then((answer) => {
        peerConnection.setLocalDescription(answer);
      });
    }
  });
});

document.getElementById('practice-btn').addEventListener('click', () => {
  practiceMode = true;
  document.getElementById('p2p-setup').style.display = 'none';
  document.getElementById('practice-btn').style.display = 'none';
  state = GameState.WAITING_FOR_SERVE;
  isMyTurnToServe = true;
  document.getElementById('game-status').innerText = 'Practice Mode Active. Perform Forehand or Backhand to serve.';
  announceScore('Practice Mode. You to serve.');
});

// --- 7. CYBERPUNK AUDIO RADAR VISUALIZER ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function renderRadar() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Static Radar Rings
  ctx.strokeStyle = '#1d2130';
  ctx.lineWidth = 2;
  for (let r = 20; r <= 70; r += 25) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Active Ball Trajectory Visualization
  if (state === GameState.BALL_IN_FLIGHT && incomingSide) {
    const elapsed = (performance.now() - ballStartTime) / 1000;
    const progress = Math.min(elapsed / BALL_FLIGHT_TIME, 1.0);
    const targetX = incomingSide === 'LEFT' ? cx - 80 * progress : cx + 80 * progress;
    
    ctx.fillStyle = '#00ff88';
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(targetX, cy, 6 + (progress * 8), 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  requestAnimationFrame(renderRadar);
}
renderRadar();
