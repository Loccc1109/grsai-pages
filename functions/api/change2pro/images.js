const CHANGE2PRO_BASE_URL = 'https://api.change2pro.com';

export async function onRequestPost(context) {
  const { request } = context;

  let formData;
  try {
    formData = await request.formData();
  } catch (error) {
    return jsonResponse({ success: false, error: 'failed to read form data' }, 400);
  }

  const apiKey = String(
    formData.get('api_key_change2pro_gpt') ||
    formData.get('apiKeyChange2PROGPT') ||
    formData.get('api_key_change2pro') ||
    formData.get('api_key') ||
    ''
  ).trim();
  const model = String(formData.get('model') || '').trim();
  const prompt = String(formData.get('prompt') || '').trim();
  const size = String(formData.get('size') || formData.get('image_size') || formData.get('imageSize') || '1024x1024').trim();
  const n = normalizeCount(formData.get('n'));
  const images = formData.getAll('image').filter(isUploadFile);

  if (!apiKey) return jsonResponse({ success: false, error: '缺少 Change2pro API Key' }, 400);
  if (model !== 'gpt-image-2-change2pro') return jsonResponse({ success: false, error: '不支持的 Change2pro 图像模型' }, 400);
  if (!prompt) return jsonResponse({ success: false, error: '缺少提示词' }, 400);

  try {
    const providerResponse = images.length
      ? await requestChange2proEdit({ apiKey, prompt, size, n, images })
      : await requestChange2proGeneration({ apiKey, prompt, size, n });
    const payload = await parseProviderPayload(providerResponse);

    if (!providerResponse.ok) {
      return jsonResponse({ success: false, error: extractErrorMessage(payload, providerResponse.status) }, 502);
    }

    const data = normalizeProviderData(payload);
    if (!data.length) return jsonResponse({ success: false, error: 'Change2pro returned an empty result' }, 502);
    return jsonResponse({ success: true, data }, 200);
  } catch (error) {
    return jsonResponse({ success: false, error: error?.message || 'Change2pro proxy unavailable' }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      ...noStoreHeaders(),
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function onRequest() {
  return jsonResponse({ success: false, error: 'method not allowed' }, 405);
}

async function requestChange2proGeneration({ apiKey, prompt, size, n }) {
  return fetch(`${CHANGE2PRO_BASE_URL}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt,
      size: size || '1024x1024',
      n,
    }),
  });
}

async function requestChange2proEdit({ apiKey, prompt, size, n, images }) {
  const providerForm = new FormData();
  providerForm.append('model', 'gpt-image-2');
  providerForm.append('prompt', prompt);
  providerForm.append('size', size || '1024x1024');
  providerForm.append('n', String(n));
  images.forEach(image => providerForm.append('image', image, image.name || 'image.png'));

  return fetch(`${CHANGE2PRO_BASE_URL}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: providerForm,
  });
}

function normalizeCount(value) {
  const count = Number.parseInt(String(value || '1'), 10);
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, count);
}

function isUploadFile(value) {
  return value && typeof value === 'object' && typeof value.arrayBuffer === 'function' && value.size > 0;
}

async function parseProviderPayload(response) {
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

function normalizeProviderData(payload) {
  if (Array.isArray(payload?.data)) return payload.data.map(normalizeProviderItem).filter(Boolean);
  if (Array.isArray(payload?.results)) return payload.results.map(normalizeProviderItem).filter(Boolean);
  const item = normalizeProviderItem(payload);
  return item ? [item] : [];
}

function normalizeProviderItem(item) {
  if (!item || typeof item !== 'object') return null;
  const b64 = item.b64_json || item.data || item.base64 || '';
  const url = item.url || '';
  const dataUrl = item.data_url || '';
  if (!b64 && !url && !dataUrl) return null;
  return {
    ...item,
    mimeType: item.mimeType || item.mime_type || 'image/jpeg',
    b64_json: b64 || undefined,
    data: item.data || b64 || undefined,
    base64: item.base64 || b64 || undefined,
    data_url: dataUrl || undefined,
    url: url || undefined,
  };
}

function extractErrorMessage(payload, status) {
  if (typeof payload === 'string' && payload.trim()) return payload;
  return payload?.error?.message || payload?.error || payload?.msg || `Change2pro request failed (${status})`;
}

function jsonResponse(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      ...corsHeaders(),
      ...noStoreHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function noStoreHeaders() {
  return {
    'Cache-Control': 'no-store',
  };
}
