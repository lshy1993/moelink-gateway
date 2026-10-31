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

反向代理 + 各 API 访问量统计 + 服务健康监控/告警。原 nginx 静态示例保留在 `nginx/`。

```bash
npm start            # 本地运行，默认 :8000
npm test
docker compose --profile moelink up moelink-gateway   # 在根 docker-compose 中
```

## 配置 `gateway.config.json`
- `services[]`：`name`、`prefix`（对外路径前缀，如 `/node-api/...` 转发到 `target`）、`healthPath`（默认 `/health`）、`healthType: "tcp"`（无 HTTP 健康接口时）、`tracked`（需单独统计的路由，如 `"GET /api/public/*"`；其余归入 `(other)`）。
- 无 `prefix` 的服务只做健康监控，不代理。
- `health`：`intervalMs` / `timeoutMs` / `failThreshold`（连续失败 N 次才判定 down，恢复时也会通知）。
- 环境变量：`PORT`、`STATS_FILE`、`GATEWAY_CONFIG`。
- 认证相关：
  - `JWT_SECRET`：与 Go 后端 / node-api 相同的 HS256 密钥，用于校验 MoeLink 统一用户系统的 JWT。
  - `GATEWAY_ADMIN_USER_IDS`：允许登录后台的管理员 `user_id` 白名单（逗号分隔）。配置后完全本地判断，node-api 挂了也能登录。
  - `NODE_API_URL`：未配置白名单时，用 `POST /user/info` 查询 `userInfo.group === 100`（管理员），结果缓存 60 秒。
  - `GATEWAY_ADMIN_TOKEN`：机器 token（Prometheus / 脚本），用 `Authorization: Bearer <token>` 访问 `/_gateway/*` 和 `/metrics`，不是网页登录密码。
  - `JWT_SECRET` 和 `GATEWAY_ADMIN_TOKEN` 都为空时 fail-closed：所有管理接口返回 401。

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
`notifiers` 支持 `log`、`webhook`、`telegram`、`discord`，密钥用 `"$ENV_NAME"` 引用环境变量，例如：
`{ "type": "telegram", "token": "$TG_TOKEN", "chatId": "$TG_CHAT_ID" }`。
新增渠道只需在 `src/notifiers/index.js` 加一个 factory。

注意：统计保存在内存并每 30 秒写入 `STATS_FILE`；`tracked` 外的路径不会按具体路径记录，避免基数膨胀。

## Dashboard 与 Release Guardian
- 直接访问网关根路径 `http://localhost:8000/` 会自动跳转到 `/_gateway/ui`：服务状态、近 24h 请求量、各 API 访问量表格、各服务部署版本。
- 登录：页面使用 MoeLink 统一账号（`POST /_gateway/login` 转发到 node-api `/user/login`），JWT 存于浏览器 `localStorage` 的 `gw_jwt`。只有管理员（`GATEWAY_ADMIN_USER_IDS` 白名单，或 node-api `userInfo.group === 100`）可以访问数据接口；普通登录用户返回 403，未登录返回 401。
- 版本检测：在服务的 `release` 配置 `repo`/`branch`，并选择部署版本来源：
  - `versionPath`（推荐生产环境）：服务暴露如 `/version` 返回 `{"commit":"<sha>","version":"1.2.3"}`（也识别 `sha`/`gitSha`/`hash`）。构建时可用 `GIT_SHA=$(git rev-parse HEAD)` 注入。
  - `gitPath`：直接读取挂载目录的 `.git` HEAD（本地开发 compose 已把 `./repos` 以只读挂到 `/repos`）。
- 通过 GitHub API 对比最新提交，显示 up-to-date / behind N commits；私有仓库或避免限流请设置 `GITHUB_TOKEN`（结果缓存 5 分钟）。
- `healthHost`：健康检查时覆盖 Host 头（Vite dev server 会拒绝容器名作为 Host，frontend 使用 `localhost`）。
