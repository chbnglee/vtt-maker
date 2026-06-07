// ═══════════════════════════════════════════════════════════════════
//  VTT Maker — Cloudflare Worker
//
//  [Cloudflare 대시보드 Secrets 설정]
//  GEMINI_API_KEYS : 쉼표로 구분된 키 목록 (유료키를 앞에)
//                    예) AIza유료키1,AIza무료키1,AIza무료키2
//
//  [Cloudflare 대시보드 Bindings 설정]
//  USAGE_KV : KV 네임스페이스 연결
// ═══════════════════════════════════════════════════════════════════

const ACCOUNTS = {
  englishns1: 'dkdltmzmfla',
  englishns2: 'dkdltmzmfla',
  englishns3: 'dkdltmzmfla',
  englishns4: 'dkdltmzmfla',
};

// ── Gemini 설정 ──────────────────────────────────────────────────────
const GEMINI_MODEL   = 'gemini-1.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const FILE_API_URL   = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const INLINE_LIMIT   = 18 * 1024 * 1024; // 18 MB 초과 시 Files API

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

  const buffer   = await file.arrayBuffer();
  const mimeType = file.type || guessMime(file.name || '');

  // 서버 키 목록 (쉼표 구분, 유료키 우선)
  const serverKeys = (env.GEMINI_API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0);

  // 사용자가 직접 입력한 개인 키 (소진 시 팝업으로 받음)
  const userKey = (body.get('user_api_key') || '').trim();

  // 시도 순서: 서버 키들 → 개인 키
  const keysToTry = [...serverKeys, ...(userKey ? [userKey] : [])];

  if (keysToTry.length === 0) {
    return jsonRes({ error: 'no_keys', message: 'API 키가 설정되지 않았습니다.' }, 503);
  }

  const { words, exhausted, usedKey } = await transcribeWithFallback(buffer, mimeType, keysToTry);

  if (exhausted) {
    // 모든 키 소진 → 프론트에 팝업 요청 신호 전달
    return jsonRes({ error: 'keys_exhausted', message: '모든 API 키가 한도에 도달했습니다.' }, 429);
  }

  // 사용량 기록 (개인 키 사용 시도 포함)
  await recordUsage(username, file.name || 'unknown', usedKey === userKey ? 'user_key' : 'server_key', env);

  return jsonRes({ words });
}

// ── 키 순환 호출 ──────────────────────────────────────────────────────
async function transcribeWithFallback(buffer, mimeType, keys) {
  let lastErr = null;

  for (const key of keys) {
    try {
      const words = await transcribeWithGemini(buffer, mimeType, key);
      return { words, exhausted: false, usedKey: key };
    } catch (err) {
      if (isQuotaError(err)) {
        // 이 키는 한도 초과 → 다음 키 시도
        lastErr = err;
        console.warn(`Key quota exceeded, trying next key...`);
        continue;
      }
      // 쿼터 외 오류(잘못된 키, 네트워크 등)는 바로 throw
      throw err;
    }
  }

  // 모든 키 소진
  return { words: null, exhausted: true, usedKey: null };
}

// 쿼터/한도 초과 여부 판별
function isQuotaError(err) {
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('429') ||
    msg.includes('too many requests')
  );
}

// ── Gemini generateContent 호출 ───────────────────────────────────────
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
    const errBody = await res.json().catch(() => ({}));
    const msg = errBody.error?.message || `HTTP ${res.status}`;
    // 429는 쿼터 에러로 분류
    if (res.status === 429 || res.status === 503) throw new Error(`quota: ${msg}`);
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
async function recordUsage(username, filename, keyType, env) {
  if (!env.USAGE_KV) return;

  const key  = `usage:${username}`;
  const data = (await env.USAGE_KV.get(key, 'json')) || { count: 0, history: [] };

  data.count += 1;
  data.lastUsed = new Date().toISOString();
  data.history  = [
    { at: data.lastUsed, file: filename, key: keyType },
    ...(data.history || []),
  ].slice(0, 200);

  await env.USAGE_KV.put(key, JSON.stringify(data));
}

// ── 유틸 ─────────────────────────────────────────────────────────────
function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary  = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function guessMime(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map  = {
    mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', webm: 'video/webm', mp3: 'audio/mpeg',
    m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  };
  return map[ext] || 'video/mp4';
}
