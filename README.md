# Genshin Gateway - nginx Docker 示例

快速启动：

```bash
# 在项目根目录运行：
docker-compose up --build

# 或者指定后端地址：
VITE_API_URL=http://api:3000 docker-compose up --build
```

说明：

Google Cloud 部署（Cloud Run）:

- 使用 Cloud Build 自动化部署：

	将 `/cloudbuild.yaml` 提交到 Cloud Build：

	```bash
	# 手动触发构建并部署 (替换 REGION 和 VITE_API_URL)
	gcloud builds submit --config docker/nginx/cloudbuild.yaml --substitutions=REGION=us-central1,VITE_API_URL=https://api.example.com
	```

注意：
- 部署前请确保 `gcloud` 已登录并设置了正确的 `PROJECT_ID`，并为 Cloud Build 和 Cloud Run 授予必要权限。
- 上述脚本和配置将把镜像推送到 `gcr.io/$PROJECT_ID/genshin-gateway`，并在 Cloud Run 上创建 `genshin-gateway` 服务，监听 `8080` 端口。

本地 NAS 部署注意事项（后端容器已存在）：

- 如果你的后端容器已经运行在宿主机上并且你希望通过容器名互联，先创建一个用户自定义网络：

	```bash
	docker network create gateway_net
	```

- 启动或重新启动后端容器并加入该网络（假设容器名为 `genshin-backend` 且监听 8091）：

	```bash
	docker run -d --name genshin-backend --network gateway_net -e PORT=8091 your-backend-image:latest
	```

- 然后在本仓库根目录运行：

	```bash
	docker-compose up --build
	```

- 另一种替代：如果无法使用自定义网络，可以在 `docker-compose` 启动时通过环境变量直接指定后端可访问的地址：

	```bash
	VITE_API_URL=http://<backend-host-or-ip>:8091 docker-compose up --build
	```


---

# Gateway 服务（Node，零依赖）

反向代理 + 各 API 访问量统计 + 服务健康监控/告警，并提供静态 dashboard。原 nginx 静态示例保留在 `nginx/`。

```bash
npm start            # 本地运行，默认 :8000
npm test
```

在本项目根目录的 Compose 项目中，gateway 服务随其他服务一起启动（当前配置不使用 Compose profiles）：

```bash
docker compose up -d --build moelink-gateway
```

完整部署和 `.env` 配置请参阅根仓库的 [README](../../README.md)。根 Compose 将仓库目录只读挂载到 `/repos`，供 Release Guardian 读取 Git 状态。

## 配置 `gateway.config.json`
- `services[]`：`name`、`prefix`（对外路径前缀，如 `/node-api/...` 转发到 `target`；当前使用 `/auth`、`/stock`、`/node-api`、`/go-api`）、`upstreamPath`（可选，固定改写转发路径并保留 query，例如 OAuth 回调）、`monitor: false`（可选，跳过健康监控）、`healthPath`（默认 `/health`）、`healthType: "tcp"`（无 HTTP 健康接口时）、`tracked`（需单独统计的路由，如 `"GET /api/public/*"`；其余归入 `(other)`）、`repo`（可选，`owner/repo`，Dashboard 的服务名会链接到该 GitHub 仓库；未设置时回退到 `release.repo`）。
- `stripPrefix: false`（可选）：转发时保留原始完整路径，默认会去掉 `prefix`。例如 `/auth` → `auth-service` 需要保留 `/auth/check`，而 `/go-api` 则需要去掉前缀。
- `websocket: true`：把 HTTP Upgrade 请求（WebSocket）转发到该 `target`；可配合 `prefix` 限定路径，不写 `prefix` 表示接受所有 upgrade 请求。当前用于 `maj-server`。
- 无 `prefix` 的服务只做健康监控，不代理。
- `health`：`intervalMs` / `timeoutMs` / `failThreshold`（连续失败 N 次才判定 down，恢复时也会通知）。
- 环境变量：`PORT`、`STATS_FILE`、`GATEWAY_CONFIG`。
- 认证相关：
  - `AUTH_JWKS_URL`：auth-service 的公钥地址（如 `http://auth-service:8081/auth/.well-known/jwks.json`），用于本地校验 MoeLink 统一用户系统的 ES256 JWT；网关不持有任何签名密钥。
  - `GATEWAY_ADMIN_EMAILS`：break-glass 管理员邮箱白名单（逗号分隔）。常规管理员以 `users.user_role=1` 为准，可在网页后台修改；这里只用于 node-api 不可用时仍能进入后台。
  - `NODE_API_URL`：未配置白名单时，用 `POST /user/info` 查询 `userInfo.group === 100`（管理员），结果缓存 60 秒。
  - `GATEWAY_ADMIN_TOKEN`：机器 token（Prometheus / 脚本），用 `Authorization: Bearer <token>` 访问 `/_gateway/*` 和 `/metrics`，不是网页登录密码。
  - `AUTH_JWKS_URL` 和 `GATEWAY_ADMIN_TOKEN` 都为空时 fail-closed：所有管理接口返回 401。
  - 管理员判断：优先看 `GATEWAY_ADMIN_EMAILS`（break-glass），否则回退到 node-api 查询 `users.user_role=1`。

## 端点
- `/_gateway/health` 网关自身存活（公开）
- `/_gateway/ui` 登录页 / Dashboard（HTML 公开，数据受保护）
- `/_gateway/login` 登录（公开，转发到 node-api `/user/login`）
- `/_gateway/me` 当前登录用户（需管理员）
- `/_gateway/services` 各服务 up/down、延迟、最近错误（需管理员）
- `/_gateway/stats` 每路由访问量、状态码分布、平均/最大耗时、近 7 天按小时的请求量（需管理员）
- `/_gateway/releases` 各服务部署版本对比（需管理员）
- `/metrics` Prometheus 格式（需 `GATEWAY_ADMIN_TOKEN` 或管理员 JWT）

## BOT 通知
Guardian 的 `HealthMonitor` 本身就是一个后台定时器：每 `health.intervalMs`（默认 15 秒）检查一次服务，连续 `health.failThreshold` 次失败后标记 DOWN，并发送一次通知；恢复时再发送一次 RECOVERED。它运行在 gateway 的 Node 进程内，不需要额外守护进程。

通知统一由 `NotificationManager` 管理，适配器实现 `sendAlert(alert)`，同时提供 `send_alert(title, text)` 别名。内置适配器：

- `log`：输出到 gateway 日志
- `webhook`：通用 JSON Webhook
- `qq` / `napcat`：NapCat OneBot HTTP API，支持 `send_private_msg` / `send_group_msg`
- `telegram`：Telegram Bot `sendMessage`
- `discord`：Discord Webhook

配置支持数组或对象两种形式，值可以用 `"$ENV_NAME"` 引用环境变量：

```json
"notifiers": [
  { "type": "log" },
  {
    "type": "qq",
    "enabled": "$QQ_NOTIFIER_ENABLED",
    "url": "http://192.168.40.61:3020/send_private_msg",
    "user_id": "$QQ_NOTIFIER_USER_ID",
    "group_ids": "$QQ_NOTIFIER_GROUP_IDS",
    "token": "$QQ_NOTIFIER_TOKEN",
    "message_format": "array"
  },
  { "type": "telegram", "enabled": "$TELEGRAM_NOTIFIER_ENABLED", "bot_token": "$TELEGRAM_BOT_TOKEN", "chat_id": "$TELEGRAM_CHAT_ID" },
  { "type": "discord", "enabled": "$DISCORD_NOTIFIER_ENABLED", "webhook_url": "$DISCORD_WEBHOOK_URL" }
]
```

也可以写成：

```json
"notifiers": {
  "telegram": { "enabled": true, "bot_token": "$TELEGRAM_BOT_TOKEN", "chat_id": "$TELEGRAM_CHAT_ID" }
}
```

`enabled` 留空或为 `false` 时跳过该渠道。QQ 适配器默认使用 `message_format: "array"`，即 `[{"type":"text","data":{"text":"..."}}]`；同时支持 `"string"`。`group_ids` 支持逗号分隔或数组；同时配置 `user_id` 和 `group_ids` 时会分别发送私聊和每个群。NapCat 容器内部监听 `3000`，本机映射到宿主 `3020`，所以 gateway 应使用 `192.168.40.61:3020`，不能写 `127.0.0.1:3000`（那是 GenshinQuiz 前端）。

`genshinquiz-frontend` 是静态编译产物，配置中已设置 `monitor: false`，不会参与 DOWN/RECOVERED 通知，但仍会出现在 Release 版本对比里。

注意：统计保存在内存并每 30 秒写入 `STATS_FILE`；`tracked` 外的路径不会按具体路径记录，避免基数膨胀。

## Dashboard 与 Release Guardian
- 直接访问网关根路径 `http://localhost:8000/` 会自动跳转到 `/_gateway/ui`：服务状态、近 24h 请求量、各 API 访问量表格、各服务部署版本。
- 登录：不再提供 Google / GitHub 登录入口。已登录 MoeLink 时，Dashboard 会用共享的 HttpOnly 会话 Cookie 调用 `/auth/session/refresh` 自动进入；也可以使用管理员邮箱 + 密码作为备用。密码表单直接请求 auth-service，并转发 Set-Cookie。access token 存在浏览器 `localStorage` 的 `gw_jwt`，过期或刷新页面时会重新用会话 Cookie 续期。管理员以 `users.user_role=1` 为准，可在网页后台修改；`GATEWAY_ADMIN_EMAILS` 是 node-api 不可用时的 break-glass。已登录但非管理员会跳转到 `/_gateway/denied`，5 秒后自动返回 MoeLink。
- 版本检测：在服务的 `release` 配置 `repo`/`branch`，并选择部署版本来源：
  - `versionPath`（推荐生产环境）：服务暴露如 `/version` 返回 `{"commit":"<sha>","version":"1.2.3"}`（也识别 `sha`/`gitSha`/`hash`）。构建时可用 `GIT_SHA=$(git rev-parse HEAD)` 注入。
  - `gitPath`：直接读取挂载目录的 `.git` HEAD（本地开发 compose 已把 `./repos` 以只读挂到 `/repos`）。
- 通过 GitHub API 对比最新提交，显示 up-to-date / behind N commits；私有仓库或避免限流请设置 `GITHUB_TOKEN`（结果缓存 5 分钟）。
- `healthHost`：健康检查时覆盖 Host 头（Vite dev server 会拒绝容器名作为 Host，frontend 使用 `localhost`）。
