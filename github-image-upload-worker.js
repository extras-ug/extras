const corsHeaders = (origin, env) => ({
  "Access-Control-Allow-Origin": env.SITE_ORIGIN || origin || "null",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Admin-Password",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
});

function json(data, status, origin, env) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin, env), "Content-Type": "application/json; charset=utf-8" } });
}
function encodeUtf8Base64(value) {
  const bytes = new TextEncoder().encode(value); let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function gh(env, path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${path}`, {
    ...options,
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GH_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 404) throw new Error(data.message || `GitHub API error (${response.status})`);
  return { response, data };
}
async function readManifest(env) {
  const { response, data } = await gh(env, "assets/product-images.json?ref=" + encodeURIComponent(env.GH_BRANCH || "main"));
  if (response.status === 404) return { images: {}, sha: null };
  const decoded = atob(String(data.content || "").replace(/\s/g, ""));
  const bytes = Uint8Array.from(decoded, c => c.charCodeAt(0));
  return { images: JSON.parse(new TextDecoder().decode(bytes)), sha: data.sha };
}
async function saveFile(env, path, contentBase64, message, sha = null) {
  const body = { message, content: contentBase64, branch: env.GH_BRANCH || "main" };
  if (sha) body.sha = sha;
  const { response, data } = await gh(env, path, { method: "PUT", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(data.message || "Could not commit file to GitHub.");
  return data;
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    if (env.SITE_ORIGIN && origin && origin !== env.SITE_ORIGIN) return json({ error: "Origin not allowed." }, 403, origin, env);
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/images") {
        const { images } = await readManifest(env);
        return json(images, 200, origin, env);
      }
      if (request.method === "POST" && url.pathname === "/auth") {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) return json({ error: "Incorrect admin password." }, 401, origin, env);
        return json({ ok: true }, 200, origin, env);
      }
      if (request.method === "POST" && url.pathname === "/upload") {
        if (!env.ADMIN_PASSWORD || request.headers.get("X-Admin-Password") !== env.ADMIN_PASSWORD) return json({ error: "Unauthorized." }, 401, origin, env);
        const body = await request.json();
        const productId = Number(body.productId);
        const mimeToExt = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
        const ext = mimeToExt[body.contentType];
        if (!Number.isInteger(productId) || productId < 1 || productId > 33) return json({ error: "Unknown product." }, 400, origin, env);
        if (!ext || typeof body.base64 !== "string") return json({ error: "Only JPEG, PNG and WebP images are accepted." }, 400, origin, env);
        if (body.base64.length > 7_000_000) return json({ error: "Image is too large. Maximum is 5 MB." }, 413, origin, env);
        const imagePath = `assets/products/${productId}.${ext}`;
        const branch = env.GH_BRANCH || "main";
        const existing = await gh(env, `${imagePath}?ref=${encodeURIComponent(branch)}`);
        await saveFile(env, imagePath, body.base64, `Update product ${productId} image`, existing.data.sha || null);
        const manifest = await readManifest(env);
        const rawUrl = `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${encodeURIComponent(branch)}/${imagePath}`;
        manifest.images[String(productId)] = `${rawUrl}?v=${Date.now()}`;
        await saveFile(env, "assets/product-images.json", encodeUtf8Base64(JSON.stringify(manifest.images, null, 2) + "\n"), `Update product image manifest (${productId})`, manifest.sha);
        return json({ ok: true, productId, imageUrl: manifest.images[String(productId)] }, 200, origin, env);
      }
      return json({ error: "Not found." }, 404, origin, env);
    } catch (error) {
      return json({ error: error.message || "Unexpected server error." }, 500, origin, env);
    }
  }
};
