export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const url = new URL(request.url);
    const corsBase = { 'Access-Control-Allow-Origin': '*' };

    // ═══════════════════════════════════════════════════════════
    // 📸 ROUTES R2 POUR LES PHOTOS
    // ═══════════════════════════════════════════════════════════
    
    // GET /photo/{id} - télécharger une photo
    if (url.pathname.startsWith('/photo/') && request.method === 'GET') {
      const photoId = url.pathname.replace('/photo/', '');
      try {
        const obj = await env.PHOTOS_BUCKET.get(photoId);
        if (!obj) return new Response('Not found', { status: 404, headers: corsBase });
        return new Response(obj.body, {
          headers: {
            ...corsBase,
            'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000',
          }
        });
      } catch (e) {
        return new Response('Error: ' + e.message, { status: 500, headers: corsBase });
      }
    }
    
    // PUT /photo/{id} - uploader une photo
    if (url.pathname.startsWith('/photo/') && request.method === 'PUT') {
      const photoId = url.pathname.replace('/photo/', '');
      try {
        await env.PHOTOS_BUCKET.put(photoId, request.body, {
          httpMetadata: { contentType: request.headers.get('Content-Type') || 'image/jpeg' }
        });
        return new Response(JSON.stringify({ ok: true, id: photoId }), {
          headers: { ...corsBase, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsBase, 'Content-Type': 'application/json' }
        });
      }
    }
    
    // DELETE /photo/{id} - supprimer une photo
    if (url.pathname.startsWith('/photo/') && request.method === 'DELETE') {
      const photoId = url.pathname.replace('/photo/', '');
      try {
        await env.PHOTOS_BUCKET.delete(photoId);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsBase, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { ...corsBase, 'Content-Type': 'application/json' }
        });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // ROUTES POST (KV + Anthropic)
    // ═══════════════════════════════════════════════════════════

    if (request.method !== 'POST') {
      return new Response('ResellTracker API OK', { status: 200, headers: corsBase });
    }

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    try {
      const body = await request.json();

      // 🔵 BACKUP : sauvegarde les données dans le cloud
      if (body._action === 'backup' && body._key && body._data) {
        await env.RESELL_KV.put('backup:' + body._key, JSON.stringify({
          data: body._data,
          date: new Date().toISOString()
        }));
        return new Response(JSON.stringify({ok: true, saved: true}), {status: 200, headers: cors});
      }

      // 🔵 RESTORE : récupère les données depuis le cloud
      if (body._action === 'restore' && body._key) {
        const raw = await env.RESELL_KV.get('backup:' + body._key);
        return new Response(JSON.stringify({
          ok: true,
          backup: raw ? JSON.parse(raw) : null
        }), {status: 200, headers: cors});
      }

      // 🔵 SYNC BLACKLIST (existant)
      if (body._action === 'sync_blacklist' && body._blacklist) {
        await env.RESELL_KV.put('blacklist:global', JSON.stringify(body._blacklist));
        return new Response(JSON.stringify({ok: true}), {status: 200, headers: cors});
      }

      // 🔵 GET BLACKLIST (pour loadSharedBlacklist)
      if (body._action === 'get_blacklist') {
        const raw = await env.RESELL_KV.get('blacklist:global');
        return new Response(JSON.stringify({
          ok: true,
          blacklist: raw ? JSON.parse(raw) : []
        }), {status: 200, headers: cors});
      }

      // 🔵 PROXY IA (par défaut → Claude)
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      return new Response(JSON.stringify(data), {status: 200, headers: cors});

    } catch(e) {
      return new Response(JSON.stringify({error: e.message}), {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
