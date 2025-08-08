
// ==================== CẤU HÌNH ====================
// Nếu bạn đã deploy backend (Vercel/Cloudflare) theo mẫu mình gửi lúc trước,
// đặt BASE_URL = 'https://<tên-miền-backend>'.
// Nếu để chuỗi rỗng '', app sẽ dùng giọng trình duyệt (fallback).
const BACKEND_BASE_URL = '';

// Map giọng Google Cloud TTS (Neural2) nếu dùng backend
const GOOGLE_VOICES = {
  'en-GB:female': 'en-GB-Neural2-C',
  'en-GB:male':   'en-GB-Neural2-D',
  'en-US:female': 'en-US-Neural2-F',
  'en-US:male':   'en-US-Neural2-J'
};

// ==================== TIỆN ÍCH ====================
function $(id){ return document.getElementById(id); }
function setText(el, text) { el.textContent = text || '—'; }
function showNotice(msg, type='info'){
  const n = $('notice');
  n.className = 'notice ' + type;
  n.innerHTML = msg;
}
function clearNotice(){ showNotice('', ''); }

function safeJSON(text){
  try { return JSON.parse(text); } catch(e){
    const m = text && text.match && text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('JSON không hợp lệ từ API');
  }
}

// Thought groups không để “từ chức năng” lẻ loi ở cuối
function validateThoughtGroups(groups){
  const lonely = /\b(a|an|the|in|on|at|to|of|is|are|and|but|or)\b$/i;
  return groups && groups.every(g => !lonely.test(g.trim()));
}

// ==================== BROWSER TTS (FALLBACK) ====================
function pickBrowserVoice(locale='en-GB', gender='female'){
  const voices = window.speechSynthesis.getVoices() || [];
  // ưu tiên theo gender tag trong tên
  const candidates = voices.filter(v => v.lang && v.lang.startsWith(locale));
  if (!candidates.length) return null;
  // heuristics đơn giản
  const byGender = candidates.filter(v => new RegExp(gender, 'i').test(v.name));
  return (byGender[0] || candidates[0]) || null;
}

async function speakWithBrowserTTS(text, locale, gender, natural=true){
  if (!('speechSynthesis' in window)){
    throw new Error('Trình duyệt không hỗ trợ SpeechSynthesis');
  }
  // Nếu muốn “rõ từng cụm” mà không có SSML, ta hạ tốc độ + chèn dấu chấm
  const processed = natural ? text : text.replace(/\s*,\s*/g, '. ').replace(/\s+/g, ' ') + '.';
  await new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(processed);
    u.lang = locale;
    const voice = pickBrowserVoice(locale, gender);
    if (voice) u.voice = voice;
    u.rate = natural ? 1.0 : 0.9;
    u.pitch = natural ? 0.9 : 0.8;
    u.onend = resolve;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

// ==================== GOOGLE TTS QUA BACKEND ====================
async function speakWithGoogleTTS(text, groups, accent, gender, natural=true){
  if (!BACKEND_BASE_URL) throw new Error('Chưa cấu hình BACKEND_BASE_URL');
  const key = `${accent}:${gender}`;
  const voice = GOOGLE_VOICES[key] || (accent==='en-GB' ? 'en-GB-Neural2-C' : 'en-US-Neural2-F');

  const buildSSML = (txt, gs, nat=true) => {
    if (!gs || !gs.length){ return `<speak>${txt}</speak>`; }
    const esc = s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const parts = gs.map(esc);
    return nat
      ? `<speak>${parts.join('<break time="180ms"/>')}</speak>`
      : `<speak><prosody rate="0.95">${parts.join('<break time="350ms"/>')}</prosody></speak>`;
  };

  const ssml = buildSSML(text, groups && groups.length ? groups : [text], natural);
  const body = { ssml, voice, rate: natural ? 1.0 : 0.95, pitch: natural ? -1 : -2 };

  const r = await fetch(`${BACKEND_BASE_URL}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok){
    const t = await r.text();
    throw new Error('TTS lỗi: ' + t);
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.play();
}

// ==================== GỌI /api/text (GEMINI) ====================
async function getIPAAndGroupsViaBackend(text){
  if (!BACKEND_BASE_URL) throw new Error('Chưa cấu hình BACKEND_BASE_URL');
  const prompt = [
    "Bạn là chuyên gia dạy phát âm tiếng Anh cho người Việt.",
    "Trả về JSON duy nhất theo mẫu:",
    "{",
    '  "ipa": "<IPA của câu, chuẩn BrE/AmE tùy nội dung>",',
    '  "thought_groups": ["...", "..."]',
    "}",
    "Yêu cầu:",
    "- Không thuyết minh, không giải thích ngoài JSON.",
    '- "thought_groups": chia cụm tự nhiên, không để từ chức năng lẻ loi ở cuối.',
    "Văn bản: <<<" + text + ">>>"
  ].join("\\n");

  const payload = {
    model: 'gemini-2.0-flash-lite-preview-02-05',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
      topK: 1,
      topP: 0.1,
      candidateCount: 1
    },
    contents: [
      { role: 'user', parts: [{ text: prompt }] }
    ]
  };

  const r = await fetch(`${BACKEND_BASE_URL}/api/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Text API lỗi: ' + t);
  const data = safeJSON(t);
  let outText = '';
  try {
    outText = data.candidates[0].content.parts[0].text;
  } catch {}
  const parsed = safeJSON(outText);
  if (!validateThoughtGroups(parsed.thought_groups || [])){
    parsed.thought_groups = [text];
  }
  return parsed;
}

// ==================== SỰ KIỆN UI ====================
async function onSpeak(natural){
  clearNotice();
  const text = $('text-input').value.trim();
  if (!text) return;
  const accent = $('accent').value;
  const gender = $('gender').value;

  let groups = $('groups').textContent && $('groups').textContent !== '—'
    ? $('groups').textContent.split(' | ').map(s=>s.trim()).filter(Boolean)
    : [];

  try {
    if (BACKEND_BASE_URL){
      await speakWithGoogleTTS(text, groups, accent, gender, natural);
      showNotice('Đang phát bằng Google Neural2 (qua backend).', 'ok');
    } else {
      await speakWithBrowserTTS(text, accent, gender, natural);
      showNotice('Đang phát bằng giọng TRÌNH DUYỆT (tạm thời). Thiết lập BACKEND để có giọng tự nhiên hơn.', 'warn');
    }
  } catch (e){
    console.error(e);
    showNotice(e.message || String(e), 'error');
  }
}

async function onAnalyze(){
  clearNotice();
  const text = $('text-input').value.trim();
  if (!text) return;
  try {
    if (!BACKEND_BASE_URL){
      showNotice('Cần cấu hình BACKEND_BASE_URL để lấy IPA & thought groups bằng Gemini.', 'warn');
      return;
    }
    const { ipa, thought_groups } = await getIPAAndGroupsViaBackend(text);
    setText($('ipa'), ipa || '—');
    setText($('groups'), (thought_groups || []).join(' | ') || '—');
    showNotice('Đã lấy IPA & thought groups từ Gemini (deterministic).', 'ok');
  } catch(e){
    console.error(e);
    showNotice(e.message || String(e), 'error');
  }
}

// attach events
window.addEventListener('load', () => {
  $('btn-natural').addEventListener('click', () => onSpeak(true));
  $('btn-clear').addEventListener('click', () => onSpeak(false));
  $('btn-analyze').addEventListener('click', onAnalyze);

  if ('speechSynthesis' in window){
    window.speechSynthesis.onvoiceschanged = () => {};
    window.speechSynthesis.getVoices();
  }
});
