export async function onRequestPost(context) {
  const { request, env } = context;
  const forwardUrl = env.GRSAI_AUDIT_FORWARD_URL;

  if (!forwardUrl) {
    return Response.json(
      { success: false, error: 'GRSAI_AUDIT_FORWARD_URL is not configured' },
      { status: 202, headers: noStoreHeaders() }
    );
  }

  let bodyText = '';
  try {
    bodyText = await request.text();
  } catch (error) {
    return Response.json(
      { success: false, error: 'failed to read request body' },
      { status: 400, headers: noStoreHeaders() }
    );
  }

  if (!bodyText) {
    return Response.json(
      { success: false, error: 'empty body' },
      { status: 400, headers: noStoreHeaders() }
    );
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': request.headers.get('User-Agent') || '',
    'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || '',
  };

  if (env.GRSAI_ADMIN_INGEST_TOKEN) {
    headers['X-GRSAI-Admin-Token'] = env.GRSAI_ADMIN_INGEST_TOKEN;
  }

  try {
    const response = await fetch(forwardUrl, {
      method: 'POST',
      headers,
      body: bodyText,
    });
    const text = await response.text();
    return new Response(text || JSON.stringify({ success: response.ok }), {
      status: response.status,
      headers: {
        ...corsHeaders(),
        ...noStoreHeaders(),
        'Content-Type': response.headers.get('Content-Type') || 'application/json',
      },
    });
  } catch (error) {
    return Response.json(
      { success: false, error: 'audit forward unavailable' },
      { status: 202, headers: { ...corsHeaders(), ...noStoreHeaders() } }
    );
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
  return Response.json(
    { success: false, error: 'method not allowed' },
    { status: 405, headers: { ...corsHeaders(), ...noStoreHeaders() } }
  );
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
