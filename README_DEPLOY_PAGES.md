# GRSAI Cloudflare Pages 静态发布包

这个目录是主页面的纯静态发布包，可直接上传到 Cloudflare Pages。

## 本地预览

```powershell
cd D:\project\grsai-dev-2\dist_pages
python -m http.server 8080
```

打开：

```text
http://localhost:8080
```

或：

```text
http://localhost:8080/multiwindow
```

## Cloudflare Pages 上传

1. 打开 Cloudflare Dashboard。
2. 进入 `Workers & Pages`。
3. 选择 `Create application`。
4. 选择 `Pages`。
5. 选择 `Upload assets`。
6. 上传整个 `dist_pages` 目录内容。

## 注意

- 静态包不依赖 Flask 的 `/api/upload`、`/api/generate`、`/api/task`、`/api/file`、`/outputs`、`/uploads`。
- 参考图和生成图仍保存在用户浏览器 IndexedDB。
- 生成请求仍由浏览器直连模型 API。
- 当前静态包通过 Cloudflare Pages Function 代理 `/api/admin/generation-log` 审计上报。
- API Key 仍只保存在用户浏览器本地配置中。

## Pages Function 审计代理配置

在 Cloudflare Pages 项目中配置环境变量：

```text
GRSAI_AUDIT_FORWARD_URL=https://你的5005公网域名/api/admin/generation-log
```

如果本地 `web_app.py` / `admin_app.py` 设置了 `GRSAI_ADMIN_INGEST_TOKEN`，Pages 中也配置同名变量：

```text
GRSAI_ADMIN_INGEST_TOKEN=同一个token
```

注意：Function 不能转发到 `127.0.0.1:5015`，必须转发到公网可访问的 5005 隧道地址。5005 服务会再从本机转发到 5015 管理后台 ingest。

## 文件结构

```text
dist_pages/
  index.html
  multiwindow/index.html
  _redirects
  static/
    local_gallery.js
    smooth_window_motion.js
    generation_gallery_sidebar.js
    static_pages_bootstrap.js
  functions/api/admin/generation-log.js
```
