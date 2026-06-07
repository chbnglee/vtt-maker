// ═══════════════════════════════════════════════════════════════════
//  VTT Maker — Cloudflare Worker
//  배포 전 반드시 아래 ACCOUNTS 값을 본인 계정으로 변경하세요.
//  GEMINI_API_KEY 는 코드에 절대 입력하지 말고 Wrangler secret으로 설정하세요.
// ═══════════════════════════════════════════════════════════════════

const ACCOUNTS = {
  englishns1: 'dkdltmzmfla',
  englishns2: 'dkdltmzmfla',
  englishns3: 'dkdltmzmfla',
  englishns4: 'dkdltmzmfla',
};

// ── Gemini 설정 ──────────────────────────────────────────────────────
const GEMINI_MODEL  = 'gemini-1.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const FILE_API_URL   = 'https://generativelanguage.googleapis.com/upload/v1beta/files';

// 인라인 base64 전송 한계 (18 MB 초과 시 Files API 사용)
const INLINE_LIMIT = 18 * 1024 * 1024;

// ── CORS ─────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// ── Entry point ───────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST')   return jsonRes({ error: 'Method not allowed' }, 405);

    let body;
    try { body = await request.formData(); }
    catch { return jsonRes({ error: '요청 형식이 올바르지 않습니다.' }, 400); }

    const action   = body.get('action') || 'transcribe';
    const username = (body.get('username') || '').trim();
    const password = (body.get('password') || '').trim();

    // 인증
    if (!username || !ACCOUNTS[username] || ACCOUNTS[username] !== password) {
      return jsonRes({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
    }

    try {
      if (action === 'transcribe') return await handleTranscribe(body, username, env);
      if (action === 'usage')      return await handleUsage(username, env);
      return jsonRes({ error: '알 수 없는 action' }, 400);
    } catch (err) {
      console.error(err);
      return jsonRes({ error: err.message || '서버 오류가 발생했습니다.' }, 500);
    }
  },
};

// ── 트랜스크립션 ──────────────────────────────────────────────────────
async function handleTranscribe(body, username, env) {
  const file = body.get('file');
  if (!file) return jsonRes({ error: '파일이 없습니다.' }, 400);

  const apiKey   = env.GEMINI_API_KEY;
  if (!apiKey)   return jsonRes({ error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다.' }, 500);

  const buffer   = await file.arrayBuffer();
  const mimeType = file.type || guessMime(file.name || '');

  // Gemini 호출
  const words = await transcribeWithGemini(buffer, mimeType, apiKey);

  // 사용량 기록
  await recordUsage(username, file.name || 'unknown', env);

  return jsonRes({ words });
}

// ── Gemini 호출 ───────────────────────────────────────────────────────
async function transcribeWithGemini(buffer, mimeType, apiKey) {
  const prompt = [
    'Transcribe every spoken word in this audio/video file with precise timestamps.',
    'Return ONLY valid JSON — no markdown, no explanation.',
    'Format: {"words":[{"word":"hello","start":0.500,"end":0.800},...]}',
    'Include every word spoken. Timestamps are in seconds (float, 3 decimal places).',
  ].join('\n');

  const schema = {
    type: 'object',
    properties: {
      words: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            word:  { type: 'string' },
            start: { type: 'number' },
            end:   { type: 'number' },
          },
          required: ['word', 'start', 'end'],
        },
      },
    },
    required: ['words'],
  };

  // 파일 크기에 따라 인라인 vs Files API 분기
  let filePart;
  if (buffer.byteLength <= INLINE_LIMIT) {
    filePart = { inline_data: { mime_type: mimeType, data: bufToBase64(buffer) } };
  } else {
    const fileUri = await uploadToFilesAPI(buffer, mimeType, apiKey);
    filePart = { file_data: { mime_type: mimeType, file_uri: fileUri } };
  }

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [filePart, { text: prompt }] }],
      generationConfig: {
        response_mime_type: 'application/json',
        response_schema: schema,
        temperature: 0,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `Gemini API 오류 (HTTP ${res.status})`;
    throw new Error(msg);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini 응답을 파싱할 수 없습니다.');

  const parsed = JSON.parse(text);
  return parsed.words ?? [];
}

// ── Gemini Files API 업로드 (대용량) ─────────────────────────────────
async function uploadToFilesAPI(buffer, mimeType, apiKey) {
  // 1단계: resumable upload 세션 시작
  const initRes = await fetch(`${FILE_API_URL}?uploadType=resumable&key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': buffer.byteLength,
      'X-Goog-Upload-Header-Content-Type': mimeType,
    },
    body: JSON.stringify({ file: { display_name: 'audio' } }),
  });

  if (!initRes.ok) throw new Error('Files API 업로드 세션 시작 실패');
  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');

  // 2단계: 파일 전송
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': buffer.byteLength,
      'X-Goog-Upload-Offset': 0,
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
  });

  if (!uploadRes.ok) throw new Error('Files API 파일 업로드 실패');
  const fileData = await uploadRes.json();
  return fileData.file?.uri;
}

// ── 사용량 조회 ───────────────────────────────────────────────────────
async function handleUsage(username, env) {
  if (!env.USAGE_KV) return jsonRes({ error: 'KV 스토리지가 연결되지 않았습니다.' }, 500);

  const result = {};
  for (const user of Object.keys(ACCOUNTS)) {
    result[user] = (await env.USAGE_KV.get(`usage:${user}`, 'json')) || { count: 0, history: [] };
  }
  return jsonRes({ usage: result });
}

// ── 사용량 기록 ───────────────────────────────────────────────────────
async function recordUsage(username, filename, env) {
  if (!env.USAGE_KV) return;

  const key  = `usage:${username}`;
  const data = (await env.USAGE_KV.get(key, 'json')) || { count: 0, history: [] };

  data.count += 1;
  data.lastUsed = new Date().toISOString();
  data.history  = [
    { at: data.lastUsed, file: filename },
    ...(data.history || []),
  ].slice(0, 200); // 최근 200건 보관

  await env.USAGE_KV.put(key, JSON.stringify(data));
}

// ── 유틸 ─────────────────────────────────────────────────────────────
function bufToBase64(buffer) {
  const bytes  = new Uint8Array(buffer);
  const CHUNK  = 0x8000;
  let binary   = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function guessMime(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map  = { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
                 avi: 'video/x-msvideo', webm: 'video/webm', mp3: 'audio/mpeg',
                 m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg' };
  return map[ext] || 'video/mp4';
}
