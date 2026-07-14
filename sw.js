// Helm minimal Service Worker
// - PWA install / share_target(POST) を有効にするために必要（ページのキャッシュはしない）
// - 常にネットワーク優先。古いビルドを配ってしまう事故を防ぐ。
// - POST /share : Android共有シートからの長文テキストを受け取り、Cacheに置いてアプリへリダイレクト
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname === "/share") {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const payload = JSON.stringify({
          title: fd.get("title") || "",
          text: fd.get("text") || "",
          url: fd.get("url") || "",
          at: Date.now(),
        });
        const cache = await caches.open("helm-share");
        await cache.put("/__share_payload__", new Response(payload, { headers: { "Content-Type": "application/json" } }));
      } catch (err) {}
      return Response.redirect("/?shared=1", 303);
    })());
    return;
  }
  /* それ以外はpassthrough（キャッシュしない） */
});
